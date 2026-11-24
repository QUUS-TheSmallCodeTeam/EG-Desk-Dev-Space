import { randomUUID } from 'node:crypto'

// A short, private turn on a temporary fork of a conversation: the subjective model writes or revises ONE piece of text and
// nothing about the turn reaches the chat (no run, no messages, no activities). Used for the draft check's one revision and for
// the short intermediate messages. Only the final-answer text is read back.
//
//   const turns = createInternalTurns()
//   runtime.handleNotification / handleServerRequest first offer every message to turns.feed(...) / turns.declines(...)
//   await turns.run({ engine, slot, parentThreadId, text, timeoutMs, signal }) → { text }
//
// Assumptions that need the real app-server (the mock engine cannot confirm them): thread/fork may copy the parent's completed
// turns (excludeTurns only trims the response); the fork keeps no local history when marked ephemeral; tool and approval requests
// on the fork are declined here, so it cannot act.
export function createInternalTurns({ setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle) } = {}) {
  const live = new Map() // forkThreadId -> collector
  const fail = (code, message) => Object.assign(new Error(message), { code })
  return {
    has: threadId => live.has(threadId),
    /** True when the message belonged to an internal turn (the caller must then not process it). */
    feed(message) {
      const threadId = message?.params?.threadId, collector = live.get(threadId)
      if (!collector) return false
      collector.take(message)
      return true
    },
    /** True when a server request came from an internal thread; the caller answers it with a refusal. */
    declines(message) { return live.has(message?.params?.threadId) },
    /** The deadline covers everything, including an engine that never answers the fork or the turn start (a hung engine). */
    async run({ engine, slot, parentThreadId, text, timeoutMs = 20000, signal = null }) {
      if (!engine?.forkThread || !engine.startTurn) throw fail('INTERNAL_TURN_UNSUPPORTED', 'Engine cannot run an internal turn')
      let forkId = null, timer = null, over = false, settle = null
      const done = new Promise((resolve, reject) => { settle = { resolve, reject } })
      const parts = []
      const collector = {
        take(message) {
          if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage' && message.params.item.phase === 'final_answer') parts.push(String(message.params.item.text ?? ''))
          else if (message.method === 'turn/completed') {
            if (message.params?.turn?.status === 'completed') settle.resolve(parts.join('\n').trim())
            else settle.reject(fail('INTERNAL_TURN_FAILED', 'Internal turn did not complete'))
          }
        },
      }
      const release = id => { live.delete(id); try { void Promise.resolve(engine.releaseThread?.(id, slot)).catch(() => {}) } catch { /* best effort */ } }
      const stop = () => settle.reject(fail('INTERNAL_TURN_TIMEOUT', 'Internal turn timed out'))
      timer = setTimer(stop, Math.max(1, timeoutMs)); timer?.unref?.()
      signal?.addEventListener?.('abort', stop, { once: true })
      done.catch(() => {})
      const work = (async () => {
        const forked = await engine.forkThread({ threadId: parentThreadId, excludeTurns: true, ephemeral: true }, slot)
        const id = forked?.thread?.id
        if (typeof id !== 'string' || !id || id === parentThreadId) throw fail('INTERNAL_TURN_FAILED', 'No fork id')
        if (over) { release(id); return } // the deadline passed while the fork was pending: do not use it
        forkId = id
        live.set(id, collector)
        await engine.startTurn({ threadId: id, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: `egdesk-internal:${randomUUID()}` }, slot)
      })()
      work.then(() => {}, error => settle.reject(error))
      try { return { text: await done } } finally {
        over = true
        clearTimer(timer)
        if (forkId) release(forkId)
      }
    },
  }
}
