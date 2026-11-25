// The committed real-measurement plans of lane L2 (format and rules: ../egdesk-committed-plans.mjs). Only lane L2 edits this file: APPEND new entries at the END (c33: one list per lane so that two lanes never touch the same lines).
// Every entry here has lane: 'L2' (helper/egdesk-committed-plans.test.mjs checks it).
export const PLANS_L2 = [
  { path: 'proofs/decision-real-measure/all-on-s3-faithful-fill', lane: 'L2', handWritten: 'two hand-built s3 requests (161609b); no builder' },
  ...['', '-v2', '-v3', '-v4', '-v5', '-v6', '-v7', '-v8', '-v9', '-v10'].map(v => ({ path: `scripts/egdesk-all-on-live-measure.plan${v}.json`, lane: 'L2', handWritten: 'all-on journey scenario plan (steps and checks written by hand; the live runner builds bodies at run time)' })),
]
