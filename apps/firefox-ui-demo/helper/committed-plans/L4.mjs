// The committed real-measurement plans of lane L4 (format and rules: ../egdesk-committed-plans.mjs). Only lane L4 edits this file: APPEND new entries at the END (c33: one list per lane so that two lanes never touch the same lines).
// Every entry here has lane: 'L4' (helper/egdesk-committed-plans.test.mjs checks it).
export const PLANS_L4 = [
  { path: 'proofs/decision-real-measure/briefing-coverage', lane: 'L4', rebuilt: { script: 'egdesk-briefing-coverage-plan.mjs', matches: 2 } },
  { path: 'proofs/decision-real-measure/briefing-coverage-facts', lane: 'L4', rebuilt: { script: 'egdesk-briefing-coverage-plan.mjs', matches: 2 } },
  { path: 'proofs/decision-real-measure/briefing-layer-replay', lane: 'L4', rebuilt: { script: 'egdesk-briefing-layer-replay.mjs', matches: 1 } },
]
