// L7 c24: previous_reply (EGDESK_TURN_MEMORY_PREVIOUS_REPLY) and the held-record pruning (EGDESK_TURN_MEMORY_PRUNE_HELD) assume the answering
// model still holds the earlier turns. With the all-on world's fake app-server emitting the Codex 0.171 signals by their exact names
// (thread/compacted, item/completed contextCompaction, thread/reverted), after a bridge restart (a new process: nothing in memory, the thread
// is resumed with thread/resume) and on a fork, both must close. Offline.
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld, DM } from './egdesk-all-on.support.mjs'
import { SAYS } from './egdesk-all-on-live-measure.mjs'

const ENV = { EGDESK_TURN_MEMORY_PREVIOUS_REPLY: 'on', EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_DRAFT_CHECK: 'off' }
const PREV_LINE = 'The assistant\'s message right before this one'
async function world(t) {
  const w = allOnWorld(t, { env: ENV })
  await w.settings.turnMemory.save('on')
  await w.send(SAYS.quote); await w.answer('A사 견적은 v1 발송 후 v2 수정 계획 단계입니다. 더 볼까요?')
  return w
}
// one more turn; what its turn_context and triage requests carried
async function turn(w, text = SAYS.tidy) {
  const before = w.decisions.length
  await w.send(text)
  const rows = w.decisions.slice(before)
  const ctx = rows.find(d => /"answer_type"/.test(d.raw)), triage = rows.find(d => /"tn_need"/.test(d.raw))
  const catalog = ctx ? (JSON.parse(ctx.raw).input.map(m => JSON.stringify(m.content)).join('').match(/#\d+ \|/g) ?? []).length : null
  await w.answer('정리했습니다. 다음으로 갈까요?')
  return { carried: [ctx, triage].filter(Boolean).map(d => d.raw.includes(PREV_LINE)), catalog }
}
const cid = w => w.state.lastOf.get(DM).conversationId

test('live thread: the previous message is carried and the records the first turn sent are not asked about again', async t => {
  const w = await world(t)
  const r = await turn(w)
  assert.deepEqual(r.carried, [true, true])
  assert.ok(r.catalog < 12, `held records pruned (${r.catalog} of 12 asked)`)
})

for (const [name, signal] of [
  ['thread/compacted', w => w.notify('thread/compacted', { threadId: cid(w), turnId: w.timing().turnId })],
  ['item/completed contextCompaction', w => w.notify('item/completed', { threadId: cid(w), turnId: w.timing().turnId, item: { id: 'cc-1', type: 'contextCompaction' } })],
  ['item/started contextCompaction', w => w.notify('item/started', { threadId: cid(w), turnId: w.timing().turnId, item: { id: 'cc-2', type: 'contextCompaction' } })],
  ['thread/reverted', w => w.notify('thread/reverted', { threadId: cid(w) })],
]) {
  test(`${name}: the next turn carries no previous message and prunes nothing`, async t => {
    const w = await world(t)
    await signal(w)
    const r = await turn(w)
    assert.deepEqual(r.carried, [false, false])
    assert.equal(r.catalog, 12, 'every record is asked about again')
    const again = await turn(w, SAYS.tidy) // the turn after: the model holds that new reply in its live thread again
    assert.ok(again.carried.every(Boolean))
  })
}

test('bridge restart (a new process: nothing in memory) + thread/resume: closed for that turn, open again on the next live turn', async t => {
  const w = await world(t)
  // what a new bridge process does not have: loaded threads, compaction notes and every delivery receipt (the store persists)
  for (const m of [w.chat.loadedThreads, w.chat.compactedThreads, w.chat.turnMemoryDelivered, w.chat.turnMemoryShadow, w.chat.contextDelivered, w.chat.turnMemoryLatest]) m.clear()
  const resumes = () => w.native.filter(c => c.method === 'thread/resume').length, before = resumes()
  const r = await turn(w)
  assert.ok(resumes() > before, 'the thread was resumed through thread/resume')
  assert.deepEqual(r.carried, [false, false])
  assert.equal(r.catalog, 12)
  const next = await turn(w, SAYS.tidy)
  assert.ok(next.carried.every(Boolean), 'live again after this process followed a turn')
})

test('fork: the branch\'s first turn has no previous message and no receipts', async t => {
  const w = await world(t)
  const forked = await w.chat.fork({ conversationId: cid(w), clientThreadId: 'dm-fork' })
  const context = { engine: { id: 'codex' }, conversationId: forked.conversationId, clientThreadId: 'dm-fork' }
  assert.equal(w.chat.turnPosition(context).reason === 'live_thread', false)
  assert.equal(w.chat.previousReplyFor(context, null), null)
  assert.equal(w.chat.contextDelivered.get(forked.conversationId), undefined)
  assert.equal(w.chat.turnMemoryDelivered.get(forked.conversationId), undefined)
})
