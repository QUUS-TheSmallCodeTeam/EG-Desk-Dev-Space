#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WM_PLAN_DIR, buildWorkingMemoryPlan } from '../helper/egdesk-working-memory-real-plan.mjs'

// The working-memory judge measurement plan (declarative format of scripts/egdesk-decision-real-measure.mjs). Sends nothing, reads no key.
//   node scripts/egdesk-working-memory-real-plan.mjs            # rebuild with the product code and compare with the committed files
//   node scripts/egdesk-working-memory-real-plan.mjs --write    # write plan.json and requests/<id>.json
// Exit codes: 0 the committed plan is what the product builds today (or it was written), 1 it differs.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', WM_PLAN_DIR)
const write = process.argv.includes('--write')
const built = await buildWorkingMemoryPlan()
const files = [['plan.json', built.planBytes], ...built.requests.map(r => [r.file, r.bytes])]
let differs = 0
for (const [name, bytes] of files) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
}
for (const [n, r] of built.requests.entries()) console.log(`${r.id}  bytes=${r.bytes.length}  predicates=${r.body.questions.length}  est=${built.plan.requests[n].estInputTokens}  sha256=${built.plan.requests[n].sha256.slice(0, 12)}`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${files.length} files, est input tokens ${built.totals.estInputTokens} of ceiling ${built.plan.tokenCeiling}; nothing was sent`)
process.exitCode = differs ? 1 : 0
