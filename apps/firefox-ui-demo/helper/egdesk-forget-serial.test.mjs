import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

// L49: forgetConversation calls overlap no more: one runs at a time, in arrival order, and a failure does not stop the next.
test('concurrent forgets are serialized and a failure does not block the next', async () => {
  const proto = CodexChatRuntime.prototype
  let inflight = 0, max = 0; const order = []
  const fake = { forgetConversationNow: async (t) => { inflight++; max = Math.max(max, inflight); order.push(t); await new Promise(r => setTimeout(r, 5)); inflight--; if (t === 'b') throw new Error('boom'); return { accepted: true, t } } }
  const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map(t => proto.forgetConversation.call(fake, t)))
  assert.deepEqual(order, ['a', 'b', 'c', 'd']); assert.equal(max, 1)
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
})
