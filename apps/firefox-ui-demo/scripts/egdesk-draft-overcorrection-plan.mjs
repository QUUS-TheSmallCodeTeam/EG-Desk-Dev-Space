#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OVERCORRECTION_DIR, analyzeOvercorrection, buildOvercorrectionPlan } from '../helper/egdesk-draft-overcorrection-plan.mjs'

// Draft check over-correction plan. Sends nothing, reads no key.
//   node scripts/egdesk-draft-overcorrection-plan.mjs [--write]            # rebuild (compare / write)
//   node scripts/egdesk-draft-overcorrection-plan.mjs analyze <results>    # replay the real answers through the product's checkDraft
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', OVERCORRECTION_DIR)
const args = process.argv.slice(2)
if (args[0] === 'analyze') {
  const out = await analyzeOvercorrection(JSON.parse(readFileSync(args[1], 'utf8')).results)
  console.log(JSON.stringify({ answered: out.answered, missing: out.missing, correct: out.correct, wrong: out.wrong, drafts: out.drafts }, null, 1))
  process.exit(0)
}
const write = args.includes('--write')
const built = await buildOvercorrectionPlan()
const files = [['plan.json', built.planBytes], ...built.files.map(f => [f.file, f.bytes])]
let differs = 0
for (const [name, bytes] of files) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
}
for (const r of built.requests) console.log(`${r.id.padEnd(16)} est=${String(r.estInputTokens).padStart(4)}  hard=${r.expect.filter(e => e.severity === 'hard').length}  sha256=${r.sha256.slice(0, 12)}`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${files.length} files, ${built.totals.requests} drafts, ${built.totals.correct} correct + ${built.totals.wrong} wrong sentences, est input tokens ${built.totals.estInputTokens} of ${built.plan.tokenCeiling}; nothing was sent`)
process.exitCode = differs ? 1 : 0
