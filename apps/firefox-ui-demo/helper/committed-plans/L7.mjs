// The committed real-measurement plans of lane L7 (format and rules: ../egdesk-committed-plans.mjs). Only lane L7 edits this file: APPEND new entries at the END (c33: one list per lane so that two lanes never touch the same lines).
// Every entry here has lane: 'L7' (helper/egdesk-committed-plans.test.mjs checks it).
export const PLANS_L7 = [
  // proofs/decision-real-measure
  { path: 'proofs/decision-real-measure/action-relevance', lane: 'L7', rebuilt: { script: 'egdesk-action-relevance-plan.mjs' } },
  { path: 'proofs/decision-real-measure/axis-hybrid', lane: 'L7', rebuilt: { script: 'egdesk-axis-hybrid-plan.mjs' } },
  { path: 'proofs/decision-real-measure/axis-split', lane: 'L7', rebuilt: { script: 'egdesk-axis-split-plan.mjs' } },
  { path: 'proofs/decision-real-measure/memory-action', lane: 'L7', frozen: 'memory-action-v1 as sent in c24, superseded by memory-action-v2 (helper/egdesk-speech-hybrid.test.mjs checks the bodies as sent)' },
  { path: 'proofs/decision-real-measure/memory-action-v2', lane: 'L7', rebuilt: { script: 'egdesk-memory-action-v2-plan.mjs' } },
  { path: 'proofs/decision-real-measure/split-wording', lane: 'L7', rebuilt: { script: 'egdesk-split-wording-plan.mjs' } },
]
