import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOARD_AGENT_RELEVANCE_BAR } from './egdesk-board-agent-context.mjs'
import { SKELETON_BARS } from './egdesk-briefing-skeleton.mjs'
import { BEAT_PREDICATE_YES } from './egdesk-heartbeat-judge.mjs'
import { RISK_PREDICATE_NO } from './egdesk-terminal-command-gate.mjs'
import { SPEECH_THRESHOLDS } from './egdesk-speech-grounding.mjs'
import { barFor, productVerdict } from './egdesk-product-bars.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('product bars: read from the product constants, with the action boundary of each family', () => {
  assert.equal(barFor({ set: 'board-reply-screening-v2', q: 'c3', kind: 'predicate' }).yesAt, BOARD_AGENT_RELEVANCE_BAR)
  assert.equal(barFor({ set: 'heartbeat-c18', q: 'message__note', kind: 'predicate' }).yesAt, BEAT_PREDICATE_YES)
  assert.equal(barFor({ set: 'command-risk-v2', q: 'risk_outside', kind: 'predicate' }).noAt, RISK_PREDICATE_NO)
  assert.equal(barFor({ set: 'l4-briefing-coverage-facts', q: 'onboard_F2', kind: 'predicate' }).noAt, SKELETON_BARS.no)
  assert.equal(barFor({ set: 'l4-briefing-relevance', q: 'slot_P3_r2', kind: 'predicate' }).yesAt, SKELETON_BARS.yes)
  assert.deepEqual([barFor({ set: 'utterance-threshold-v1/chunk-03', q: 'speech_time_0', kind: 'choice' }).c, barFor({ set: 'utterance-threshold-v1/chunk-03', q: 'speech_time_0', kind: 'choice' }).m], [SPEECH_THRESHOLDS.confidence, SPEECH_THRESHOLDS.margin])
  assert.equal(barFor({ set: 'nothing-known', q: 'x_1', kind: 'predicate' }).fallback, true)
  assert.equal(barFor({ set: 'nothing-known', q: 'x_1', kind: 'predicate' }, { fallback: false }), null)
})

test('product verdict: single-threshold families have no undecided zone; three-state families do; choices need confidence and margin', () => {
  const v = (set, q, kind, rest) => productVerdict({ set, q, kind, verdict: 'x', ...rest })
  assert.equal(v('heartbeat-c18', 'message__note', 'predicate', { p: 0.79, expect: 'no' }), 'decided-correct')
  assert.equal(v('heartbeat-c18', 'message__note', 'predicate', { p: 0.79, expect: 'yes' }), 'decided-wrong')
  assert.equal(v('record-confirmation-predicates-v1', 'rc_confirms_0', 'predicate', { p: 0.5, expect: 'no' }), 'undecided')
  assert.equal(v('command-risk-v2', 'risk_unrestorable', 'predicate', { p: 0.21, expect: 'yes' }), 'decided-correct', 'approval is asked above .2')
  assert.equal(v('l4-briefing-coverage', 'covers', 'predicate', { p: 0.46, expect: 'no' }), 'decided-wrong', 'only <= .3 reworks the board')
  assert.equal(v('utterance-threshold-v1/chunk-01', 'speech_source_0', 'choice', { choice: 'inference', expected: ['inference'], confidence: 0.84, margin: 0.8 }), 'undecided')
  assert.equal(v('utterance-threshold-v1/chunk-01', 'speech_source_0', 'choice', { choice: 'inference', expected: ['unspecified'], confidence: 0.86, margin: 0.8 }), 'decided-wrong')
  assert.equal(productVerdict({ set: 'heartbeat-c18', q: 'message__note', kind: 'predicate', verdict: 'not-answered' }), 'not-answered')
  assert.equal(productVerdict({ set: 'command-judgments-v1', q: 'terminal_risk', kind: 'score', verdict: 'decided-wrong' }), 'decided-wrong')
})

test('product bars: every hard predicate/choice check of every committed plan has a product bar (no fallback)', () => {
  const plans = []
  const walk = d => { for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) { if (e !== 'requests') walk(p) } else if (e === 'plan.json') plans.push(p) } }
  walk(path.join(root, 'proofs')); walk(path.join(root, 'scripts', 'real-plans'))
  const missing = []
  for (const file of plans) {
    const plan = JSON.parse(readFileSync(file, 'utf8'))
    for (const r of plan.requests) for (const e of r.expect || []) if (e.severity === 'hard' && (e.kind === 'predicate' || e.kind === 'choice') && !barFor({ set: plan.set, q: e.name, kind: e.kind }, { fallback: false })) missing.push(`${plan.set} ${e.name}`)
  }
  assert.ok(plans.length >= 10)
  assert.deepEqual([...new Set(missing)], [])
})
