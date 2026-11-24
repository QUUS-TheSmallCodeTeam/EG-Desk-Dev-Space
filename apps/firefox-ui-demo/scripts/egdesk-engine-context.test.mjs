// L7 c32: what the engine shows of the entries, and what the draft check believes the answering model saw (L3 relies on it). Scripted world; the fake engine validates every
// request against the 0.171 schema (a bad additionalContext would fail the run). emulateSpill() is the test double of the engine's cut.
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld } from './egdesk-all-on.support.mjs'
import { SAYS } from './egdesk-all-on-live-measure.mjs'
import { emulateSpill } from '../helper/egdesk-engine-context.mjs'

const LIMIT = 1000
const entryOf = w => [...w.chat.runs.values()].map(run => w.chat.draftCheckTurns.get(run)).filter(Boolean).at(-1)
async function first(t, mode) {
  const env = { EGDESK_TURN_MEMORY_ONE_PACKET: 'on', ...(mode ? { EGDESK_TURN_MEMORY_ENGINE_CONTEXT: mode, EGDESK_TURN_MEMORY_ENGINE_CHARS: String(LIMIT) } : {}) }
  const w = allOnWorld(t, { env })
  await w.settings.turnMemory.save('on')
  await w.send(SAYS.quote)
  const ctx = w.turnStarts().at(-1).params.additionalContext
  const ids = text => [...new Set([...text.matchAll(/\[item id=ontology:([^\s\]]+)/g)].map(m => m[1]))]
  return { w, ctx, entry: entryOf(w), keys: Object.keys(ctx).filter(k => k.startsWith('egdesk_decision_context')), sizes: Object.fromEntries(Object.entries(ctx).map(([k, v]) => [k, v.value.length])), ids }
}

test('off (default): one entry as before; it is over the limit, the engine would cut it, and the draft check still counts its items as seen (the behaviour this flag changes)', async t => {
  const { ctx, keys, sizes, entry, ids } = await first(t, null)
  assert.deepEqual(keys, ['egdesk_decision_context']); assert.ok(sizes.egdesk_decision_context > LIMIT)
  const cut = emulateSpill(ctx, { limit: LIMIT })
  assert.deepEqual(cut.spilled, ['egdesk_decision_context']); assert.ok(ids(Object.values(cut.visible).join('\n')).length < ids(ctx.egdesk_decision_context.value).length, 'items are lost in the middle')
  assert.ok(entry.evidence.some(item => !item.opaque), 'evidence is item text')
})

test('mark: the entry is unchanged, and the draft check no longer counts items inside it as seen (they become one opaque reference, as do the memory items)', async t => {
  const off = await first(t, null), { ctx, keys, entry } = await first(t, 'mark')
  assert.deepEqual(keys, ['egdesk_decision_context']); assert.equal(ctx.egdesk_decision_context.value, off.ctx.egdesk_decision_context.value, 'the same bytes as without the flag')
  assert.ok(off.entry.evidence.length > 0 && off.entry.memory.length > 0)
  assert.ok(entry.evidence.every(item => item.opaque), JSON.stringify(entry.evidence)); assert.ok(entry.evidence.length >= 1)
  assert.deepEqual(entry.memory, [], 'memory pages rode in the cut entry: not evidence')
})

test('split: parts that each stay under the limit, the same text in the same order, every item seen by the engine; the draft check keeps its item evidence', async t => {
  const off = await first(t, null), { ctx, keys, sizes, entry, ids } = await first(t, 'split')
  assert.ok(keys.length > 1, keys.join()); for (const key of keys) assert.ok(sizes[key] <= LIMIT, `${key} ${sizes[key]}`)
  assert.deepEqual(emulateSpill(ctx, { limit: LIMIT }).spilled, [], 'nothing is cut')
  const joined = keys.map(k => ctx[k].value.replace(/^EG-Desk context, continued[^\n]*\n\n/, '')).join('\n\n')
  assert.equal(joined, off.ctx.egdesk_decision_context.value)
  assert.deepEqual(ids(Object.values(emulateSpill(ctx, { limit: LIMIT }).visible).join('\n')), ids(off.ctx.egdesk_decision_context.value))
  assert.deepEqual(entry.evidence.map(i => i.id), off.entry.evidence.map(i => i.id)); assert.deepEqual(entry.memory.map(i => i.id), off.entry.memory.map(i => i.id))
})
