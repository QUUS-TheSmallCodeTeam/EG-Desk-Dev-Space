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
