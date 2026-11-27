#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HYBRID_DIR, analyzeHybrid, buildHybridPlan } from '../helper/egdesk-axis-hybrid-plan.mjs'

// The 'hybrid-isolated' re-measure (6 requests). PREPARED, NOT SENT: this script never sends and never reads a key.
//   node scripts/egdesk-axis-hybrid-plan.mjs [--write]            # rebuild / write plan.json and requests/*.json
//   node scripts/egdesk-axis-hybrid-plan.mjs analyze <results.json> # after the owner sent it with the generic runner
// Sending (owner only): node scripts/egdesk-decision-real-measure.mjs proofs/decision-real-measure/axis-hybrid/plan.json --send
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', HYBRID_DIR)
const args = process.argv.slice(2), built = await buildHybridPlan()
if (args[0] === 'analyze') {
  const merged = {}
  for (const file of args.slice(1)) Object.assign(merged, JSON.parse(readFileSync(file, 'utf8')).results || {})
  const out = analyzeHybrid(merged, built.rows)
  for (const r of out.rows) console.log([r.id, r.role, r.answered ? r.label : 'not answered', r.installed ? (r.correct ? 'correct' : 'WRONG') : '-', `allowed ${r.allowed.join('/')}`].join('  '))
  console.log(JSON.stringify({ wrong: out.wrong, controls: out.controls, pass: out.pass }))
  process.exit(out.pass ? 0 : 1)
}
const write = args.includes('--write')
let differs = 0
for (const [name, bytes] of [['plan.json', built.planBytes], ...built.files.map(f => [f.file, f.bytes])]) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
}
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${built.rows.length} requests (${built.rows.map(r => `${r.id}:${r.estInputTokens}`).join(' ')}), est input tokens ${built.est} of ${built.plan.tokenCeiling}`)
process.exitCode = differs ? 1 : 0
