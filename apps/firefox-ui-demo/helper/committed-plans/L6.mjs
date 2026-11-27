// The committed real-measurement plans of lane L6 (format and rules: ../egdesk-committed-plans.mjs). Only lane L6 edits this file: APPEND new entries at the END (c33: one list per lane so that two lanes never touch the same lines).
// Every entry here has lane: 'L6' (helper/egdesk-committed-plans.test.mjs checks it).
export const PLANS_L6 = [
  { path: 'proofs/decision-real-measure/contamination', lane: 'L6', rebuilt: { script: 'egdesk-contamination-plan.mjs' } },
  { path: 'proofs/decision-real-measure/draft-overcorrection', lane: 'L6', rebuilt: { script: 'egdesk-draft-overcorrection-plan.mjs' } },
  { path: 'proofs/decision-real-measure/turn-context-idle', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs', argv: ['--idle'] } },
  { path: 'proofs/decision-real-measure/turn-context-latency', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs' } },
  { path: 'proofs/decision-real-measure/turn-context-warmup-size', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs', argv: ['--size'] } },
  { path: 'proofs/decision-real-measure/turn-context-warmup-sep', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs', argv: ['--sep'] } },
  { path: 'proofs/decision-real-measure/turn-context-warmup', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs', argv: ['--warmup'] } },
  { path: 'proofs/decision-real-measure/utterance-threshold', lane: 'L6', rebuilt: { script: 'egdesk-utterance-threshold-study.mjs' } },
  { path: 'proofs/decision-real-measure/working-memory-judge', lane: 'L6', rebuilt: { script: 'egdesk-working-memory-real-plan.mjs' } },
  // L6 c24: variants of the all-on journey plan, built from it by scripts/egdesk-journey-variants.mjs (its compare mode prints one "matches" per variant)
  ...['V1', 'V2', 'V3', 'V4'].map(id => ({ path: `scripts/egdesk-all-on-live-measure.plan-v11-variant-${id}.json`, lane: 'L6', rebuilt: { script: 'egdesk-journey-variants.mjs', matches: 4 } })), // c36: V4 = V2 with two wordings fixed (a new pre-registered draw)
]
