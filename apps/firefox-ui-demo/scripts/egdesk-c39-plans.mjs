#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildConflictPairPlan, buildContradictionPairsPlan } from '../helper/egdesk-c39-plans.mjs'

// Writes the two prepared plans of L7 c39 under <dir>/<set>/{plan.json,requests/}. It only writes files; it never sends. Main runs each with scripts/egdesk-decision-real-measure.mjs after approval.
//   node scripts/egdesk-c39-plans.mjs <dir>
const dir = process.argv[2]
if (!dir) { console.error('usage: egdesk-c39-plans.mjs <output directory>'); process.exit(2) }
for (const build of [buildConflictPairPlan, buildContradictionPairsPlan]) {
  const { plan, files, estInputTokens } = await build()
  const out = path.join(dir, plan.set)
  mkdirSync(path.join(out, 'requests'), { recursive: true })
  for (const { file, bytes } of files) writeFileSync(path.join(out, file), bytes)
  writeFileSync(path.join(out, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`)
  console.log(JSON.stringify({ set: plan.set, requests: plan.requests.map(r => `${r.id}:${r.estInputTokens}`), estInputTokens, tokenCeiling: plan.tokenCeiling }))
}
