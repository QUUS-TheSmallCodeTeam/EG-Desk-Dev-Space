// The committed real-measurement plans of lane L1 (format and rules: ../egdesk-committed-plans.mjs). Only lane L1 edits this file: APPEND new entries at the END (c33: one list per lane so that two lanes never touch the same lines).
// Every entry here has lane: 'L1' (helper/egdesk-committed-plans.test.mjs checks it).
export const PLANS_L1 = [
  { path: 'proofs/decision-real-measure/board-reply-screening', lane: 'L1', rebuilt: { script: 'egdesk-board-reply-real-plan.mjs', matches: 3 } },
  { path: 'proofs/decision-real-measure/hud-routing', lane: 'L1', rebuilt: { builder: ['./egdesk-hud-routing-real-plan.mjs', 'buildHudPlan'] } },
  { path: 'proofs/decision-real-measure/l1-remeasure-c13', lane: 'L1', rebuilt: { script: 'egdesk-board-reply-real-plan.mjs', matches: 3 } },
  { path: 'proofs/decision-real-measure/work-placement', lane: 'L1', rebuilt: { script: 'egdesk-board-reply-real-plan.mjs', matches: 3 } },
  ...['', '-v2', '-v3', '-v4'].map(v => ({ path: `scripts/egdesk-multiuser-live-measure.plan${v}.json`, lane: 'L1', handWritten: 'collaboration scenario plan (written by hand; the live runner builds bodies at run time)' })),
]
