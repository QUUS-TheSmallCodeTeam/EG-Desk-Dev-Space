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
export function createInternalTurns({ idle = 120_000 } = {}) {
  const live = new Map() // forkThreadId -> collector
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
    async run({ engine, slot, parentThreadId, text, timeoutMs = 20000, signal = null }) {
      if (!engine?.forkThread || !engine.startTurn) throw Object.assign(new Error('Engine cannot run an internal turn'), { code: 'INTERNAL_TURN_UNSUPPORTED' })
      let forkId = null, timer = null
      const fail = (code, message) => Object.assign(new Error(message), { code })
      let settle = null
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
      const stop = () => settle.reject(fail('INTERNAL_TURN_TIMEOUT', 'Internal turn timed out'))
      timer = setTimeout(stop, Math.max(1, timeoutMs)); timer.unref?.()
      signal?.addEventListener?.('abort', stop, { once: true })
      done.catch(() => {}) // a rejection before anyone awaits it is handled below
      try {
        const forked = await engine.forkThread({ threadId: parentThreadId, excludeTurns: true, ephemeral: true }, slot)
        forkId = forked?.thread?.id
        if (typeof forkId !== 'string' || !forkId || forkId === parentThreadId) throw fail('INTERNAL_TURN_FAILED', 'No fork id')
        live.set(forkId, collector)
        await engine.startTurn({ threadId: forkId, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: `egdesk-internal:${randomUUID()}` }, slot)
        return { text: await done }
      } finally {
        clearTimeout(timer)
        if (forkId) { live.delete(forkId); try { void Promise.resolve(engine.releaseThread?.(forkId, slot)).catch(() => {}) } catch { /* best effort */ } }
      }
    },
  }
}
