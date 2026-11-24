import { randomUUID } from 'node:crypto'

// A short, private turn on a temporary fork of a conversation: the subjective model writes or revises ONE piece of text and
// nothing about the turn reaches the chat (no run, no messages, no activities). Used for the draft check's one revision and for
// the short intermediate messages. Only the final-answer text is read back.
//
//   const turns = createInternalTurns()
//   runtime.handleNotification / handleServerRequest first offer every message to turns.feed(...) / turns.declines(...)
//   await turns.run({ engine, slot, parentThreadId, text, timeoutMs, signal }) → { text }
//
// c24 (Main's smoke-5 on the official 0.171): thread/fork of an EPHEMERAL source thread fails with -32600 "no rollout found for thread id …" (after a
// completed turn, mid-turn and with lastTurnId alike); a persisted source forks fine. So a one-time (ephemeral) room could never run an internal turn.
// When the parent is ephemeral (parentEphemeral), or a fork is refused with "no rollout found", and the caller gave `fresh`, the turn runs on a FRESH
// ephemeral thread instead: thread/start with fresh.overrides() (the pure-engine switches, read-only, never asking, the parent's model; no tools at all)
// plus INTERNAL_INSTRUCTIONS, and the input is fresh.preamble + the caller's text. The fresh thread has not seen the conversation: the preamble says what
// the task needs of it (the person's last message), the caller's text carries the rest (the draft; the heartbeat facts; the briefing's answer, guide and
// materials). Without `fresh` nothing changes: the fork path only. outputSchema goes to turn/start unchanged on either path.
//
// Assumptions that need the real app-server (the mock engine cannot confirm them): thread/fork may copy the parent's completed
// turns (excludeTurns only trims the response); the fork keeps no local history when marked ephemeral; tool and approval requests
// on the fork are declined here, so it cannot act.
// Model-facing text of a fresh internal thread (not user copy). The "private one-off task" words are also how the fake app-server tells such a thread.
export const INTERNAL_INSTRUCTIONS = 'This is a private one-off task for EG-Desk. You have no tools in this thread. Reply with only the text that is asked for.'
export const NO_ROLLOUT = /no rollout found/i

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
    async run({ engine, slot, parentThreadId, text, timeoutMs = 20000, signal = null, outputSchema = null, parentEphemeral = false, fresh = null, onStart = null }) {
      if (!engine?.forkThread || !engine.startTurn) throw fail('INTERNAL_TURN_UNSUPPORTED', 'Engine cannot run an internal turn')
      let forkId = null, timer = null, over = false, settle = null, via = 'fork', selected = { model: null, effort: null, source: null }
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
        let id = null, input = text
        if (!(parentEphemeral && fresh)) {
          try {
            const forked = await engine.forkThread({ threadId: parentThreadId, excludeTurns: true, ephemeral: true }, slot)
            id = forked?.thread?.id
            if (typeof id !== 'string' || !id || id === parentThreadId) throw fail('INTERNAL_TURN_FAILED', 'No fork id')
          } catch (error) {
            // only the one refusal Main saw on 0.171 falls back; any other failure of the fork is the caller's (it falls back to nothing, as before)
            if (!(fresh && typeof engine.startThread === 'function' && NO_ROLLOUT.test(String(error?.message ?? '')))) throw error
            id = null
          }
        }
        if (!id) {
          if (!fresh || typeof engine.startThread !== 'function') throw fail('INTERNAL_TURN_UNSUPPORTED', 'Engine cannot start a fresh internal thread')
          via = 'fresh'
          const overrides = typeof fresh.overrides === 'function' ? await fresh.overrides() : (fresh.overrides ?? {})
          if (over) return
          const started = await engine.startThread({ ...overrides, ephemeral: true, developerInstructions: INTERNAL_INSTRUCTIONS }, slot)
          id = started?.thread?.id
          if (typeof id !== 'string' || !id || id === parentThreadId) throw fail('INTERNAL_TURN_FAILED', 'No internal thread id')
          // never leave a saved thread: an engine that says it kept this one is not used
          if (started.thread.ephemeral === false) { release(id); throw fail('INTERNAL_TURN_FAILED', 'The engine saved the internal thread') }
          input = fresh.preamble ? `${fresh.preamble}\n\n${text}` : text
        }
        if (over) { release(id); return } // the deadline passed while the fork was pending: do not use it
        forkId = id
        live.set(id, collector)
        // outputSchema (cycle 30, the briefing's flag): Codex TurnStartParams.outputSchema constrains this turn's final message. Absent, the params are exactly as before.
        // c25: the room's own model and effort (request > Agent > EG-Desk > the engine's default, resolved by the caller) on every internal turn, fork or fresh: a fork inherits
        // the parent's thread settings, but the effort of a turn is its own (Main's check-9: 20-30 s fill turns ran at the engine's default effort, which was the highest)
        selected = { model: typeof fresh?.model === 'string' && fresh.model ? fresh.model : null, effort: typeof fresh?.effort === 'string' && fresh.effort ? fresh.effort : null, source: fresh?.source ?? null }
        // a fork of the room with no explicit pick (source engine/null) already runs with the thread's own settings: nothing to send, the record still says what it ran with
        const sendSelected = via === 'fresh' || ['explicit', 'request', 'agent', 'egdesk'].includes(selected.source)
        // onStart({ via, model, effort, source }): what this turn is about to run with (the caller's trace); a throwing observer never affects the turn
        try { onStart?.({ via, model: selected.model, effort: selected.effort, source: selected.source }) } catch { /* observer only */ }
        await engine.startTurn({ threadId: id, input: [{ type: 'text', text: input, text_elements: [] }], clientUserMessageId: `egdesk-internal:${randomUUID()}`, ...(outputSchema ? { outputSchema } : {}), ...(sendSelected && selected.model ? { model: selected.model } : {}), ...(sendSelected && selected.effort ? { effort: selected.effort } : {}) }, slot)
      })()
      work.then(() => {}, error => settle.reject(error))
      try { const text = await done; return { text, via, model: selected.model, effort: selected.effort, source: selected.source } } finally {
        over = true
        clearTimer(timer)
        if (forkId) release(forkId)
      }
    },
  }
}
