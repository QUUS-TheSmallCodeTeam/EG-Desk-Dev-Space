// The committed real-measurement plans of lane L3 (format and rules: ../egdesk-committed-plans.mjs). Only lane L3 edits this file: APPEND new entries at the END (c33: one list per lane so that two lanes never touch the same lines).
// Every entry here has lane: 'L3' (helper/egdesk-committed-plans.test.mjs checks it).
export const PLANS_L3 = [
  // single-file plans
  { path: 'helper/egdesk-heartbeat-real-plan.snapshot.json', lane: 'L3', rebuilt: { heartbeat: true } },
  ...['c15', 'c16', 'c17'].map(c => ({ path: `helper/egdesk-heartbeat-real-plan.${c}.json`, lane: 'L3', frozen: `the ${c} heartbeat registration as measured (2026-11-24); helper/egdesk-heartbeat-real-plan.test.mjs` })),
]
