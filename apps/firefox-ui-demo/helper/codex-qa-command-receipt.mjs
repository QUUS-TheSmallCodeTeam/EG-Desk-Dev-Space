import { createHash } from 'node:crypto'
import { chatError, publicText } from './codex-chat-values.mjs'

const NONCE = /^[A-Za-z0-9_-]{20,80}$/

export function validateQaCommandNonce(value) {
  if (value === undefined) return null
  if (typeof value !== 'string' || !NONCE.test(value)) throw chatError('INVALID_QA_COMMAND_NONCE', 'QA command nonce must be a bounded ASCII token', 400)
  return value
}

export function validateQaOutputMarkers(value) {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 ||
      value.some(marker => typeof marker !== 'string' || !NONCE.test(marker)) ||
      new Set(value).size !== value.length) {
    throw chatError('INVALID_QA_OUTPUT_MARKERS', 'QA output markers must be one to four distinct bounded ASCII tokens', 400)
  }
  return [...value]
}

// Native 0.160.1 exposes aggregated stdout/stderr, not separate stdout. Never
// publish arbitrary output. Only exact marker lines from the actual native
// item are revealed; the caller, not this module, assigns their test meaning.
export function nativeQaCommandReceipt(item, markers) {
  const expected = Array.isArray(markers) ? markers : [markers]
  if (!item || item.type !== 'commandExecution' || typeof item.id !== 'string' ||
      !expected.length || expected.length > 4 || expected.some(marker => !NONCE.test(marker || ''))) return null
  const exitCode = Number.isInteger(item.exitCode) ? item.exitCode : null
  const publicCommand = publicText(item.command, 2000)
  const base = {
    nativeItemId: item.id, nativeItemType: 'commandExecution',
    origin: 'codex-app-server.item/completed', outputStream: 'aggregated-stdout-stderr',
    nativeItemStatus: ['completed', 'failed', 'declined', 'inProgress'].includes(item.status) ? item.status : 'unknown',
    exitCode, status: 'no-marker-witness', receiptScope: 'single-native-command-item', markerLines: [],
    commandSha256: publicCommand ? createHash('sha256').update(publicCommand).digest('hex') : null,
    commandHashBasis: 'sanitized-native-item-command',
  }
  if (typeof item.aggregatedOutput !== 'string' || Buffer.byteLength(item.aggregatedOutput) > 65536) return base
  const lines = new Set(item.aggregatedOutput.split(/\r?\n/))
  const markerLines = expected.filter(marker => lines.has(marker))
  return {
    ...base, markerLines,
    status: markerLines.length && exitCode === 0 && item.status === 'completed' ? 'marker-witness' : 'no-marker-witness',
  }
}
