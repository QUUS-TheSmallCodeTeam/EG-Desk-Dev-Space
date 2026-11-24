#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildConfirmationPlan } from '../helper/egdesk-confirmation-plan.mjs'

// Writes the declarative measurement plan of the conversational confirmation: <dir>/plan.json and <dir>/requests/<id>.json.
// It only writes files; it never sends. Main runs it (after approval) with scripts/egdesk-decision-real-measure.mjs.
//   node scripts/egdesk-confirmation-plan.mjs <dir>
const dir = process.argv[2]
if (!dir) { console.error('usage: egdesk-confirmation-plan.mjs <output directory>'); process.exit(2) }
const { plan, files, estInputTokens } = await buildConfirmationPlan()
mkdirSync(path.join(dir, 'requests'), { recursive: true })
for (const { file, bytes } of files) writeFileSync(path.join(dir, file), bytes)
writeFileSync(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`)
console.table(plan.requests.map(r => ({ id: r.id, bytes: files.find(f => f.file === r.file).bytes.length, estInputTokens: r.estInputTokens, hard: r.expect.filter(e => e.severity === 'hard').length, soft: r.expect.filter(e => e.severity === 'soft').length, sha: r.sha256.slice(0, 12) })))
console.log(JSON.stringify({ set: plan.set, requests: plan.requests.length, estInputTokens, tokenCeiling: plan.tokenCeiling }))
