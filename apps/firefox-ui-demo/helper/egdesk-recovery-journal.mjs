// CTX-02: the rules of the Desk recovery journal, as pure functions.
// helper/egdesk-desk-store.mjs applies them inside its SQLite transactions;
// nothing here reads a clock, a file or a database, so each rule can be tested
// on plain rows. The numbers are decision D-R1 (2026-10-24): autosaves are
// bundled into 60-second windows, and the journal keeps the newest 200
// generations plus the newest one of each local day for 30 days, within
// 512 MiB on disk. D-R1 calls the retention numbers provisional; changing
// them changes DESK_RETENTION only.

export const DESK_RETENTION = Object.freeze({ recent: 200, dailyDays: 30, maxBytes: 512 * 1024 * 1024 })
export const DESK_AUTOSAVE_MERGE_MS = 60_000
export const DAY_MS = 86_400_000

const safeCount = value => Number.isSafeInteger(value) && value >= 0

/** Which local day (days since the epoch) a timestamp falls on, for a fixed UTC offset. */
export function localDayOf(ts, utcOffsetMinutes = 0) {
  return Math.floor((ts + utcOffsetMinutes * 60_000) / DAY_MS)
}

/**
 * planDeskRetention(rows, options) → { keep, remove } (generation numbers, newest first)
 *
 * rows: every generation in the journal, newest first:
 *   { generation, createdAt, bytes, shared }
 *   bytes is what the generation itself holds on disk; shared says whether it
 *   also refers to chat messages kept once and shared between generations.
 * options:
 *   rule             DESK_RETENTION or the store's configured rule
 *   now              the time of the save that runs the rule (local day of "today")
 *   utcOffsetMinutes what "one day" means
 *   sharedBytes      bytes of every shared message on disk (upper bound: all in use)
 *   hashesOf(generation) → the shared message hashes a generation refers to
 *   blobBytesOf(hash)    → bytes of one shared message
 *
 * Rule: keep the newest `recent`, plus the newest generation of each of the
 * last `dailyDays` local days (today included). If what is kept may still
 * exceed `maxBytes`, count exactly (a shared message is paid for while any
 * kept generation holds it) and drop the oldest kept generations first. The
 * head (rows[0]) is never removed, even over budget. hashesOf and blobBytesOf
 * are consulted only when the upper bound exceeds the budget.
 */
export function planDeskRetention(rows, { rule = DESK_RETENTION, now, utcOffsetMinutes = 0, sharedBytes = 0, hashesOf = () => [], blobBytesOf = () => 0 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array of generation rows, newest first')
  if (!safeCount(now)) throw new TypeError('now is required')
  for (let index = 1; index < rows.length; index++) {
    if (!(rows[index].generation < rows[index - 1].generation)) throw new TypeError('rows must be newest first')
  }
  const own = row => (safeCount(row.bytes) ? row.bytes : 0)
  const keep = new Set(rows.slice(0, rule.recent).map(row => row.generation))
  const today = localDayOf(now, utcOffsetMinutes), days = new Set()
  for (const row of rows) { // Newest first, so the first row seen for a day is that day's newest.
    const day = localDayOf(row.createdAt, utcOffsetMinutes)
    if (today - day >= rule.dailyDays || days.has(day)) continue
    days.add(day)
    keep.add(row.generation)
  }
  const upper = rows.reduce((sum, row) => (keep.has(row.generation) ? sum + own(row) : sum), 0) + (safeCount(sharedBytes) ? sharedBytes : 0)
  if (upper > rule.maxBytes) {
    const holders = new Map(), sizes = new Map(), hashes = new Map()
    let bytes = 0
    for (const row of rows) {
      if (!keep.has(row.generation)) continue
      bytes += own(row)
      const refs = row.shared ? [...new Set(hashesOf(row.generation))] : []
      hashes.set(row.generation, refs)
      for (const hash of refs) {
        if (!holders.has(hash)) { const size = blobBytesOf(hash); sizes.set(hash, safeCount(size) ? size : 0); bytes += sizes.get(hash) }
        holders.set(hash, (holders.get(hash) ?? 0) + 1)
      }
    }
    for (let index = rows.length - 1; index > 0 && bytes > rule.maxBytes; index--) {
      const row = rows[index]
      if (!keep.delete(row.generation)) continue
      bytes -= own(row)
      for (const hash of hashes.get(row.generation) ?? []) {
        const left = holders.get(hash) - 1
        holders.set(hash, left)
        if (!left) bytes -= sizes.get(hash)
      }
    }
  }
  const kept = [], removed = []
  for (const row of rows) (keep.has(row.generation) ? kept : removed).push(row.generation)
  return { keep: kept, remove: removed }
}

/**
 * autosaveWindowMerges({ head, ts, mergeMs, contested }) → true when an autosave
 * at `ts` should replace the head instead of adding a generation (D-R1, 60 s).
 * head: { generation, reason, createdAt, windowStart } (null for an empty journal).
 * The window is anchored at its first save (windowStart, else createdAt). It
 * never merges into an explicit save, a restore or an import, into a head
 * another writer collided with (contested), or across a clock that went back.
 */
export function autosaveWindowMerges({ head, ts, mergeMs = DESK_AUTOSAVE_MERGE_MS, contested = new Set() } = {}) {
  if (!(Number.isSafeInteger(mergeMs) && mergeMs > 0) || !head || head.reason !== 'autosave' || !safeCount(ts)) return false
  if (contested.has(head.generation)) return false
  if (!safeCount(head.createdAt) || ts < head.createdAt) return false
  const start = safeCount(head.windowStart) ? head.windowStart : head.createdAt
  return ts - start < mergeMs
}
