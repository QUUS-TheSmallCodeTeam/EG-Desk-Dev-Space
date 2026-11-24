// EG-Desk decision model client: OpenAI Decisions API (POST /v1/decisions).
//
// The decision model answers typed questions about evidence EG-Desk already
// holds: predicate (probability that a statement is true), choice (one of the
// supplied options) or score (position on ordered levels). It never writes
// text, URLs or tool arguments. Callers turn answers into actions with their
// own guards; a probability is never an execution permission.
//
// Security: the API key is read through getApiKey() for each request and is
// only placed in the Authorization header. It is never logged, returned, or
// copied into an error message (upstream error text is dropped because it can
// echo a masked key).
//
// The client never retries. Each error carries `retryable` so a caller can
// decide: read-only judgements may retry once; an action choice must observe
// again and ask a fresh question instead.

import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'

// Private, domain-separated recipient identity. Never a renderer DTO, cache key or request field.
// Bind the grant to the actual key revision, endpoint and model, not a displayed key suffix.
export function decisionTopicRecipient(key, savedAt, endpoint = DECISIONS_ENDPOINT, model = DECISION_MODEL) {
  if (typeof key !== 'string' || !key.trim() || !Number.isSafeInteger(savedAt) || savedAt < 0) return null
  return createHmac('sha256', key).update(JSON.stringify(['egdesk:topic-history:v1', endpoint, model, savedAt])).digest('hex')
}

export const DECISIONS_ENDPOINT = 'https://api.openai.com/v1/decisions'
export const DECISION_MODEL = 'gpt-6-luna'
// Published request limits (create decision reference, 2026-11).
export const DECISION_LIMITS = Object.freeze({
  questions: 400, choicesMin: 2, choicesMax: 255, levelsMin: 2, levelsMax: 10,
  promptCacheKey: 64, safetyIdentifier: 128,
})
// EG-Desk's own bounds on top of the published ones.
const NAME_MAX = 120
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024
export const DEFAULT_DECISION_TIMEOUT_MS = 1500
export const DECISION_ERROR_CODES = Object.freeze(['not_configured', 'invalid_request', 'invalid_key', 'no_credit',
  'rate_limited', 'model_unavailable', 'server_error', 'bad_response', 'timeout', 'aborted', 'unreachable', 'budget_exceeded', 'evidence_unavailable'])
// 429 bodies that mean the organization has no usable balance, not a rate limit.
// credit_balance_exhausted: ChatGPT subscription API credits used up.
// insufficient_quota: the long-standing OpenAI code for an exhausted quota.
const NO_CREDIT_CODES = new Set(['credit_balance_exhausted', 'insufficient_quota'])
const QUESTION_TYPES = new Set(['predicate', 'choice', 'score'])

export class DecisionError extends Error {
  constructor(code, message, { status = null, retryable = false, apiCode = null } = {}) {
    super(message)
    this.name = 'DecisionError'
    this.code = DECISION_ERROR_CODES.includes(code) ? code : 'bad_response'
    this.status = status
    this.retryable = retryable === true
    this.apiCode = typeof apiCode === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(apiCode) ? apiCode : null
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmptyText = value => typeof value === 'string' && value.trim().length > 0
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
// Choice values are typed: the string 'true' and the boolean true are different options.
const choiceKey = value => `${typeof value}:${String(value)}`

/**
 * classifyDecisionFailure(status, body) → { code, retryable, apiCode }
 * Maps an HTTP failure to an EG-Desk decision error code.
 */
export function classifyDecisionFailure(status, body) {
  const apiCode = record(body?.error) ? (body.error.code ?? body.error.type ?? null) : null
  if (status === 401) return { code: 'invalid_key', retryable: false, apiCode }
  if (status === 429) {
    return NO_CREDIT_CODES.has(apiCode) ? { code: 'no_credit', retryable: false, apiCode } : { code: 'rate_limited', retryable: true, apiCode }
  }
  if (status === 403 || status === 404) return { code: 'model_unavailable', retryable: false, apiCode }
  if (status >= 500) return { code: 'server_error', retryable: true, apiCode }
  return { code: 'invalid_request', retryable: false, apiCode }
}

function instructionsValid(value) {
  return nonEmptyText(value) || (Array.isArray(value) && value.length > 0 && value.every(record))
}

/**
 * validateDecisionRequest({ input, questions, promptCacheKey?, safetyIdentifier? })
 * Throws DecisionError('invalid_request') before any network call when the
 * request breaks a published limit or EG-Desk's naming rule (every question
 * needs a unique name so answers can be matched by name).
 */
export function validateDecisionRequest({ input, questions, promptCacheKey = null, safetyIdentifier = null } = {}) {
  const fail = message => { throw new DecisionError('invalid_request', message) }
  if (!(typeof input === 'string' || (Array.isArray(input) && input.length > 0))) fail('input must be a string or a nonempty array')
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > DECISION_LIMITS.questions) {
    fail(`questions must hold 1 to ${DECISION_LIMITS.questions} items`)
  }
  const names = new Set()
  for (const question of questions) {
    if (!record(question) || !QUESTION_TYPES.has(question.type)) fail('each question needs type predicate, choice or score')
    if (!nonEmptyText(question.name) || question.name.length > NAME_MAX) fail(`each question needs a name of 1 to ${NAME_MAX} characters`)
    if (names.has(question.name)) fail(`duplicate question name: ${question.name}`)
    names.add(question.name)
    if (!instructionsValid(question.instructions)) fail(`question ${question.name} needs instructions`)
    if (question.type === 'choice') {
      const choices = question.choices
      if (!Array.isArray(choices) || choices.length < DECISION_LIMITS.choicesMin || choices.length > DECISION_LIMITS.choicesMax) {
        fail(`question ${question.name} needs ${DECISION_LIMITS.choicesMin} to ${DECISION_LIMITS.choicesMax} choices`)
      }
      const seen = new Set()
      for (const choice of choices) {
        if (!record(choice) || !(typeof choice.value === 'boolean' || nonEmptyText(choice.value))) fail(`question ${question.name} has an invalid choice value`)
        const key = choiceKey(choice.value)
        if (seen.has(key)) fail(`question ${question.name} repeats choice ${String(choice.value)}`)
        seen.add(key)
      }
    }
    if (question.type === 'score') {
      const levels = question.levels
      if (!Array.isArray(levels) || levels.length < DECISION_LIMITS.levelsMin || levels.length > DECISION_LIMITS.levelsMax ||
          !levels.every(level => record(level) && nonEmptyText(level.label))) {
        fail(`question ${question.name} needs ${DECISION_LIMITS.levelsMin} to ${DECISION_LIMITS.levelsMax} labeled levels`)
      }
    }
  }
  if (promptCacheKey !== null && (typeof promptCacheKey !== 'string' || promptCacheKey.length > DECISION_LIMITS.promptCacheKey)) {
    fail(`promptCacheKey must be at most ${DECISION_LIMITS.promptCacheKey} characters`)
  }
  if (safetyIdentifier !== null && (typeof safetyIdentifier !== 'string' || safetyIdentifier.length > DECISION_LIMITS.safetyIdentifier)) {
    fail(`safetyIdentifier must be at most ${DECISION_LIMITS.safetyIdentifier} characters`)
  }
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizeUsage(usage) {
  const details = record(usage?.input_tokens_details) ? usage.input_tokens_details : {}
  return Object.freeze({
    inputTokens: count(usage?.input_tokens), cachedTokens: count(details.cached_tokens),
    cacheWriteTokens: count(details.cache_write_tokens), outputTokens: count(usage?.output_tokens),
    totalTokens: count(usage?.total_tokens),
  })
}

function distribution(rows, valueKey) {
  if (!Array.isArray(rows)) return []
  return rows.filter(row => record(row) && probability(row.probability))
    .map(row => Object.freeze({ value: row[valueKey], probability: row.probability, ...(typeof row.label === 'string' ? { label: row.label } : {}) }))
    .sort((a, b) => b.probability - a.probability)
}

function normalizeAnswer(question, answer) {
  if (!record(answer)) return Object.freeze({ type: 'missing' })
  if (answer.type === 'refusal') return Object.freeze({ type: 'refusal' })
  if (answer.type !== question.type) return Object.freeze({ type: 'invalid', reason: 'type-mismatch' })
  if (question.type === 'predicate') {
    return probability(answer.probability) ? Object.freeze({ type: 'predicate', probability: answer.probability })
      : Object.freeze({ type: 'invalid', reason: 'probability' })
  }
  if (question.type === 'choice') {
    const allowed = new Set(question.choices.map(choice => choiceKey(choice.value)))
    if (!allowed.has(choiceKey(answer.choice)) || !probability(answer.confidence)) return Object.freeze({ type: 'invalid', reason: 'choice' })
    const ranked = distribution(answer.probabilities, 'value').filter(row => allowed.has(choiceKey(row.value)))
    return Object.freeze({ type: 'choice', choice: answer.choice, confidence: answer.confidence, probabilities: Object.freeze(ranked) })
  }
  const levels = question.levels.length
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels - 1 ||
      !probability(answer.confidence)) {
    return Object.freeze({ type: 'invalid', reason: 'score' })
  }
  return Object.freeze({ type: 'score', score: answer.score, confidence: answer.confidence,
    probabilities: Object.freeze(distribution(answer.probabilities, 'value')) })
}

/**
 * normalizeDecisionResponse(body, questions) → { answers, model, usage }
 * answers: frozen object keyed by question name. Each value is one of
 *   { type: 'predicate', probability } | { type: 'choice', choice, confidence, probabilities }
 *   | { type: 'score', score, confidence, probabilities } | { type: 'refusal' }
 *   | { type: 'missing' } | { type: 'invalid', reason }
 * A refusal, missing or invalid answer means "unknown"; callers must never
 * read it as "no".
 */
export function normalizeDecisionResponse(body, questions) {
  if (!record(body) || !Array.isArray(body.answers)) throw new DecisionError('bad_response', 'Decision response has no answers array')
  const byName = new Map()
  body.answers.forEach((answer, index) => {
    const name = record(answer) && typeof answer.name === 'string' ? answer.name : questions[index]?.name
    if (typeof name === 'string' && !byName.has(name)) byName.set(name, answer)
  })
  const answers = Object.create(null)
  for (const question of questions) answers[question.name] = normalizeAnswer(question, byName.get(question.name))
  return { answers: Object.freeze(answers), model: typeof body.model === 'string' ? body.model : null, usage: normalizeUsage(body.usage) }
}

// A reviewed single recommendation must not be reconstructed by the tolerant
// positional/row filtering used by other multi-question readers. Accept partial
// distributions here; the caller must still account for unseen probability mass.
function validSingleChoiceResponse(body, q) {
  if (!Array.isArray(body?.answers) || body.answers.length !== 1) return false
  const a = body.answers[0]
  if (!record(a) || a.name !== q.name) return false
  if (a.type === 'refusal') return true
  if (a.type !== 'choice' || !probability(a.confidence) || !Array.isArray(a.probabilities) ||
      !a.probabilities.length || a.probabilities.length > q.choices.length) return false
  const allowed = new Set(q.choices.map(c => choiceKey(c.value))), seen = new Set()
  for (const row of a.probabilities) {
    if (!record(row) || !probability(row.probability)) return false
    const key = choiceKey(row.value)
    if (!allowed.has(key) || seen.has(key)) return false
    seen.add(key)
  }
  return seen.has(choiceKey(a.choice))
}

function oversizedResponse() {
  return new DecisionError('bad_response', 'Decision response is too large')
}

async function readBody(response, signal) {
  let text
  const body = response.body
  if (typeof body?.getReader !== 'function') {
    // Legacy text-only adapters have already materialized the string before
    // we can check it. This still bounds parsing by its actual UTF-8 size.
    text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > RESPONSE_MAX_BYTES) throw oversizedResponse()
  } else {
    // Count the bytes actually delivered by fetch (after content decoding),
    // not Content-Length, which may describe another size or be absent.
    const reader = body.getReader()
    let cancelled = false
    let complete = false
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      // Don't let blocked cleanup or a cancel rejection mask the outcome.
      try { void reader.cancel().catch(() => {}) } catch {}
    }
    let bytes = new Uint8Array(0)
    let size = 0
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      for (;;) {
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) { complete = true; break }
        const nextSize = size + value.byteLength
        if (nextSize > RESPONSE_MAX_BYTES) throw oversizedResponse()
        if (nextSize > bytes.length) {
          // Bounded contiguous storage avoids retaining a list of tiny chunks.
          const next = new Uint8Array(Math.min(RESPONSE_MAX_BYTES, Math.max(8192, bytes.length * 2, nextSize)))
          next.set(bytes.subarray(0, size))
          bytes = next
        }
        bytes.set(value, size)
        size = nextSize
      }
    } finally {
      signal.removeEventListener('abort', cancel)
      if (!complete) cancel()
      reader.releaseLock()
    }
    // Treat bad encoding like malformed JSON: never accept replacement
    // characters as provider data, but preserve a non-2xx HTTP classification.
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)) }
    catch { return null }
  }
  try { return JSON.parse(text) } catch { return null }
}

/**
 * createDecisionClient({ getApiKey, fetchImpl?, endpoint?, model?, timeoutMs?, clock?, budget? })
 *   getApiKey: () => string | null | Promise<string | null>
 *   budget: optional createDecisionBudget() result; a request is refused with
 *     budget_exceeded when the monthly input-token cap is reached.
 * client.decide({ input, questions, promptCacheKey?, safetyIdentifier?, timeoutMs?, signal?, beforeDispatch? })
 *   → { answers, model, usage, latencyMs }   throws DecisionError
 * client.verifyKey(apiKey, { timeoutMs?, signal? }) → { status: 'verified' | 'not_verified' | DecisionError code, retryable }
 */
export function createDecisionClient({ getApiKey, fetchImpl = globalThis.fetch, endpoint = DECISIONS_ENDPOINT, model = DECISION_MODEL,
  timeoutMs = DEFAULT_DECISION_TIMEOUT_MS, clock = () => performance.now(), budget = null, recipientForKey = null } = {}) {
  if (typeof getApiKey !== 'function') throw new TypeError('getApiKey must be a function')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')

  async function post(apiKey, { input, questions, promptCacheKey = null, safetyIdentifier = null }, { timeoutMs: limit = timeoutMs, signal, authorizeDispatch, strictChoiceResponse = false } = {}) {
    validateDecisionRequest({ input, questions, promptCacheKey, safetyIdentifier })
    if (strictChoiceResponse === true && (questions.length !== 1 || questions[0].type !== 'choice')) {
      throw new DecisionError('invalid_request', 'A reviewed selection needs exactly one choice question')
    }
    if (budget && !budget.canSpend()) throw new DecisionError('budget_exceeded', 'The local decision budget for this month is used up')
    const body = { model, input, questions, ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {}) }
    // Cancelled before sending: no request leaves the machine.
    if (signal?.aborted) throw new DecisionError('aborted', 'The decision request was cancelled')
    const historyRequest = questions.some(q => q.name === 'topic_route' || /^topic_need_/.test(q.name)) ||
      (Array.isArray(input) && input.some(m => Array.isArray(m?.content) && m.content.some(p => p?.type === 'input_json' && p.data?.kind === 'session_topic_graph')))
    const wire = JSON.stringify(body)
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1, limit))
    const onAbort = () => controller.abort()
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const started = clock()
    let response, parsed
    let denied = false
    try {
      // getApiKey() may have yielded. Use the actual credential selected for THIS
      // POST; finish serialization and all preparation before the last synchronous check.
      if (historyRequest || authorizeDispatch !== undefined) {
        let allowed = false
        try {
          const fp = recipientForKey?.(apiKey, endpoint, model)
          if (fp && typeof fp.then === 'function') Promise.resolve(fp).catch(() => {})
          if (typeof fp === 'string' && /^[a-f0-9]{64}$/.test(fp) && typeof authorizeDispatch === 'function') {
            const decision = authorizeDispatch(fp)
            if (decision && typeof decision.then === 'function') Promise.resolve(decision).catch(() => {})
            allowed = decision === true
          }
        } catch { /* Unreadable/async authority is never permission to send. */ }
        if (!allowed) { denied = true; throw new Error('denied') }
      }
      if (signal?.aborted) throw new Error('cancelled')
      response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: wire })
      // A server can send headers promptly and then stall the body. Keep the
      // timeout and the caller's cancellation wired until the response is read.
      try { parsed = await readBody(response, controller.signal) }
      catch (error) { throw error instanceof DecisionError ? error : new DecisionError('bad_response', 'The decision response could not be read') }
    } catch (error) {
      if (denied) throw new DecisionError('evidence_unavailable', 'The scoped history transfer is no longer authorized')
      if (timedOut) throw new DecisionError('timeout', 'The decision model did not answer in time', { retryable: true })
      if (signal?.aborted) throw new DecisionError('aborted', 'The decision request was cancelled')
      if (error instanceof DecisionError) throw error
      throw new DecisionError('unreachable', 'The decision model could not be reached', { retryable: true })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    }
    if (!response.ok) {
      const failure = classifyDecisionFailure(response.status, parsed)
      throw new DecisionError(failure.code, `Decision request failed (${failure.code})`, { status: response.status, retryable: failure.retryable, apiCode: failure.apiCode })
    }
    if (strictChoiceResponse === true && !validSingleChoiceResponse(parsed, questions[0])) {
      // The paid HTTP exchange already happened, even when its selection is unusable.
      budget?.record(normalizeUsage(parsed?.usage))
      throw new DecisionError('bad_response', 'Decision response did not match the reviewed choices')
    }
    const normalized = normalizeDecisionResponse(parsed, questions)
    budget?.record(normalized.usage)
    return { ...normalized, latencyMs: Math.max(0, clock() - started) }
  }

  return Object.freeze({
    model,
    async decide(request = {}) {
      const apiKey = await getApiKey()
      if (!nonEmptyText(apiKey)) throw new DecisionError('not_configured', 'No decision model API key is saved')
      // Choose at most a narrower request after the key lookup, before serialization.
      // The policy callback is synchronous and never receives the credential.
      const dispatch = request.beforeDispatch ? request.beforeDispatch() : request
      if (!dispatch) throw new DecisionError('aborted', 'The decision request was cancelled before dispatch')
      return post(apiKey, dispatch, request)
    },
    async verifyKey(apiKey, options = {}) {
      if (!nonEmptyText(apiKey)) return { status: 'invalid_key', retryable: false }
      try {
        const { answers } = await post(apiKey, { input: 'EG-Desk key check',
          questions: [{ type: 'predicate', name: 'key_check', instructions: 'Is the input a key check message?' }] },
        { timeoutMs: options.timeoutMs ?? 5000, signal: options.signal })
        const check = answers.key_check
        // Only normalized predicates have a finite probability in [0, 1].
        if (check?.type !== 'predicate') return { status: 'bad_response', retryable: false }
        // This asks about the fixed probe message, not whether the key is valid.
        // A tie or negative answer fails the probe without implying an HTTP 401.
        return { status: check.probability > 0.5 ? 'verified' : 'not_verified', retryable: false }
      } catch (error) {
        if (error instanceof DecisionError) return { status: error.code, retryable: error.retryable }
        return { status: 'unreachable', retryable: true }
      }
    },
  })
}

/**
 * createDecisionBudget({ monthlyInputTokenCap?, now?, initial? }) → budget
 * A local guard on top of the provider's own limits: EG-Desk cannot read the
 * organization's credit balance without an admin key, so it counts the input
 * tokens it spent. A cap of null means no local cap.
 * budget.canSpend() / budget.record(usage) / budget.snapshot() → { month, inputTokens, cap }
 * budget.setCap(positiveInteger | null): the owner's choice; null removes the cap.
 * onChange(state) runs after every change of the tally or cap so a store can keep
 * it across restarts (egdesk-decision-budget-store.mjs); its failure never reaches a caller.
 */
export function createDecisionBudget({ monthlyInputTokenCap = null, now = Date.now, initial = null, onChange = null } = {}) {
  if (monthlyInputTokenCap !== null && !(Number.isSafeInteger(monthlyInputTokenCap) && monthlyInputTokenCap > 0)) {
    throw new TypeError('monthlyInputTokenCap must be a positive integer or null')
  }
  const monthOf = time => { const date = new Date(time); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}` }
  let month = record(initial) && typeof initial.month === 'string' ? initial.month : monthOf(now())
  let inputTokens = record(initial) ? count(initial.inputTokens) : 0
  const changed = () => { if (typeof onChange === 'function') { try { onChange({ month, inputTokens, cap: monthlyInputTokenCap }) } catch {} } }
  const roll = () => { const current = monthOf(now()); if (current !== month) { month = current; inputTokens = 0; return true } return false }
  return Object.freeze({
    canSpend() { roll(); return monthlyInputTokenCap === null || inputTokens < monthlyInputTokenCap },
    record(usage) { const rolled = roll(); const spent = count(usage?.inputTokens); inputTokens += spent; if (rolled || spent > 0) changed() },
    snapshot() { roll(); return Object.freeze({ month, inputTokens, cap: monthlyInputTokenCap }) },
    setCap(cap) {
      if (cap !== null && !(Number.isSafeInteger(cap) && cap > 0)) throw new TypeError('cap must be a positive integer or null')
      roll(); monthlyInputTokenCap = cap; changed()
    },
  })
}
