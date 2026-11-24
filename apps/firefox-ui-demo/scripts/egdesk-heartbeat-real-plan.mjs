#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEARTBEAT_NOT_SENT, HEARTBEAT_PATTERNS, buildHeartbeatPlan, codeOnlyCases, planFile } from '../helper/egdesk-heartbeat-real-plan.mjs'

// Writes the real-measurement plan for the heartbeat judgments. It SENDS NOTHING and reads no key: the request bodies are built by
// the product code from scripted fact patterns (helper/egdesk-heartbeat-real-plan.mjs) and saved for the generic runner
// (scripts/egdesk-decision-real-measure.mjs), which is the only thing that may send them, after approval.
//   node scripts/egdesk-heartbeat-real-plan.mjs                 # print the plan table
//   node scripts/egdesk-heartbeat-real-plan.mjs --out DIR       # DIR/plan.json, DIR/requests/<id>.json (exact bytes), DIR/preregistration.json
//   node scripts/egdesk-heartbeat-real-plan.mjs --check DIR     # rebuild and compare with DIR (plan.json and every request file's sha256)
//   node scripts/egdesk-heartbeat-real-plan.mjs --snapshot      # rewrite helper/egdesk-heartbeat-real-plan.snapshot.json (a new registration)
const args = process.argv.slice(2)
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const plan = await buildHeartbeatPlan()
const file = planFile(plan)
const text = `${JSON.stringify(file, null, 1)}\n`
console.table(plan.requests.map(r => ({ id: r.id, path: r.path, bytes: r.bytes, estInputTokens: r.estInputTokens, hard: r.expect.filter(e => e.severity === 'hard').length, soft: r.expect.filter(e => e.severity === 'soft').length, sha: r.sha256.slice(0, 12) })))
console.log(JSON.stringify({ set: plan.set, requests: plan.requests.length, estInputTokens: plan.requests.reduce((n, r) => n + r.estInputTokens, 0), tokenCeiling: plan.tokenCeiling }))
let failed = false
const out = value('--out')
if (out) {
  mkdirSync(path.join(out, 'requests'), { recursive: true })
  for (const r of plan.requests) writeFileSync(path.join(out, r.file), r.body) // exactly the bytes the product would POST; sha256 is of this file
  writeFileSync(path.join(out, 'plan.json'), text)
  writeFileSync(path.join(out, 'preregistration.json'), `${JSON.stringify({ sent: plan.requests.map(r => ({ id: r.id, path: r.path, pattern: r.pattern, ...(r.codeRule ? { codeRule: r.codeRule } : {}), before: r.before, expect: r.expect, ifMissed: r.ifMissed })),
    changedNotSent: HEARTBEAT_NOT_SENT, decidedByCode: await codeOnlyCases() }, null, 1)}\n`)
  console.log(`wrote ${plan.requests.length} requests, plan.json and preregistration.json to ${out}`)
}
const check = value('--check')
if (check) {
  const saved = JSON.parse(readFileSync(path.join(check, 'plan.json'), 'utf8'))
  if (JSON.stringify(saved) !== JSON.stringify(file)) { console.error('plan.json differs from what the product builds now'); failed = true }
  for (const r of plan.requests) if (sha(readFileSync(path.join(check, r.file))) !== r.sha256) { console.error(`${r.file} differs`); failed = true }
  if (!failed) console.log(`${check} matches: ${plan.requests.length} requests`)
}
if (args.includes('--snapshot')) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  writeFileSync(path.join(here, '../helper/egdesk-heartbeat-real-plan.snapshot.json'), text)
  console.log(`snapshot rewritten (${HEARTBEAT_PATTERNS.length} patterns)`)
}
process.exit(failed ? 2 : 0)
