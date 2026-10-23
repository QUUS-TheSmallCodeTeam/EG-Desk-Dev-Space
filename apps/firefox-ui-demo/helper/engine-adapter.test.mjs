import test from 'node:test'
import assert from 'node:assert/strict'
import { ENGINE_CAPABILITIES, ENGINE_ERRORS, ENGINE_IDS, ENGINE_STATUSES, classifyClaudeError, engineError, validateEngineAdapter } from './engine-adapter.mjs'
import { ERROR_KINDS, publicError } from './codex-chat-values.mjs'

const RETRY_AT = 1_800_000_000_000

function fakeAdapter(overrides = {}) {
  return {
    id: 'claude', describe: () => ({}), refresh: async () => ({}), capabilities: () => new Set(['stream']), ownerKey: () => null, isReady: () => false,
    startThread: () => {}, resumeThread: () => {}, releaseThread: () => {}, startTurn: () => {}, interruptTurn: () => {},
    respond: () => true, subscribe: () => () => {}, dispose: async () => {},
    ...overrides,
  }
}

test('engine errors carry the documented HTTP status and an existing error kind that publicError reproduces', () => {
  assert.deepEqual(Object.keys(ENGINE_ERRORS).sort(), ['ENGINE_BUSY', 'ENGINE_DECISION_PENDING', 'ENGINE_LOGIN_REQUIRED', 'ENGINE_MISMATCH', 'ENGINE_NOT_INSTALLED', 'ENGINE_PROFILE_MISMATCH', 'ENGINE_UNAVAILABLE', 'ENGINE_VERSION_UNSUPPORTED'])
  for (const [code, expected] of Object.entries(ENGINE_ERRORS)) {
    const error = engineError(code)
    assert.equal(error.code, code)
    assert.equal(error.httpStatus, expected.httpStatus)
    assert.ok(ERROR_KINDS.includes(expected.kind))
    assert.equal(publicError(error, code).kind, expected.kind, `${code} kind`)
  }
  assert.equal(engineError('ENGINE_UNAVAILABLE', 'Claude is not connected yet').message, 'Claude is not connected yet')
  assert.throws(() => engineError('LOGIN_REQUIRED'), { code: 'INVALID_ENGINE_ERROR' })
})

test('adapter validation requires a known engine id, every contract method and only documented capabilities', () => {
  assert.deepEqual(ENGINE_IDS, ['codex', 'claude'])
  assert.ok(ENGINE_STATUSES.includes('decisionPending'))
  const adapter = fakeAdapter()
  assert.equal(validateEngineAdapter(adapter), adapter)
  assert.equal(validateEngineAdapter(fakeAdapter({ steerTurn: () => {} })).id, 'claude')
  assert.throws(() => validateEngineAdapter(null), { code: 'INVALID_ENGINE_ADAPTER' })
  assert.throws(() => validateEngineAdapter(fakeAdapter({ id: 'gemini' })), { code: 'INVALID_ENGINE_ADAPTER' })
  for (const method of ['describe', 'startThread', 'resumeThread', 'releaseThread', 'startTurn', 'interruptTurn', 'respond', 'subscribe', 'dispose']) {
    assert.throws(() => validateEngineAdapter(fakeAdapter({ [method]: undefined })), error => error.code === 'INVALID_ENGINE_ADAPTER' && error.message.includes(method))
  }
  assert.throws(() => validateEngineAdapter(fakeAdapter({ steerTurn: 'yes' })), { code: 'INVALID_ENGINE_ADAPTER' })
  assert.throws(() => validateEngineAdapter(fakeAdapter({ capabilities: () => ['stream'] })), { code: 'INVALID_ENGINE_ADAPTER' })
  assert.throws(() => validateEngineAdapter(fakeAdapter({ capabilities: () => new Set(['telepathy']) })), { code: 'INVALID_ENGINE_ADAPTER' })
  assert.ok(ENGINE_CAPABILITIES.includes('approvals.tool') && ENGINE_CAPABILITIES.includes('userInput.multiSelect'))
})

test('Claude retry, assistant and result errors map onto the existing kinds without raw text', () => {
  const kind = message => classifyClaudeError(message)?.kind ?? null
  for (const [value, expected] of [
    ['authentication_failed', 'auth'], ['oauth_org_not_allowed', 'auth'], ['cloud_credential_error', 'auth'],
    ['rate_limit', 'quota'], ['billing_error', 'quota'], ['account_on_hold', 'permission'],
    ['overloaded', 'network'], ['server_error', 'network'],
    ['invalid_request', 'model'], ['model_not_found', 'model'], ['max_output_tokens', 'model'], ['unknown', 'unknown'],
  ]) {
    assert.deepEqual(classifyClaudeError({ type: 'system', subtype: 'api_retry', error: value, attempt: 1 }), { kind: expected, code: value, willRetry: true, runFailure: false })
  }
  assert.equal(kind({ type: 'assistant', error: 'rate_limit' }), 'quota')
  assert.equal(kind({ type: 'assistant', error: 'billing_error' }), 'quota')
  assert.equal(kind({ type: 'assistant', error: 'overloaded' }), 'network')
  assert.equal(kind({ type: 'assistant', error: 'max_output_tokens' }), 'model')
  assert.equal(classifyClaudeError({ type: 'assistant', error: 'rate_limit' }).willRetry, false)
  assert.equal(kind({ type: 'assistant', message: { content: [] } }), null)
  for (const [subtype, expected] of [['error_max_budget_usd', 'quota'], ['error_max_turns', 'model'], ['error_max_structured_output_retries', 'model'], ['error_during_execution', 'unknown']]) {
    assert.equal(kind({ type: 'result', subtype, is_error: true }), expected)
  }
  assert.equal(classifyClaudeError({ type: 'result', subtype: 'success' }), null)
  const sentinel = 'Bearer PRIVATE_TOKEN_SENTINEL failed'
  const unknown = classifyClaudeError({ type: 'system', subtype: 'api_retry', error: sentinel })
  assert.deepEqual(unknown, { kind: 'unknown', code: 'unknown', willRetry: true, runFailure: false })
  assert.equal(JSON.stringify(unknown).includes('SENTINEL'), false)
  assert.equal(classifyClaudeError(null), null)
  assert.equal(classifyClaudeError({ type: 'stream_event' }), null)
})

test('Claude usage limits are quota with a reset time, warnings are not errors, and denied tools never fail the Run', () => {
  assert.deepEqual(classifyClaudeError({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: RETRY_AT / 1000 } }), { kind: 'quota', code: 'rate_limit', willRetry: false, runFailure: true, retryAt: RETRY_AT })
  assert.deepEqual(classifyClaudeError({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 'tomorrow' } }), { kind: 'quota', code: 'rate_limit', willRetry: false, runFailure: true })
  assert.equal(classifyClaudeError({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', errorCode: 'credits_required' } }).code, 'credits_required')
  assert.equal(classifyClaudeError({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', errorCode: 'credits_required' } }).kind, 'quota')
  assert.equal(classifyClaudeError({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.9 } }), null)
  assert.equal(classifyClaudeError({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), null)
  assert.deepEqual(classifyClaudeError({ type: 'system', subtype: 'permission_denied', tool_name: 'WebFetch' }), { kind: 'permission', code: 'permission_denied', willRetry: false, runFailure: false })
})
