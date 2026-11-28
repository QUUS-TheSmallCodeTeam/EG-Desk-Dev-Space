// L49: a deleted room's POST /chat/conversation/forget, made reliable. The room leaves the screen at once; the bridge's forget is slow (history rows,
// backups, native engine threads, runs), so a burst of fire-and-forget requests left conversations stored. Here the ids go through one queue:
// one request at a time (awaited), retried with backoff on a network error or a 5xx/408/429, kept in a small pref until the bridge answers (so a
// restart resumes them), dropped on any other 4xx (the bridge says the id can never be forgotten). Forget is idempotent at the bridge. No UI, no text.
export const FORGET_QUEUE_PREF = 'egdesk.pendingForgets.v1'
export const FORGET_QUEUE_MAX = 2000
export const FORGET_BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000, 30000])

export function retryable(error) {
  const status = error?.status
  if (!Number.isInteger(status)) return true // no response: the bridge is down, restarting or the connection dropped
  return status >= 500 || status === 408 || status === 429
}

export function parsePending(text) {
  try {
    const list = JSON.parse(text)
    if (!Array.isArray(list)) return []
    return [...new Set(list.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 300))].slice(0, FORGET_QUEUE_MAX)
  } catch { return [] }
}

export function createForgetQueue({ send, load = () => [], save = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), backoff = FORGET_BACKOFF_MS } = {}) {
  if (typeof send !== 'function') throw new TypeError('send is required')
  let pending = []
  try { pending = parsePending(JSON.stringify(load())) } catch { pending = [] }
  let running = false, timer = null, attempt = 0, stopped = false
  const persist = () => { try { save([...pending]) } catch { /* the queue still runs in memory */ } }
  async function drain() {
    if (running || stopped) return
    running = true
    try {
      while (pending.length && !stopped) {
        const id = pending[0]
        try { await send(id) } catch (error) {
          if (retryable(error)) {
            const delay = backoff[Math.min(attempt, backoff.length - 1)]
            attempt++
            timer = setTimer(() => { timer = null; void drain() }, delay)
            return
          }
        }
        attempt = 0
        pending.shift()
        persist()
      }
    } finally { running = false }
  }
  return {
    enqueue(id) {
      if (typeof id !== 'string' || !id || id.length > 300) return false
      if (!pending.includes(id)) { pending.push(id); if (pending.length > FORGET_QUEUE_MAX) pending.shift(); persist() }
      void drain()
      return true
    },
    // Start (or restart) the queue: after a start, or once the bridge is reachable again; a waiting retry is brought forward.
    resume() {
      if (timer !== null) { clearTimer(timer); timer = null }
      attempt = 0
      return drain()
    },
    stop() { stopped = true; if (timer !== null) { clearTimer(timer); timer = null } },
    pending: () => [...pending],
    idle: () => !running && timer === null,
  }
}
