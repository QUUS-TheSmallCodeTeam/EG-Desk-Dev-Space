// L7 c25: L6's evidence v7 flags L3 scenarios-v2 triage_recall-985c1f528cd9c757 ("오전 6시에 작업 중지 예약 걸었지?", real c27: need .99, recall .13,
// courtesy 0, record .01, nothing held) as "would skip the fetch". The product does not: the fetch is skipped only on a decided courtesy yes, or a
// decided need NO with held pages shown and the stored list complete. tn_recall is not a skip trigger (it only matters to the legacy c11 rule, which
// still needs need NO). On these numbers the product fetches.
import test from 'node:test'
import assert from 'node:assert/strict'
import { triageSkipsFetch, triageTurn } from './egdesk-turn-memory.mjs'

const recorded = { tn_courtesy: 0, tn_need: 0.99, tn_recall: 0.13, tn_record: 0.01 }
const answers = Object.fromEntries(Object.entries(recorded).map(([name, probability]) => [name, { type: 'predicate', probability }]))
const triage = async held => triageTurn({ message: '오전 6시에 작업 중지 예약 걸었지?', heldTitles: Array.from({ length: held }, (_, i) => `held ${i}`), stored: Array.from({ length: 12 }, (_, i) => ({ title: `page ${i}`, time: 'past', status: 'done' })),
  client: { async decide() { return { answers, usage: {} } } }, askedAt: Date.parse('2026-11-25T10:00:00+09:00') })

test('need .99 / recall .13 (decided no) / courtesy 0: the product fetches, with or without held pages, under both rules', async () => {
  for (const held of [0, 3]) {
    const t = await triage(held)
    assert.deepEqual([t.need.state, t.recall.state, t.courtesy.state], ['yes', 'no', 'no'])
    for (const options of [{}, { legacyRecall: true }, { heldExcerpts: false }]) assert.equal(triageSkipsFetch(t, { skipOnNeed: true, ...options }), false, JSON.stringify({ held, ...options }))
  }
})

test('the same recall .13 with a decided need NO and held pages is what skips (so recall alone never does)', async () => {
  const t = await triage(3)
  assert.equal(triageSkipsFetch({ ...t, need: { state: 'no', p: 0.02 } }), true)
  assert.equal(triageSkipsFetch({ ...t, need: { state: 'no', p: 0.02 }, held: 0 }), false, 'nothing held: no skip')
  assert.equal(triageSkipsFetch({ ...t, recall: { state: 'yes', p: 0.99 } }), false, 'recall yes does not skip either')
})
