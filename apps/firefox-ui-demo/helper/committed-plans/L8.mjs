// The committed real-measurement plans of lane L8 (format and rules: ../egdesk-committed-plans.mjs). Only lane L8 edits this file: APPEND new entries at the END (c33: one list per lane so that two lanes never touch the same lines).
// Every entry here has lane: 'L8' (helper/egdesk-committed-plans.test.mjs checks it).
export const PLANS_L8 = [
  ...['allon-plan', 'plan', 'plan-delivery', 'plan-holdout', 'plan-holdout-rerun', 'plan-holdout2', 'plan-settings', 'plan-stuck', 'plan-entry', 'plan-entry2', 'plan-entry3', 'plan-holdout2-v2', 'plan-regression', 'plan-settings-error', 'plan-stability', 'plan-statement', 'recorded-plan', 'renamed-plan'].map(v => ({ path: `scripts/egdesk-browser-live-${v}.json`, lane: 'L8', handWritten: 'browser journey plan (written by hand; the live runner builds bodies at run time)' })),
  { path: 'scripts/egdesk-browser-open-item-plan.json', lane: 'L8', handWritten: 'c38: 12 replies after a hand-over for the open browser task option predicates, pre-registered with predictions before any dry run; the requests are the product\'s own (helper/egdesk-browser-open-item-measure.mjs)' },
  { path: 'scripts/egdesk-browser-open-item-plan-v2.json', lane: 'L8', handWritten: 'c40: the same 12 replies as v1 with predictions for the narrowed option wording, pre-registered before the wording change' },
]
