// Round g (L59): the act journal. In memory only, bounded; written by the Browser tool service when EGDESK_BROWSER_PROCEDURES is on.
// Key: (clientThreadId, cardId). Each entry carries its runId, so a draft takes the most recent run on that card in that thread.
export const JOURNAL_LIMITS = Object.freeze({ entries: 200, keys: 50 })
const keyOf = (clientThreadId, cardId) => JSON.stringify([clientThreadId, cardId])

export function createActJournal({ maxEntries = JOURNAL_LIMITS.entries, maxKeys = JOURNAL_LIMITS.keys } = {}) {
  const keys = new Map() // most recently written last
  return {
    record(clientThreadId, cardId, entry) {
      if (typeof clientThreadId !== 'string' || typeof cardId !== 'string' || !entry || typeof entry !== 'object') return
      const key = keyOf(clientThreadId, cardId)
      const list = keys.get(key) ?? []
      keys.delete(key)
      list.push(entry)
      if (list.length > maxEntries) list.splice(0, list.length - maxEntries)
      keys.set(key, list)
      while (keys.size > maxKeys) keys.delete(keys.keys().next().value)
    },
    /** The acts of the most recent run (by runId) on this card in this thread, oldest first; [] when none. */
    lastRun(clientThreadId, cardId) {
      const list = keys.get(keyOf(clientThreadId, cardId)) ?? []
      if (!list.length) return []
      const runId = list[list.length - 1].runId
      return list.filter(entry => entry.runId === runId).map(entry => structuredClone(entry))
    },
    size: () => keys.size,
    clear: () => keys.clear(),
  }
}
