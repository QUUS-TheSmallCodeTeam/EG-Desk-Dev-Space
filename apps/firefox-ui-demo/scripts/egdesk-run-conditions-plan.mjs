#!/usr/bin/env node
// Builds the real-measurement plan of the condition arbiter's auxiliary predicates (set run-conditions-v1) and, with --out <dir>, writes
// it (plan.json, requests/*.json). It sends nothing and reads no key. Dry run with the generic runner:
//   node scripts/egdesk-decision-real-measure.mjs <dir>/plan.json
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildRunConditionsPlan } from '../helper/egdesk-run-conditions-plan.mjs'
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null
const built = await buildRunConditionsPlan()
console.log(JSON.stringify({ set: built.plan.set, ...built.totals, tokenCeiling: built.plan.tokenCeiling }, null, 1))
if (out) { for (const [name, text] of Object.entries(built.files)) { const file = path.join(out, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) } console.log(`written to ${out}`) }
