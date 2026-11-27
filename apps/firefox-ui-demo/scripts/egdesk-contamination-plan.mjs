#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTAMINATION_DIR, buildContaminationPlan } from '../helper/egdesk-contamination-plan.mjs'

// The contamination study plan (declarative format of scripts/egdesk-decision-real-measure.mjs). Sends nothing, reads no key.
//   node scripts/egdesk-contamination-plan.mjs            # rebuild and compare with the committed files
//   node scripts/egdesk-contamination-plan.mjs --write    # write plan.json, design.json and requests/<id>.json
//   node scripts/egdesk-contamination-plan.mjs analyze <results.json>   # after the owner/Main sent it
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', CONTAMINATION_DIR)
const args = process.argv.slice(2)
if (args[0] === 'analyze') {
  const { analyzeContamination } = await import('../helper/egdesk-contamination-plan.mjs')
  const design = JSON.parse(readFileSync(path.join(dir, 'design.json'), 'utf8')), results = JSON.parse(readFileSync(args[1], 'utf8')).results
  console.log(JSON.stringify(analyzeContamination(design, results), null, 1))
  process.exit(0)
}
const write = args.includes('--write')
const built = await buildContaminationPlan()
const files = [['plan.json', built.planBytes], ['design.json', built.designBytes], ...built.files.map(f => [f.file, f.bytes])]
let differs = 0
for (const [name, bytes] of files) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
}
for (const r of built.requests) console.log(`${r.id.padEnd(22)} est=${String(r.spec.estInputTokens).padStart(4)}  ${r.items.map(i => `${i.name}:${i.side}`).join(' ')}  sha256=${r.spec.sha256.slice(0, 12)}`)
console.log(`split cost (est tokens, 3 items): ${JSON.stringify(built.splitCost)}`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${files.length} files, ${built.totals.requests} requests, est input tokens ${built.totals.estInputTokens} of ceiling ${built.plan.tokenCeiling}; nothing was sent`)
process.exitCode = differs ? 1 : 0
