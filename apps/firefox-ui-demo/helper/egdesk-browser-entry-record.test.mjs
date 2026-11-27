import test from 'node:test'
import assert from 'node:assert/strict'
import { closedEntryStep } from './egdesk-browser-entry-record.mjs'

const meta = { callId: 'entry-12345678-1234-1234-1234-123456789abc', seq: 1, completedAt: 1000, durationMs: 5 }
test('entry record keeps select, drops activity, and never carries a preview', () => {
  const select = closedEntryStep({ op: 'select', by: 'decision', ok: true, displayValue: 'secret', target: 'x' }, meta)
  assert.equal(select.op, 'select')
  assert.deepEqual(Object.keys(select).sort(), ['by', 'callId', 'completedAt', 'durationMs', 'ok', 'op', 'seq', 'status'])
  assert.equal(closedEntryStep({ op: 'activity', phase: 'start', by: 'decision', ok: true }, meta), null)
})
