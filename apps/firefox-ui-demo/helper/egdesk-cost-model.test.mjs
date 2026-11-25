// L6 c20: the per-feature cost model. Synthetic journey and rows only.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS } from './codex-chat-runtime.mjs'
import { COMMAND_GATE_TIMEOUT_MS } from './egdesk-terminal-command-gate.mjs'
import { DRAFT_CHECK_LIMITS } from './egdesk-draft-check.mjs'
import { COST_FEATURES, CUMULATIVE_ORDER, TURN_CLASSES, buildCostModel, classOf } from './egdesk-cost-model.mjs'

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const req = (family, tokens, ms, q = 2) => ({ family, usage: { input_tokens: tokens }, elapsedMs: ms, questions: Array.from({ length: q }, (_, i) => ({ name: `q${i}` })) })
const journey = { steps: [
  { id: 's1', title: 'first', sends: [{ inRun: false }], requests: [req('turn_context', 2600, 420, 14), req('memory_triage', 900, 280, 4), req('memory_fetch', 3000, 400, 12), req('draft_check', 700, 240)] },
  { id: 's2', title: 'follow-up', sends: [{ inRun: false }], requests: [req('turn_context', 1700, 340, 9), req('memory_triage', 1500, 680, 5), req('draft_check', 800, 260)] },
  { id: 's3', title: 'briefing', sends: [], requests: [req('briefing', 1000, 250), req('briefing', 1100, 270)] },
  { id: 's4', title: 'in-run message', sends: [{ inRun: true }], requests: [req('heartbeat', 860, 245, 3)] },
  { id: 's5', title: 'idle step', sends: [], requests: [] },
] }
const rows = [
  { src: 'runner', set: 'hud-routing-v1', tokens: 700, elapsedMs: 1600, questions: 4, first: true },
  { src: 'runner', set: 'hud-routing-v1', tokens: 780, elapsedMs: 260, questions: 4, first: false },
  { src: 'runner', set: 'hud-routing-v1', tokens: 770, elapsedMs: 280, questions: 4, first: false },
  { src: 'runner', set: 'hud-routing-v1', tokens: 99999, elapsedMs: 99999, questions: 4, first: false, repeat: true },
  { src: 'journey', set: 'hud-routing-v1', tokens: 99999, elapsedMs: 99999, questions: 4 },
  { src: 'runner', set: 'some-other-set', tokens: 5, elapsedMs: 5, questions: 1 },
]

test('journey figures: per occurrence, per turn, cumulative in the order flags are turned on, and per step by where a request sits', () => {
  const m = buildCostModel({ journey, requests: rows })
  assert.deepEqual([m.turns, m.inRun, m.journeyTotal.requests, m.journeyTotal.tokens], [2, 1, 10, 2600 + 900 + 3000 + 700 + 1700 + 1500 + 800 + 1000 + 1100 + 860])
  const by = id => m.flags.find(f => f.id === id)
  const ctx = by('decisionContext').journey
  assert.deepEqual([ctx.requests, ctx.perTurn, ctx.tokens, ctx.tokensPerTurn, ctx.perRequest.tokensMedian, ctx.perRequest.msRange], [2, 1, 4300, 2150, 1700, [340, 420]])
  const mem = by('turnMemory').journey
  assert.deepEqual([mem.requests, mem.tokens, mem.steps], [3, 5400, ['s1', 's2']])
  assert.deepEqual([by('briefing').journey.requests, by('briefing').journey.perTurn], [2, 1])
  assert.equal(by('terminalGate').journey, null, 'no journey request of a family the journey never asked')
  // cumulative: each row adds one feature's families
  assert.deepEqual(m.cumulative.map(r => r.requests), [2, 5, 5, 7, 8, 8, 10, 10, 10])
  assert.equal(m.cumulative[0].tokensPerTurn, 2150); assert.equal(m.cumulative.at(-1).tokens, m.journeyTotal.tokens)
  // steps: the classes
  const s1 = m.steps.find(x => x.step === 's1'), s3 = m.steps.find(x => x.step === 's3'), s4 = m.steps.find(x => x.step === 's4')
  assert.deepEqual([s1.userSend, s1.pre.requests, s1.pre.tokens, s1.pre.msMax, s1.pre.msSum, s1.post.requests], ['turn', 3, 6500, 420, 1100, 1])
  assert.deepEqual([s3.userSend, s3.post.requests, s3.post.msSum], ['-', 2, 520])
  assert.deepEqual([s4.userSend, s4.run.requests], ['in-run', 1])
  assert.equal(m.steps.some(x => x.step === 's5'), false, 'a step with no request is not listed')
})

test('plan figures: only the current runner rows of the feature\'s sets, first request apart from the warm ones, repeats and journey rows ignored', () => {
  const m = buildCostModel({ journey, requests: rows })
  const hud = m.flags.find(f => f.id === 'hudRouting').plans
  assert.deepEqual([hud.requests, hud.sets, hud.perRequest.tokensMedian, hud.perRequest.msWarmMedian, hud.perRequest.msFirstMedian, hud.perRequest.tokensRange], [3, ['hud-routing-v1'], 770, 260, 1600, [700, 780]])
  assert.equal(m.flags.find(f => f.id === 'decisionContext').plans, null)
})

test('a journey without a user turn is refused (no per-turn figure can be made)', () => {
  assert.throws(() => buildCostModel({ journey: { steps: [{ id: 's', sends: [], requests: [] }] } }), RangeError)
})

test('the latency bounds are the ones the code enforces (imported, not retyped), and every cited file exists', () => {
  const by = id => COST_FEATURES.find(f => f.id === id)
  assert.deepEqual(by('decisionContext').latency.boundsMs, { warm: TURN_CONTEXT_BUDGET_MS, cold: TURN_CONTEXT_COLD_BUDGET_MS })
  assert.equal(by('terminalGate').latency.boundsMs.request, COMMAND_GATE_TIMEOUT_MS)
  assert.equal(by('draftCheck').latency.boundsMs.first, DRAFT_CHECK_LIMITS.firstCheckMs)
  assert.match(by('decisionContext').latency.text, /1,200 ms warm \/ 1,800 ms cold/)
  assert.match(by('draftCheck').latency.text, /first check up to 1,500 ms, a re-check up to 1,200 ms/)
  assert.match(by('conversationFlow').latency.text, /A beat every 5 s .* not before 10 s, at least 30 s apart, at most 3 per run/)
  for (const f of COST_FEATURES) {
    assert.ok(['blocks', 'path', 'card', 'after', 'none'].includes(f.latency.cls), f.id)
    const files = f.latency.at.match(/(?:helper|overlay)\/[\w./-]+\.(?:mjs|js)/g) ?? []
    assert.ok(files.length > 0, `${f.id} cites no file`)
    for (const file of files) assert.ok(existsSync(path.join(app, file)), `${f.id} cites ${file}, which does not exist`)
  }
  assert.equal(new Set(COST_FEATURES.map(f => f.id)).size, COST_FEATURES.length)
})

test('every family a feature asks for belongs to a turn class, and the cumulative order covers every journey family a feature lists', () => {
  const classed = new Set(Object.values(TURN_CLASSES).flat())
  for (const f of COST_FEATURES) for (const fam of f.families) assert.notEqual(classOf(fam), 'other', `${fam} (${f.id}) has no turn class`)
  const cumulative = new Set(CUMULATIVE_ORDER.flatMap(([, list]) => list))
  for (const f of COST_FEATURES) for (const fam of f.families) assert.ok(cumulative.has(fam) || !classed.has(fam), `${fam} missing from the cumulative order`)
  assert.equal(classOf('unknown_family'), 'other')
})
