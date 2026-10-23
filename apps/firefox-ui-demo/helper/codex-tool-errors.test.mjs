import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyPublicToolError } from './codex-tool-errors.mjs'

test('known Reader domain code survives classification without its private diagnostic', () => {
  const sentinel = 'RAW_SOURCE_SENTINEL_92ad'
  const known = classifyPublicToolError({ code: 'READER_CONFIGURATION_REQUIRED', message: sentinel }, { context: true })
  assert.equal(known.code, 'READER_CONFIGURATION_REQUIRED')
  assert.equal(JSON.stringify(known).includes(sentinel), false)
  const unknown = classifyPublicToolError({ code: sentinel, message: sentinel }, { context: true })
  assert.equal(unknown.code, 'TOOL_PROVIDER_FAILED')
  assert.equal(JSON.stringify(unknown).includes(sentinel), false)
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
