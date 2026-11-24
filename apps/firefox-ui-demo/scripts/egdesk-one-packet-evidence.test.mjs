// L7 c29: what EGDESK_TURN_MEMORY_ONE_PACKET (default off) changes in the all-on journey (scripted Decision model, no send), pinned so the owner's evidence
// stays true: the Decision requests (count, families, estimated tokens) and every check are identical; only the packet the engine gets changes, on the turns
// where a page is both a selected item and a memory page (s1, s3b): no page body twice, fewer bytes, one key less. Everything else byte for byte.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PLAN_FILE_V7, loadJourneyPlan, runJourney } from './egdesk-all-on-live-measure.mjs'
import { scriptedDecisions } from './egdesk-all-on.support.mjs'

async function journey(env) {
  const scripted = scriptedDecisions()
  const fetchImpl = async (_url, init) => Response.json({ model: 'gpt-6-luna', answers: await scripted.answer(JSON.parse(typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8'))), usage: { input_tokens: 0, output_tokens: 0 } })
  return runJourney({ plan: loadJourneyPlan(PLAN_FILE_V7), send: true, key: 'egd-synthetic-not-a-key-0029', fetchImpl, env })
}
const sum = list => list.reduce((a, b) => a + b, 0)
const bytes = step => sum(step.seen.packets.flatMap(p => Object.values(p.bytes)))
const dups = step => sum(step.seen.packets.flatMap(p => Object.values(p.copies).map(n => n - 1)))

test('one packet on vs off over the v7 journey: same requests, same checks; only the two turns with a doubled page change, and only for the better', async () => {
  const off = await journey({}), on = await journey({ EGDESK_TURN_MEMORY_ONE_PACKET: 'on' })
  assert.deepEqual(on.scorecard, off.scorecard, 'no outcome change')
  assert.equal(on.steps.length, off.steps.length)
  const changed = []
  for (const [i, a] of off.steps.entries()) {
    const b = on.steps[i]
    assert.equal(b.id, a.id)
    assert.deepEqual(b.requests.map(r => [r.family, r.estInputTokens, r.sha256]), a.requests.map(r => [r.family, r.estInputTokens, r.sha256]), `${a.id}: the Decision requests are byte for byte the same`)
    assert.deepEqual(b.checks.map(c => [c.id, c.pass]), a.checks.map(c => [c.id, c.pass]), `${a.id}: the same checks, the same outcomes (the observed details carry clock times)`)
    assert.deepEqual(b.seen.conversation, a.seen.conversation); assert.deepEqual(b.seen.activityRows, a.seen.activityRows)
    if (bytes(a) !== bytes(b) || dups(a) !== dups(b)) changed.push(a.id)
    assert.equal(dups(b), 0, `${a.id}: no page body twice with one packet`)
  }
  assert.deepEqual(changed, ['s1-first-turn', 's3b-recall'])
  for (const id of changed) {
    const a = off.steps.find(s => s.id === id), b = on.steps.find(s => s.id === id)
    assert.ok(dups(a) > 0, `${id}: off sent a body twice`); assert.ok(bytes(b) < bytes(a), `${id}: fewer bytes`)
    assert.equal(a.seen.packets[0].keys.includes('egdesk_turn_memory'), true); assert.equal(b.seen.packets[0].keys.includes('egdesk_turn_memory'), false)
    assert.deepEqual(b.seen.packets[0].pageIds.sort(), a.seen.packets[0].pageIds.sort(), 'the same pages are named')
  }
})
