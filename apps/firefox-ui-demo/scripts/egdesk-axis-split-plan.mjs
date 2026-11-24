#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPLIT_DIR, analyzeSplit, buildSplitPlan } from '../helper/egdesk-axis-split-plan.mjs'

// Source/time axis re-measure with the 'split-isolated' design. PREPARED, NOT SENT: this script never sends and never reads a key.
//   node scripts/egdesk-axis-split-plan.mjs                      # rebuild with the product code and compare with the committed files
//   node scripts/egdesk-axis-split-plan.mjs --write              # write chunk-NN/{plan.json,requests/*.json}
//   node scripts/egdesk-axis-split-plan.mjs analyze <results.json>...   # after the owner sent the chunks with the generic runner
// Sending (owner only, one chunk at a time): node scripts/egdesk-decision-real-measure.mjs <dir>/chunk-01/plan.json --send
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', SPLIT_DIR)
const args = process.argv.slice(2)
const built = await buildSplitPlan()
if (args[0] === 'analyze') {
  const merged = {}
  for (const file of args.slice(1)) Object.assign(merged, JSON.parse(readFileSync(file, 'utf8')).results || {})
  const out = analyzeSplit(merged, built.rows)
  for (const r of out.rows) console.log([r.id, r.role, r.answered ? r.label : 'not answered', r.installed ? (r.correct ? 'correct' : 'WRONG') : '-', `allowed ${r.allowed.join('/')}`].join('  '))
  console.log(JSON.stringify({ answered: out.answered, wrong: out.wrong, byRole: out.byRole, pass: out.pass }))
  process.exit(out.pass ? 0 : 1)
}
const write = args.includes('--write')
const files = built.chunks.flatMap(c => [[`${c.dir}/plan.json`, c.planBytes], ...c.files.map(f => [`${c.dir}/${f.file}`, f.bytes])])
let differs = 0
for (const [name, bytes] of files) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
}
for (const c of built.chunks) console.log(`${c.dir}  requests=${c.items.length}  est=${c.est} of ${c.plan.tokenCeiling}  ${c.items.map(r => r.id).join(' ')}`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${files.length} files, ${built.totals.requests} requests, est input tokens ${built.totals.estInputTokens}, largest chunk ${built.totals.maxChunk}`)
process.exitCode = differs ? 1 : 0
