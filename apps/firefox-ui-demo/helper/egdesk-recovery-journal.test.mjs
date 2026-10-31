import test from 'node:test'
import assert from 'node:assert/strict'
import { DAY_MS, DESK_AUTOSAVE_MERGE_MS, DESK_RETENTION, autosaveWindowMerges, localDayOf, planDeskRetention } from './egdesk-recovery-journal.mjs'

const T0 = Date.UTC(2026, 9, 1, 12) // Noon UTC: far from any day boundary.
const range = (from, to) => Array.from({ length: Math.abs(to - from) + 1 }, (_, index) => (from > to ? from - index : from + index))
// Newest first, like the store's rows: generation = position + 1, one per `step`.
const rowsOf = (count, { step = 1000, bytes = 100, shared = false, start = T0 } = {}) =>
  range(count, 1).map(generation => ({ generation, createdAt: start + (generation - 1) * step, bytes, shared }))

test('D-R1 numbers: 60-second autosave window; newest 200 + 30 daily + 512 MiB', () => {
  assert.deepEqual({ ...DESK_RETENTION }, { recent: 200, dailyDays: 30, maxBytes: 512 * 1024 * 1024 })
  assert.equal(DESK_AUTOSAVE_MERGE_MS, 60_000)
  assert.ok(Object.isFrozen(DESK_RETENTION))
})

test('localDayOf counts days in the given offset', () => {
  const midnightSeoul = Date.UTC(2026, 9, 1, 15) // 2026-10-02 00:00 KST
  assert.equal(localDayOf(midnightSeoul, 540) - localDayOf(midnightSeoul - 1, 540), 1, 'KST day changes at 15:00 UTC')
  assert.equal(localDayOf(midnightSeoul, 0), localDayOf(midnightSeoul - 1, 0), 'the UTC day does not')
  assert.equal(localDayOf(DAY_MS * 3 + 5), 3)
})

test('retention keeps the newest 200 plus the newest of each of the last 30 days, and never the head', () => {
  // One generation a day for days 0..34 (generation = day + 1), then 199 more on day 34 (36..234).
  const daily = range(1, 35).map(generation => ({ generation, createdAt: T0 + (generation - 1) * DAY_MS, bytes: 10, shared: false }))
  const burst = range(36, 234).map(generation => ({ generation, createdAt: T0 + 34 * DAY_MS + (generation - 35) * 1000, bytes: 10, shared: false }))
  const rows = [...burst, ...daily].sort((a, b) => b.generation - a.generation)
  const plan = planDeskRetention(rows, { now: T0 + 34 * DAY_MS + 300_000 })
  // Newest 200 = 234..35 (all day 34); days 5..33 keep their only generation (6..34); 1..5 go.
  assert.deepEqual(plan.keep, [...range(234, 35), ...range(34, 6)])
  assert.deepEqual(plan.remove, range(5, 1))
  // Time alone moves the window: on day 40 days 5..10 leave it as well.
  const later = planDeskRetention(rows, { now: T0 + 40 * DAY_MS })
  assert.deepEqual(later.keep, [...range(234, 35), ...range(34, 12)])
  // The head stays even when it is the only row and the rule would drop it.
  const single = planDeskRetention([{ generation: 7, createdAt: 0, bytes: 10, shared: false }], { rule: { recent: 1, dailyDays: 1, maxBytes: 1 }, now: T0 })
  assert.deepEqual(single, { keep: [7], remove: [] })
  assert.deepEqual(planDeskRetention([], { now: T0 }), { keep: [], remove: [] })
})

test('the day boundary follows utcOffsetMinutes', () => {
  // Two saves 30 minutes apart around 15:00 UTC: one KST day apart, the same UTC day.
  const rows = [{ generation: 2, createdAt: Date.UTC(2026, 9, 1, 15, 10), bytes: 1, shared: false }, { generation: 1, createdAt: Date.UTC(2026, 9, 1, 14, 40), bytes: 1, shared: false }]
  const rule = { recent: 1, dailyDays: 30, maxBytes: 1024 }
  assert.deepEqual(planDeskRetention(rows, { rule, now: rows[0].createdAt, utcOffsetMinutes: 540 }).keep, [2, 1], 'each KST day keeps its newest')
  assert.deepEqual(planDeskRetention(rows, { rule, now: rows[0].createdAt, utcOffsetMinutes: 0 }).keep, [2], 'one UTC day keeps only the newer')
})

test('the byte budget drops the oldest kept generations first and never the head', () => {
  const rows = rowsOf(6, { bytes: 100 })
  const rule = { recent: 10, dailyDays: 1, maxBytes: 300 }
  assert.deepEqual(planDeskRetention(rows, { rule, now: T0 + 10_000 }), { keep: [6, 5, 4], remove: [3, 2, 1] })
  assert.deepEqual(planDeskRetention(rowsOf(3), { rule: { ...rule, maxBytes: 1 }, now: T0 + 10_000 }).keep, [3], 'the head stays even over budget')
  // Exactly on budget: nothing dropped.
  assert.deepEqual(planDeskRetention(rows, { rule: { ...rule, maxBytes: 600 }, now: T0 + 10_000 }).remove, [])
})

test('shared chat messages are paid for once while any kept generation holds them', () => {
  // Three generations share message "m" (500 bytes); each holds 100 bytes of its own.
  const rows = rowsOf(3, { bytes: 100, shared: true })
  const hashesOf = generation => (generation === 1 ? ['m', 'm'] : ['m']) // duplicates in one generation count once
  const blobBytesOf = hash => (hash === 'm' ? 500 : 0)
  const rule = { recent: 10, dailyDays: 1, maxBytes: 700 }
  // Upper bound 300 + 500 = 800 > 700, exact 800 > 700: drop generation 1 (own 100), the message stays held → 700 fits.
  assert.deepEqual(planDeskRetention(rows, { rule, now: T0 + 10_000, sharedBytes: 500, hashesOf, blobBytesOf }), { keep: [3, 2], remove: [1] })
  // Only generation 1 holds "x" (400 bytes): dropping it frees the message too.
  const mixed = rowsOf(3, { bytes: 100, shared: true })
  const hashes = generation => (generation === 1 ? ['m', 'x'] : ['m'])
  const sizes = hash => ({ m: 500, x: 400 })[hash]
  assert.deepEqual(planDeskRetention(mixed, { rule: { ...rule, maxBytes: 700 }, now: T0 + 10_000, sharedBytes: 900, hashesOf: hashes, blobBytesOf: sizes }).keep, [3, 2])
  // Within the upper bound, the per-message callbacks are never consulted.
  let asked = 0
  planDeskRetention(rows, { rule: { ...rule, maxBytes: 10_000 }, now: T0 + 10_000, sharedBytes: 500, hashesOf: () => { asked++; return ['m'] }, blobBytesOf: () => { asked++; return 500 } })
  assert.equal(asked, 0)
})

test('rows must be newest first and now is required', () => {
  assert.throws(() => planDeskRetention([{ generation: 1, createdAt: 0, bytes: 1 }, { generation: 2, createdAt: 0, bytes: 1 }], { now: T0 }), TypeError)
  assert.throws(() => planDeskRetention(rowsOf(2)), TypeError)
  assert.throws(() => planDeskRetention(null, { now: T0 }), TypeError)
})

test('an autosave within 60 seconds of its window start replaces the head; nothing else does', () => {
  const head = { generation: 3, reason: 'autosave', createdAt: T0 + 10_000, windowStart: T0 }
  assert.equal(autosaveWindowMerges({ head, ts: T0 + 59_999 }), true, 'anchored at the first save of the window')
  assert.equal(autosaveWindowMerges({ head, ts: T0 + 60_000 }), false, 'the next window adds a generation')
  assert.equal(autosaveWindowMerges({ head: { ...head, windowStart: null }, ts: T0 + 69_000 }), true, 'a v1 row anchors at its own time')
  assert.equal(autosaveWindowMerges({ head, ts: T0 + 5000 }), false, 'a clock that went back never merges')
  for (const reason of ['explicit', 'restore', 'import']) assert.equal(autosaveWindowMerges({ head: { ...head, reason }, ts: T0 + 20_000 }), false, reason)
  assert.equal(autosaveWindowMerges({ head: null, ts: T0 }), false)
  assert.equal(autosaveWindowMerges({ head, ts: T0 + 20_000, contested: new Set([3]) }), false, 'a head another writer collided with stays')
  assert.equal(autosaveWindowMerges({ head, ts: T0 + 20_000, contested: new Set([2]) }), true)
  assert.equal(autosaveWindowMerges({ head, ts: T0 + 20_000, mergeMs: 0 }), false, 'the window can be turned off')
  assert.equal(autosaveWindowMerges({ head, ts: T0 + 20_000, mergeMs: 1.5 }), false)
})
