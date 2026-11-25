// The committed real-measurement plans of lane L5 (format and rules: ../egdesk-committed-plans.mjs). Only lane L5 edits this file: APPEND new entries at the END (c33: one list per lane so that two lanes never touch the same lines).
// Every entry here has lane: 'L5' (helper/egdesk-committed-plans.test.mjs checks it).
export const PLANS_L5 = [
  // scripts/real-plans
  { path: 'scripts/real-plans/command-judgments-v1', lane: 'L5', frozen: 'sent 2026-11-24; a frozen record integrity-checked by helper/egdesk-command-real-plan.test.mjs' },
  { path: 'scripts/real-plans/command-risk-v2', lane: 'L5', rebuilt: { builder: ['./egdesk-command-risk-plan.mjs', 'buildCommandRiskPlanV2'] } },
  { path: 'scripts/real-plans/run-conditions-v1', lane: 'L5', rebuilt: { builder: ['./egdesk-run-conditions-plan.mjs', 'buildRunConditionsPlan'] } },
]
