// L7 c25: (1) turn memory's own receipts count only on a LIVE thread; (2) after thread/resume the engine's turns (the resume response and the
// thread/turns/list pages, Codex 0.171) are compared with EG-Desk's own record of the conversation: a turn EG-Desk did not run (another Codex
// client continued the thread in the person's Codex home), or a history that cannot be compared, makes the thread not live: no previous_reply,
// no receipts, no held pruning, and the next turn is a first turn for memory purposes until that turn's loop re-sent what it needs. Offline.
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld, DM } from './egdesk-all-on.support.mjs'
import { SAYS } from './egdesk-all-on-live-measure.mjs'
import { deriveTurnPosition, usableReceipts } from '../helper/egdesk-turn-memory.mjs'

const ENV = { EGDESK_TURN_MEMORY_PREVIOUS_REPLY: 'on', EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_DRAFT_CHECK: 'off' }
const done = id => ({ id, status: 'completed', items: [] }) // a finished engine turn, as the engine reports it
const PREV_LINE = 'The assistant\'s message right before this one'
const cid = w => w.state.lastOf.get(DM).conversationId
const ownTurnIds = w => { const out = []; let after = 0; for (;;) { const p = w.chat.store.listRuns(DM, { afterSeq: after, limit: 100 }); out.push(...p.runs.map(r => r.runId).filter(Boolean)); if (!p.hasMore) return out; after = p.nextCursor } }
async function world(t) {
  const w = allOnWorld(t, { env: ENV })
  await w.settings.turnMemory.save('on')
  await w.send(SAYS.quote); await w.answer('A사 견적은 v1 발송 후 v2 수정 계획 단계입니다. 더 볼까요?')
  return w
}
async function turn(w, text = SAYS.tidy) {
  const before = w.decisions.length
  await w.send(text)
  const rows = w.decisions.slice(before)
  const ctx = rows.find(d => /"answer_type"/.test(d.raw)), triage = rows.find(d => /"tn_need"/.test(d.raw))
  const catalog = ctx ? (JSON.parse(ctx.raw).input.map(m => JSON.stringify(m.content)).join('').match(/#\d+ \|/g) ?? []).length : null
  const memory = (w.turnStarts().at(-1).params.additionalContext ?? {}).egdesk_turn_memory?.value ?? ''
  await w.answer('정리했습니다. 다음으로 갈까요?')
  return { carried: [ctx, triage].filter(Boolean).map(d => d.raw.includes(PREV_LINE)), catalog, memory }
}
// a bridge restart: the process has loaded nothing and holds no receipts (the store persists)
const restart = w => { for (const m of [w.chat.loadedThreads, w.chat.compactedThreads, w.chat.foreignThreads, w.chat.turnMemoryDelivered, w.chat.turnMemoryShadow, w.chat.contextDelivered, w.chat.turnMemoryLatest]) m.clear() }

test('receipts: usable only on a live thread (not resumed, not first, not compacted, not foreign)', () => {
  const delivered = { usable: true, threadKey: 't', pages: { p: { revision: 'r', hash: 'h' } } }
  const pos = args => deriveTurnPosition({ threadId: 't', priorCompletedTurns: 2, ...args })
  assert.equal(usableReceipts(delivered, pos({}), 't').usable, true)
  assert.equal(usableReceipts(delivered, pos({ resumed: true }), 't').usable, false)
  assert.equal(usableReceipts(delivered, pos({ compacted: true }), 't').usable, false)
  assert.equal(usableReceipts(delivered, pos({ foreign: true }), 't').usable, false)
  assert.deepEqual(pos({ foreign: true }), { kind: 'first', reason: 'foreign_turns' })
  assert.deepEqual(pos({ compacted: true, foreign: true }), { kind: 'first', reason: 'context_compacted' })
})

test('resume where the engine holds exactly the turns EG-Desk ran: continuous, so the thread is live again from the next turn', async t => {
  const w = await world(t)
  w.appServer.turns = () => ownTurnIds(w).map(done)
  restart(w)
  const r1 = await turn(w); assert.deepEqual(r1.carried, [false, false], 'the resumed turn itself is closed (not yet followed by this process)')
  assert.equal(w.chat.foreignThreads.has(cid(w)), false)
  const r2 = await turn(w); assert.ok(r2.carried.every(Boolean))
})

test('resume where the engine holds a turn EG-Desk did not run: not live; the next turn is a first turn and re-sends; live after it', async t => {
  const w = await world(t)
  w.appServer.turns = () => [...ownTurnIds(w).map(done), done('turn-from-another-client')]
  restart(w)
  const r1 = await turn(w)
  assert.equal(w.chat.foreignReason, 'unknown_turn')
  assert.deepEqual(r1.carried, [false, false])
  assert.equal(w.chat.foreignThreads.has(cid(w)), true, 'the resumed turn does not spend the mark')
  assert.equal(w.chat.turnPosition({ engine: { id: 'codex' }, conversationId: cid(w), clientThreadId: DM }).reason, 'foreign_turns')
  const r2 = await turn(w)
  assert.deepEqual(r2.carried, [false, false], 'still closed for the first turn that re-sends')
  assert.equal(r2.catalog, 12, 'nothing is pruned as already held')
  assert.equal(w.chat.foreignThreads.has(cid(w)), false, 'spent by the first-turn loop')
  const r3 = await turn(w)
  assert.ok(r3.carried.every(Boolean), 'live again once memory was re-sent')
})

test('a paginated history: the pages of thread/turns/list are compared too', async t => {
  const w = await world(t)
  const own = ownTurnIds(w)
  w.appServer.turns = () => [done(own.at(-1))]
  w.appServer.cursor = () => 'older'
  w.appServer.list = params => (params.cursor === 'older' ? { data: [done(own[0])], nextCursor: 'oldest' } : { data: [done('turn-from-another-client')], nextCursor: null })
  restart(w)
  await turn(w)
  assert.deepEqual(w.appServer.listCalls.slice(0, 2).map(c => c.cursor), ['older', 'oldest'], 'both pages, in order (the runtime resumes twice per turn today, c24)')
  assert.ok(w.appServer.listCalls.every(c => c.itemsView === 'notLoaded' && c.threadId === cid(w)))
  assert.equal(w.chat.foreignReason, 'unknown_turn', 'the foreign turn was on the second page')
  // and a paginated history that is entirely EG-Desk's own is continuous
  const w2 = await world(t)
  const own2 = ownTurnIds(w2)
  w2.appServer.turns = () => []; w2.appServer.cursor = () => 'c1'
  w2.appServer.list = () => ({ data: own2.map(done), nextCursor: null })
  restart(w2)
  await turn(w2)
  assert.equal(w2.chat.foreignThreads.has(cid(w2)), false)
})

test('a history that cannot be compared (listing fails, or too long) is treated as foreign', async t => {
  const w = await world(t)
  w.appServer.turns = () => []; w.appServer.cursor = () => 'c1'; w.appServer.fail = true
  restart(w)
  await turn(w)
  assert.equal(w.chat.foreignReason, 'check_failed')
  assert.equal(w.chat.foreignThreads.has(cid(w)), true)
  const w2 = await world(t)
  w2.appServer.turns = () => []; w2.appServer.cursor = () => 'again'; w2.appServer.list = () => ({ data: [], nextCursor: 'again' }) // never ends
  restart(w2)
  await turn(w2)
  assert.equal(w2.chat.foreignReason, 'history_too_long')
})

test('no record to compare with (an engine turn and no store run for it): foreign', async t => {
  const w = await world(t)
  w.appServer.turns = () => [done('turn-we-never-bound')]
  restart(w)
  await turn(w)
  assert.equal(w.chat.foreignReason, 'unknown_turn')
})

test('foreign marking clears the receipts a reload inside one process would still hold', async t => {
  const w = await world(t)
  await turn(w)
  const sentinel = { usable: true, threadKey: cid(w), pages: { 'ontology:sentinel': { revision: 'r', hash: 'h' } } }
  w.chat.turnMemoryDelivered.set(cid(w), sentinel); w.chat.turnMemoryShadow.set(cid(w), sentinel); w.chat.contextDelivered.set(cid(w), new Map([['ontology:sentinel', 'key']]))
  w.appServer.turns = () => [...ownTurnIds(w).map(done), done('turn-from-another-client')]
  w.chat.loadedThreads.delete(cid(w)) // the thread is dropped and resumed in the same process (mustReload)
  await turn(w)
  assert.equal(w.chat.foreignReason, 'unknown_turn')
  assert.equal(w.chat.turnMemoryDelivered.get(cid(w))?.pages?.['ontology:sentinel'], undefined)
  assert.equal(w.chat.turnMemoryShadow.get(cid(w))?.pages?.['ontology:sentinel'], undefined)
  assert.equal(w.chat.contextDelivered.get(cid(w))?.has('ontology:sentinel') ?? false, false)
})
