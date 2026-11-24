#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildCommandRealPlan } from '../helper/egdesk-command-real-plan.mjs'

// Builds the command-judgment measurement plan and, with --out <dir>, writes it (plan.json, requests/*.json, score-expectations.json,
// verified-no-request.json). It sends nothing and reads no key. Run the plan with the generic runner after the owner approves:
//   node scripts/egdesk-decision-real-measure.mjs <dir>/plan.json            # dry run
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null
const built = await buildCommandRealPlan()
console.table(built.table)
console.log(JSON.stringify({ set: built.plan.set, ...built.totals, tokenCeiling: built.plan.tokenCeiling, verifiedNoRequest: built.verified.map(v => `${v.id}: ${v.settledBy}`) }, null, 1))
if (out) {
  for (const [name, text] of Object.entries(built.files)) { const file = path.join(out, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }
  console.log(`written to ${out}`)
}
