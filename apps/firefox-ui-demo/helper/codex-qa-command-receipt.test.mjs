import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeQaCommandReceipt, validateQaCommandNonce, validateQaOutputMarkers } from './codex-qa-command-receipt.mjs'

const nonce = 'EGDESK_PUBLIC_QA_7f41ad982b'

test('only an exact line in an authoritative native command item yields a bounded public receipt', () => {
  const item = { id: 'command-item-1', type: 'commandExecution', status: 'completed', exitCode: 0, command: 'cat /public/fixture',
    aggregatedOutput: `other private output\n${nonce}\n` }
  const receipt = nativeQaCommandReceipt(item, [nonce])
  assert.equal(receipt.nativeItemId, 'command-item-1')
  assert.equal(receipt.nativeItemStatus, 'completed')
  assert.equal(receipt.origin, 'codex-app-server.item/completed')
  assert.equal(receipt.outputStream, 'aggregated-stdout-stderr')
  assert.equal(receipt.exitCode, 0)
  assert.equal(receipt.status, 'verified')
  assert.deepEqual(receipt.markerLines, [nonce])
  assert.match(receipt.commandSha256, /^[a-f0-9]{64}$/)
  assert.equal(receipt.commandHashBasis, 'sanitized-native-item-command')
  assert.equal(JSON.stringify(receipt).includes('other private output'), false)
})

test('substring, failed exit, missing output and malformed nonce never become proof', () => {
  const item = { id: 'command-item-1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: `spoiled-${nonce}-suffix\n` }
  assert.equal(nativeQaCommandReceipt(item, nonce).status, 'not-verified')
  assert.equal(nativeQaCommandReceipt({ ...item, aggregatedOutput: `${nonce}\n`, exitCode: 1 }, nonce).status, 'not-verified')
  assert.deepEqual(nativeQaCommandReceipt({ ...item, aggregatedOutput: null }, nonce).markerLines, [])
  assert.equal(nativeQaCommandReceipt({ ...item, type: 'agentMessage' }, nonce), null)
  assert.equal(validateQaCommandNonce(nonce), nonce)
  for (const value of ['', 'short', 'spaces are not allowed', null]) assert.throws(() => validateQaCommandNonce(value), error => error.code === 'INVALID_QA_COMMAND_NONCE')
})

test('bounded marker array records only actually observed lines without assigning a caller-stated purpose', () => {
  const commandTag = 'EGDESK_COMMAND_TAG_89ac5217'
  assert.deepEqual(validateQaOutputMarkers([nonce, commandTag]), [nonce, commandTag])
  const receipt = nativeQaCommandReceipt({ id: 'command-2', type: 'commandExecution', status: 'completed', exitCode: 0,
    command: 'printf tag', aggregatedOutput: `private value\n${commandTag}\n` }, [nonce, commandTag])
  assert.deepEqual(receipt.markerLines, [commandTag])
  assert.equal(JSON.stringify(receipt).includes(nonce), false)
  assert.equal(JSON.stringify(receipt).includes('private value'), false)
  for (const value of [[], [nonce, nonce], [nonce, 'short'], [nonce, commandTag, nonce, commandTag, nonce]]) {
    assert.throws(() => validateQaOutputMarkers(value), error => error.code === 'INVALID_QA_OUTPUT_MARKERS')
  }
})
