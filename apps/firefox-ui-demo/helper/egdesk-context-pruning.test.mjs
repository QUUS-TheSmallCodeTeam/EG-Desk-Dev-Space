// Code-first reduction of the context selection's candidates (egdesk-context-pruning.mjs) and the selection's delivery keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pruneContextCandidates } from './egdesk-context-pruning.mjs'
import { contextDeliveryKey, prepareTurnContext } from './egdesk-context-setup.mjs'
import { pagesFromCandidates } from './egdesk-wiki-adapter.mjs'
import { sha256Hex } from './egdesk-decision-questions.mjs'

const doc = (id, text, extra = {}) => ({ id, kind: 'timeline', title: `title ${id}`, summary: `summary ${id}`, timeSlice: 'past', status: 'done', loadText: () => text, ...extra })

test('a record the selection sent earlier and that is unchanged is not asked about again; a changed one is', async () => {
  const a = doc('ontology:a', 'body a'), b = doc('ontology:b', 'body b')
  const sent = new Map([['ontology:a', await contextDeliveryKey(a)], ['ontology:b', await contextDeliveryKey(doc('ontology:b', 'body b (older)'))]])
  const { kept, pruned } = await pruneContextCandidates([a, b, doc('ontology:c', 'body c')], { sent })
  assert.deepEqual(pruned, [{ id: 'ontology:a', reason: 'held' }])
  assert.deepEqual(kept.map(c => c.id), ['ontology:b', 'ontology:c'])
})

test('the delivery key the selection returns is the key of the same candidate read again (no text in the receipt)', async () => {
  const a = doc('ontology:a', 'body a'), b = doc('ontology:b', 'body b')
  const client = { async decide(request) {
    const answers = {}
    for (const q of request.questions) answers[q.name] = q.type === 'predicate' ? { type: 'predicate', probability: q.name === 'rel_0' ? 0.99 : 0.01 }
      : { type: 'choice', choice: q.choices[0].value, confidence: 0.99, probabilities: [{ value: q.choices[0].value, probability: 0.99 }] }
    return { answers, model: 'gpt-6-luna', usage: { input_tokens: 1 }, latencyMs: 1 }
  } }
  const out = await prepareTurnContext({ message: '질문', candidates: [a, b], client })
  assert.equal(out.status, 'ready')
  assert.deepEqual([...out.deliveredKeys.keys()], ['ontology:a'])
  assert.equal(out.deliveredKeys.get('ontology:a'), await contextDeliveryKey(a))
  assert.ok(!Object.keys(out).includes('deliveredKeys'), 'never enumerable: not copied into receipts or history')
  assert.ok(!JSON.stringify(out).includes(out.deliveredKeys.get('ontology:a')))
})

test('a record turn memory delivered earlier is held only while its revision and content key still match', async () => {
  const a = doc('ontology:a', 'body a')
  const [page] = await pagesFromCandidates([a])
  const same = { 'ontology:a': { revision: page.revision, hash: page.contentKey ?? sha256Hex(page.body) } }
  assert.deepEqual((await pruneContextCandidates([a], { memoryReceipts: same })).pruned, [{ id: 'ontology:a', reason: 'held' }])
  const stale = { 'ontology:a': { revision: page.revision, hash: sha256Hex('another body') } }
  assert.deepEqual((await pruneContextCandidates([a], { memoryReceipts: stale })).kept.map(c => c.id), ['ontology:a'])
})

test('guarded, mandatory and local items are never pruned, whatever the receipts say', async () => {
  const guarded = doc('evidence:1', 'g', { mayRead: () => true }), mandatory = doc('pin:1', 'm', { mandatory: true })
  const local = [doc('memory-lookup:0', 'l', { mayRead: () => true }), doc('conversation:recent', 'r', { mayRead: () => true })]
  const all = [guarded, mandatory, ...local]
  const sent = new Map(await Promise.all(all.map(async c => [c.id, await contextDeliveryKey({ ...c, mayRead: undefined })])))
  const { kept, pruned } = await pruneContextCandidates(all, { sent })
  assert.deepEqual(pruned, [])
  assert.deepEqual(kept.map(c => c.id), all.map(c => c.id))
  assert.equal(await contextDeliveryKey(guarded), null, 'a guarded row has no delivery key')
})

test('no receipts: nothing is pruned and the order is kept', async () => {
  const list = [doc('ontology:a', 'a'), doc('ontology:b', 'b')]
  const { kept, pruned } = await pruneContextCandidates(list, {})
  assert.deepEqual(kept, list)
  assert.deepEqual(pruned, [])
})

test('the turn-memory config carries pruneHeld and keepLate only when the bridge passes them (default off)', async () => {
  const { createTurnMemoryConfig } = await import('./egdesk-turn-memory-wiring.mjs')
  const base = { settings: { turnMemory: { mode: 'on' } }, getAdapter: () => ({}) }
  const off = createTurnMemoryConfig(base), on = createTurnMemoryConfig({ ...base, pruneHeld: true, keepLate: true })
  assert.equal(Object.hasOwn(off, 'pruneHeld') || Object.hasOwn(off, 'keepLate'), false)
  assert.deepEqual([on.pruneHeld, on.keepLate], [true, true])
})
