#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildMemoryFirstReplayPlan, replayTimingReport } from '../helper/egdesk-c41-replay.mjs'

// L7 c41: the Decisions-only replay of the memory-first layer. It only writes files (and reads a results file); it never sends. Main runs the plan with scripts/egdesk-decision-real-measure.mjs after approval.
//   node scripts/egdesk-c41-replay.mjs plan <dir>          writes <dir>/memory-first-replay-v1/{plan.json,requests/}
//   node scripts/egdesk-c41-replay.mjs report <results.json> [plan.json]   prints per-request and per-turn-start timing against the turn-context budgets
const [mode, target, planFile] = process.argv.slice(2)
if (mode === 'plan' && target) {
  const { plan, files, estInputTokens } = await buildMemoryFirstReplayPlan()
  const out = path.join(target, plan.set)
  mkdirSync(path.join(out, 'requests'), { recursive: true })
  for (const { file, bytes } of files) writeFileSync(path.join(out, file), bytes)
  writeFileSync(path.join(out, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`)
  console.log(JSON.stringify({ set: plan.set, requests: plan.requests.map(r => `${r.id}:${r.estInputTokens}`), estInputTokens, tokenCeiling: plan.tokenCeiling }))
} else if (mode === 'report' && target) {
  const results = JSON.parse(readFileSync(target, 'utf8')), plan = planFile ? JSON.parse(readFileSync(planFile, 'utf8')) : null
  console.log(replayTimingReport(results, plan).text)
} else { console.error('usage: egdesk-c41-replay.mjs plan <dir> | report <results.json> [plan.json]'); process.exit(2) }
