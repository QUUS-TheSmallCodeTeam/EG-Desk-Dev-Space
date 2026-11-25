#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildOwnStatementPlan } from '../helper/egdesk-own-statement-plan.mjs'

// Writes the plan own-statement-v1: <dir>/plan.json and <dir>/requests/<id>.json. It only writes files; it never sends. Main runs it (after approval) with scripts/egdesk-decision-real-measure.mjs.
//   node scripts/egdesk-own-statement-plan.mjs <dir>
const dir = process.argv[2]
if (!dir) { console.error('usage: egdesk-own-statement-plan.mjs <output directory>'); process.exit(2) }
const { plan, files, estInputTokens } = await buildOwnStatementPlan()
mkdirSync(path.join(dir, 'requests'), { recursive: true })
for (const { file, bytes } of files) writeFileSync(path.join(dir, file), bytes)
writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`)
console.log(JSON.stringify({ set: plan.set, requests: plan.requests.map(r => `${r.id}:${r.estInputTokens}`), estInputTokens, tokenCeiling: plan.tokenCeiling }))
