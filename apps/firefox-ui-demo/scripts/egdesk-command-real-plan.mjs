#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildCommandRiskPlanV2 } from '../helper/egdesk-command-risk-plan.mjs'

// Builds the command-gate re-measurement plan (set command-risk-v2) and, with --out <dir>, writes it (plan.json, requests/*.json,
// cases.json). It sends nothing and reads no key. Run the plan with the generic runner after the owner approves:
//   node scripts/egdesk-decision-real-measure.mjs <dir>/plan.json            # dry run
// (command-judgments-v1, sent on 2026-11-24, is a frozen record in scripts/real-plans/command-judgments-v1; it is not rebuilt.)
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null
const built = await buildCommandRiskPlanV2()
console.table(built.table)
console.log(JSON.stringify({ set: built.plan.set, ...built.totals, tokenCeiling: built.plan.tokenCeiling,
  floorZeroRequests: built.cases.filter(c => c.floor.length).map(c => `${c.id}: ${c.floor.join('+')}${c.inPlan ? ' (sent as a control)' : ''}`) }, null, 1))
if (out) {
  for (const [name, text] of Object.entries(built.files)) { const file = path.join(out, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
  console.log(`written to ${out}`)
}
