import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createActJournal } from './egdesk-browser-procedure-journal.mjs'

test('journal: last run only, copies, per-key bound and key bound', () => {
  const j = createActJournal({ maxEntries: 3, maxKeys: 2 })
  for (const [i, runId] of [[1, 'a'], [2, 'a'], [3, 'b'], [4, 'b'], [5, 'b'], [6, 'b']]) j.record('t', 'c', { runId, i })
  assert.deepEqual(j.lastRun('t', 'c').map(e => e.i), [4, 5, 6])
  const copy = j.lastRun('t', 'c'); copy[0].i = 99
  assert.equal(j.lastRun('t', 'c')[0].i, 4)
  assert.deepEqual(j.lastRun('t', 'other'), [])
  j.record('t', 'c2', { runId: 'x' }); j.record('t', 'c3', { runId: 'x' })
  assert.equal(j.size(), 2)
  assert.deepEqual(j.lastRun('t', 'c'), [], 'the oldest key was dropped')
  j.record('t', 'c2', { runId: 'y' }); j.record('t', 'c4', { runId: 'x' })
  assert.deepEqual(j.lastRun('t', 'c3'), [], 'a key written again stays')
  assert.equal(j.lastRun('t', 'c2').length, 2 - 1)
  j.record(1, 'c', {}); j.record('t', 'c', null)
})
