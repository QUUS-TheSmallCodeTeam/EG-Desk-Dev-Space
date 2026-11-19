import test from 'node:test'
import assert from 'node:assert/strict'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { DECISION_CONTEXT_KEY, prepareTurnContext } from './egdesk-context-setup.mjs'

const handle = 'memrow:2d817f04-fb38-4dbc-8409-cf9f9ff69f22'
const item = { id: handle, kind: 'memory-evidence', label: 'CLIENT_LABEL', url: 'https://example.invalid/CLIENT_URL' }
const client = { decide: async ({ questions }) => ({ model: 'synthetic', latencyMs: 1, usage: {}, answers: Object.fromEntries(questions.map(q => {
  const value = q.name === 'time_intent' ? 'present' : 'answer'
  return [q.name, q.type === 'choice' ? { type: 'choice', choice: value, confidence: 1, probabilities: [{ value, probability: 1 }] } : { type: 'predicate', probability: 0.02 }]
})) }) }
const assemble = (candidates, options) => prepareTurnContext({ message: '지금 몇 개야?', candidates, client, ...options })
const collect = async (body, memoryEvidenceFor) => (await collectDecisionCandidates({ body, memoryEvidenceFor })).candidates
const entry = access => collect({ selectedSources: [item] }, () => access)
const publicPart = r => JSON.stringify([r.receipt, r.selected, r.extraContext])

test('reserved selections never become ordinary attachments or expose a supplied caption or URL', async () => {
  assert.deepEqual(await collect({ selectedSources: [item, { ...item, id: 'memrow:bad' }, { ...item, id: 'ordinary' }], attachments: [item] }), [])
  const seen = []; const ok = { mayRead: () => true, loadText: () => '{"v":1}' }
  const cs = await collect({ selectedSources: [item, item], attachments: [item] }, ref => { seen.push(ref); return ok })
  assert.deepEqual(seen, [handle]); assert.equal(cs.length, 1)
  assert.doesNotMatch(publicPart(await assemble(cs)), /memrow:|CLIENT_LABEL|CLIENT_URL/)
})

test('a guarded read that fails, is withdrawn mid-load or cannot fit is omitted whole, not replaced with a misleading summary', async () => {
  for (const read of [async () => null, async () => { throw Error('private failure detail') }, async () => '   ']) {
    const r = await assemble(await entry({ mayRead: () => true, loadText: read }))
    assert.equal(r.status, 'empty'); assert.doesNotMatch(publicPart(r), /private failure|연결한 원본 기록/)
  }
  let active = true
  const late = await assemble(await entry({ mayRead: () => active, loadText: () => { active = false; return 'WITHDRAWN' } }))
  assert.equal(late.status, 'empty')
  for (const budget of [{ itemChars: 10 }, { maxChars: 30 }]) {
    const r = await assemble(await entry({ mayRead: () => true, loadText: () => '{"full":"PRIVATE_DETAIL"}' }), budget)
    assert.equal(r.status, 'empty'); assert.doesNotMatch(publicPart(r), /PRIVATE_DETAIL|truncated|연결한 원본/)
  }
})

test('final check covers every guarded attachment, even a grant that disappears during a later async read', async () => {
  let first = true, second = true
  const a = (await entry({ mayRead: () => first, loadText: () => '{"v":"A"}' }))[0]
  const b = { ...a, id: 'memory-selection:1', mayRead: () => second, loadText: () => { first = false; return '{"v":"B"}' } }
  const r = await assemble([a, b]); assert.equal(r.status, 'ready'); assert.match(r.extraContext[DECISION_CONTEXT_KEY], /"v":"B"/)
  assert.equal(r.mayDispatch(), false); assert.doesNotMatch(JSON.stringify(r.receipt), /mayDispatch|memrow:|"v"/)
})
