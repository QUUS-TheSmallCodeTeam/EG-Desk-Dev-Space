#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORDING_DIR, analyzeWording, buildWordingPlan } from '../helper/egdesk-split-wording-plan.mjs'

// Split wording v2 on the five remaining targets and the five hybrid controls. PREPARED, NOT SENT: never sends, never reads a key.
//   node scripts/egdesk-split-wording-plan.mjs [--write]            # rebuild / write plan.json and requests/*.json
//   node scripts/egdesk-split-wording-plan.mjs analyze <results.json> # after the owner sent it with the generic runner
// Sending (owner only): node scripts/egdesk-decision-real-measure.mjs proofs/decision-real-measure/split-wording/plan.json --send
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', WORDING_DIR)
const args = process.argv.slice(2), built = buildWordingPlan()
if (args[0] === 'analyze') {
  const merged = {}
  for (const file of args.slice(1)) Object.assign(merged, JSON.parse(readFileSync(file, 'utf8')).results || {})
  const out = analyzeWording(merged, built.rows)
  for (const r of out.rows) console.log([r.id, r.role, r.answered ? r.label : 'not answered', r.installed ? (r.correct ? 'correct' : 'WRONG') : '-', `allowed ${r.allowed.join('/')}`].join('  '))
  console.log(JSON.stringify({ wrong: out.wrong, targets: out.targets, guards: out.guards, pass: out.pass }))
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
