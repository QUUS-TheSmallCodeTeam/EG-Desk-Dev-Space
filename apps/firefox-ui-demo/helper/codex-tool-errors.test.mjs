import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPublicToolError } from './codex-tool-errors.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

test('known Reader domain code survives classification without its private diagnostic', () => {
  const sentinel = 'RAW_SOURCE_SENTINEL_92ad'
  const known = classifyPublicToolError({ code: 'READER_CONFIGURATION_REQUIRED', message: sentinel }, { context: true })
  assert.equal(known.code, 'READER_CONFIGURATION_REQUIRED')
  assert.equal(JSON.stringify(known).includes(sentinel), false)
  const unknown = classifyPublicToolError({ code: sentinel, message: sentinel }, { context: true })
  assert.equal(unknown.code, 'TOOL_PROVIDER_FAILED')
  assert.equal(JSON.stringify(unknown).includes(sentinel), false)
})

test('reviewed B2 context codes retain refusal status but never private diagnostic fields', () => {
  const sentinel = 'PRIVATE_SOURCE_AND_ACCOUNT_B2_74c1'
  const contextProvider = { providerId: 'egdesk-context-v1' }
  const failure = error => CodexChatRuntime.prototype.providerFailure.call({ contexts: contextProvider }, error, contextProvider)
  for (const [code, httpStatus] of [
    ['INVALID_CONTEXT_ROUTE', 400],
    ['CONTEXT_ENGINE_UNSUPPORTED', 409],
    ['CONTEXT_TOOL_UNSUPPORTED', 409], // selected unsupported action, before send
    ['CONTEXT_TOOL_UNSUPPORTED', 403], // forbidden tool during a run
    ['CONTEXT_THREAD_MISMATCH', 403],
    ['CONTEXT_CAPTURE_INCOMPLETE', 409],
    ['CONTEXT_BINDING_MISSING', 409],
    ['CONTEXT_DELIVERY_FAILED', 409],
    ['CLAUDE_CONTEXT_READER_UNSUPPORTED', 409],
    ['CONTEXT_SCOPE_CHANGED', 409],
    ['UNSUPPORTED_SOURCE_FORMAT', 422],
    ['ENGINE_CAPACITY_UNKNOWN', 409],
    ['ENGINE_CONTEXT_CONFIGURATION_ERROR', 409],
    ['CONTEXT_CAPACITY_REQUIRED', 409],
    ['PACKET_ADMISSION_REQUIRED', 409],
  ]) {
    const error = { code, httpStatus, message: sentinel, stack: sentinel, details: { ownerKey: sentinel, source: sentinel } }
    const classified = classifyPublicToolError(error, { context: true })
    assert.deepEqual(Object.keys(classified).sort(), ['code', 'message'])
    assert.equal(classified.code, code)
    assert.equal(JSON.stringify(classified).includes(sentinel), false)
    const publicError = failure(error)
    assert.deepEqual([publicError.code, publicError.httpStatus], [code, httpStatus])
    assert.equal(publicError.message.includes(sentinel), false)
    assert.equal(JSON.stringify(publicError).includes(sentinel), false)
    assert.equal(classifyPublicToolError(error).code, 'TOOL_PROVIDER_FAILED', 'these are Context-only classifications')
    assert.equal(classifyPublicToolError(error, { browser: true }).code, 'BROWSER_TOOL_FAILED')
  }
  // A Context-looking prefix or client-error status is not an allowlist grant.
  for (const code of ['CONTEXT_FUTURE_B2_FAILURE', `${sentinel}_CONTEXT_SCOPE_CHANGED`, undefined]) {
    const rejected = failure({ code, httpStatus: 409, message: sentinel, details: sentinel })
    assert.deepEqual([rejected.code, rejected.httpStatus], ['TOOL_PROVIDER_FAILED', 502])
    assert.equal(rejected.message.includes(sentinel), false)
    assert.equal(JSON.stringify(rejected).includes(sentinel), false)
  }
  assert.equal(failure({ code: 'CONTEXT_SCOPE_CHANGED', message: sentinel }).httpStatus, 502, 'never invent an originating HTTP status')
})

test('guarded scroll, press, wait and same-site navigate codes reach the model; an unknown wait never reads as success', () => {
  const sentinel = 'RAW_PAGE_SENTINEL_51c0'
  for (const code of ['BROWSER_NAVIGATE_OUT_OF_SCOPE', 'BROWSER_PRESS_TARGET_NOT_FOCUSED', 'BROWSER_WAIT_OUTCOME_UNKNOWN']) {
    const failure = classifyPublicToolError({ code, message: sentinel }, { browser: true })
    assert.equal(failure.code, code)
    assert.equal(JSON.stringify(failure).includes(sentinel), false)
  }
  assert.equal(classifyPublicToolError({ code: 'BROWSER_WAIT_OUTCOME_UNKNOWN' }, { browser: true }).message,
    classifyPublicToolError({ code: 'BROWSER_OUTCOME_UNKNOWN' }, { browser: true }).message)
  assert.match(classifyPublicToolError({ code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' }, { browser: true }).message, /rejected/)
  // Outside a Browser provider the same codes stay withheld.
  assert.equal(classifyPublicToolError({ code: 'BROWSER_NAVIGATE_OUT_OF_SCOPE' }).code, 'TOOL_PROVIDER_FAILED')
})
