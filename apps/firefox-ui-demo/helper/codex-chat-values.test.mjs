import test from 'node:test'
import assert from 'node:assert/strict'
import { chatError, ERROR_KINDS, publicError, publicErrorKind, publicText } from './codex-chat-values.mjs'

// Copy of CodexErrorInfo in codex 0.162.1 ErrorNotification.json (TurnError).
const CODEX_ERROR_INFO_STRINGS = [
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable',
  'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'internalServerError',
  'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'other',
]
const expectedStringKinds = {
  contextWindowExceeded: 'model', sessionBudgetExceeded: 'model', usageLimitExceeded: 'quota', rateLimitExceeded: 'quota',
  flexUnavailable: 'model', serverOverloaded: 'network', cyberPolicy: 'permission', misalignmentPolicyViolation: 'permission',
  tooManyDenials: 'permission', internalServerError: 'network', unauthorized: 'auth', badRequest: 'model',
  threadRollbackFailed: 'unknown', sandboxError: 'permission', other: 'unknown',
}
const turnError = (codexErrorInfo, message = 'Codex turn failed') => ({ message, codexErrorInfo, additionalDetails: null })

// The pre-kind implementation, kept to prove the old fields did not change.
const legacyPublicError = (error, code = 'CHAT_ERROR', origin = 'bridge') => ({ code: String(code), origin, message: publicText(error?.message || error || 'Codex request failed', 2000) })

test('every CodexErrorInfo string variant maps to a fixed kind', () => {
  assert.deepEqual(Object.keys(expectedStringKinds).sort(), [...CODEX_ERROR_INFO_STRINGS].sort())
  for (const info of CODEX_ERROR_INFO_STRINGS) {
    const error = publicError(turnError(info), 'TURN_ERROR', 'codex')
    assert.equal(error.kind, expectedStringKinds[info], info)
    assert.ok(ERROR_KINDS.includes(error.kind))
  }
})

test('transport object variants are network unless the upstream HTTP status says otherwise', () => {
  for (const variant of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']) {
    assert.equal(publicError(turnError({ [variant]: { httpStatusCode: null } }), 'TURN_ERROR', 'codex').kind, 'network', variant)
    assert.equal(publicError(turnError({ [variant]: {} }), 'TURN_ERROR', 'codex').kind, 'network', variant)
    assert.equal(publicError(turnError({ [variant]: { httpStatusCode: 502 } }), 'TURN_ERROR', 'codex').kind, 'network', variant)
    assert.equal(publicError(turnError({ [variant]: { httpStatusCode: 401 } }), 'TURN_ERROR', 'codex').kind, 'auth', variant)
    assert.equal(publicError(turnError({ [variant]: { httpStatusCode: 403 } }), 'TURN_ERROR', 'codex').kind, 'permission', variant)
    assert.equal(publicError(turnError({ [variant]: { httpStatusCode: 429 } }), 'TURN_ERROR', 'codex').kind, 'quota', variant)
  }
  assert.equal(publicError(turnError({ activeTurnNotSteerable: { turnKind: 'review' } }), 'TURN_ERROR', 'codex').kind, 'unknown')
})

test('unrecognized or prototype-named causes never classify by accident', () => {
  for (const info of ['constructor', 'toString', '__proto__', 'UsageLimitExceeded', 'usage_limit_exceeded', '', 3, [], { somethingNew: {} }, { constructor: {} }, null, undefined]) {
    assert.equal(publicError(turnError(info), 'TURN_ERROR', 'codex').kind, 'unknown', String(info))
  }
})

test('the structured cause wins over code and message text', () => {
  assert.equal(publicError(turnError('unauthorized', 'You have hit your usage limit'), 'CONNECTION_LOST', 'codex').kind, 'auth')
  assert.equal(publicError(turnError('usageLimitExceeded', 'network error'), 'TURN_ERROR', 'codex').kind, 'quota')
  // 'other' has no cause, so the fallbacks still apply.
  assert.equal(publicError(turnError('other', 'Rate limit reached for requests'), 'TURN_ERROR', 'codex').kind, 'quota')
})

test('bridge codes with an unambiguous cause are classified; local busy/denial codes are not guessed', () => {
  assert.equal(publicError(chatError('LOGIN_REQUIRED', 'Codex ChatGPT login is required', 401), 'LOGIN_REQUIRED').kind, 'auth')
  assert.equal(publicError(chatError('LOGIN_REQUIRED', 'Codex ChatGPT login is required', 401), 'RUN_BINDING_FAILED').kind, 'auth')
  assert.equal(publicError('Codex connection lost; resume to reconcile', 'CONNECTION_LOST').kind, 'network')
  assert.equal(publicError(chatError('BRIDGE_OFFLINE', 'Codex app-server is offline', 503), 'TURN_START_FAILED').kind, 'network')
  assert.equal(publicError(Object.assign(new Error('turn/start timed out'), { code: 'RPC_TIMEOUT' }), 'TURN_START_FAILED').kind, 'network')
  // 429 here is local concurrency, not a subscription limit.
  assert.equal(publicError(chatError('RUNTIME_BUSY', 'Too many active turns', 429), 'TURN_START_FAILED').kind, 'unknown')
  assert.equal(publicError('Local Codex process exited', 'RUNTIME_LOST').kind, 'unknown')
  assert.equal(publicError('Bridge restarted before this run was confirmed complete', 'RUNTIME_RESTARTED').kind, 'unknown')
  assert.equal(publicError('Approval target is unavailable; no permission was granted', 'UNSUPPORTED_APPROVAL_TARGET').kind, 'unknown')
  assert.equal(publicError('Codex requested an unsupported interaction; no permission was granted', 'UNSUPPORTED_INTERACTION').kind, 'unknown')
  // Numeric JSON-RPC codes are not bridge codes.
  assert.equal(publicError(Object.assign(new Error('Invalid request'), { code: -32600 }), 'TURN_START_FAILED').kind, 'unknown')
})

test('message text is the last resort for errors without a structured cause', () => {
  const kindOf = message => publicErrorKind(Object.assign(new Error(message), { code: -32000 }), 'TURN_START_FAILED')
  assert.equal(kindOf("You've hit your usage limit. Try again later."), 'quota')
  assert.equal(kindOf('Rate limit reached'), 'quota')
  assert.equal(kindOf('401 Unauthorized'), 'auth')
  assert.equal(kindOf('Your access token has expired; please sign in again'), 'auth')
  assert.equal(kindOf('Permission denied (os error 13)'), 'permission')
  assert.equal(kindOf('403 Forbidden'), 'permission')
  assert.equal(kindOf('connect ECONNREFUSED 127.0.0.1:443'), 'network')
  assert.equal(kindOf('Codex app-server is not connected'), 'network')
  assert.equal(kindOf('stream disconnected before completion'), 'network')
  assert.equal(kindOf('Something odd happened'), 'unknown')
  assert.equal(kindOf('Reader session limit reached'), 'unknown')
  assert.equal(publicErrorKind(null, 'CHAT_ERROR'), 'unknown')
  assert.equal(publicErrorKind(undefined), 'unknown')
})

test('existing publicError fields are unchanged; only kind (and optional retryAt) are added', () => {
  const inputs = [
    [turnError('usageLimitExceeded', 'Usage limit reached'), 'TURN_ERROR', 'codex'],
    [turnError(null, 'Turn failed'), 'TURN_FAILED', 'codex'],
    ['Local Codex process exited', 'RUNTIME_LOST'],
    [new Error('Authorization: Bearer abc.def.ghi failed'), 'TURN_START_FAILED'],
    [chatError('LOGIN_REQUIRED', 'Codex ChatGPT login is required', 401)],
    [null], [undefined], [''], [{}], [42, 7],
    ['x'.repeat(5000), 'LONG'],
  ]
  for (const args of inputs) {
    const result = publicError(...args)
    const legacy = legacyPublicError(...args)
    assert.deepEqual({ code: result.code, origin: result.origin, message: result.message }, legacy)
    assert.deepEqual(Object.keys(result), ['code', 'origin', 'message', 'kind'])
  }
  assert.equal(publicError(new Error('token=sk-abcdef123 failed')).message.includes('sk-abcdef123'), false)
})

test('retryAt is public only when a valid reset time is supplied', () => {
  const resetMs = Date.UTC(2026, 9, 24, 6, 20)
  const withOption = publicError(turnError('usageLimitExceeded'), 'TURN_ERROR', 'codex', { retryAt: resetMs / 1000 })
  assert.equal(withOption.retryAt, resetMs)
  assert.deepEqual(Object.keys(withOption), ['code', 'origin', 'message', 'kind', 'retryAt'])
  assert.equal(publicError(turnError('usageLimitExceeded'), 'TURN_ERROR', 'codex', { retryAt: resetMs }).retryAt, resetMs)
  assert.equal(publicError(turnError('usageLimitExceeded'), 'TURN_ERROR', 'codex', { retryAt: '2026-10-24T06:20:00Z' }).retryAt, resetMs)
  const bridgeError = Object.assign(chatError('USAGE_LIMIT', 'Usage limit reached', 429), { retryAt: resetMs })
  assert.equal(publicError(bridgeError, 'USAGE_LIMIT').retryAt, resetMs)
  // Native payloads cannot inject retryAt; malformed values are dropped.
  assert.equal('retryAt' in publicError({ ...turnError('usageLimitExceeded'), retryAt: resetMs }, 'TURN_ERROR', 'codex'), false)
  for (const retryAt of [null, undefined, 'soon', -1, 0, NaN, {}]) {
    assert.equal('retryAt' in publicError(turnError('usageLimitExceeded'), 'TURN_ERROR', 'codex', { retryAt }), false)
  }
})
