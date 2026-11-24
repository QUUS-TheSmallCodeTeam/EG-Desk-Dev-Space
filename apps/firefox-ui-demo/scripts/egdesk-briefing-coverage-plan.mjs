#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRIEFING_COVERAGE_DIR, buildBriefingCoveragePlan } from '../helper/egdesk-briefing-coverage-plan.mjs'

// The briefing coverage re-measure plan (lane L4 cycle 19/20). Sends nothing, reads no key.
//   node scripts/egdesk-briefing-coverage-plan.mjs            # rebuild and compare with the committed files
//   node scripts/egdesk-briefing-coverage-plan.mjs --write    # write plan.json and requests/<id>.json
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', BRIEFING_COVERAGE_DIR)
const write = process.argv.includes('--write')
const built = await buildBriefingCoveragePlan()
let differs = 0
for (const [name, bytes] of [['plan.json', built.planBytes], ...built.files.map(f => [f.file, f.bytes])]) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
}
for (const r of built.requests) console.log(`${r.id.padEnd(18)} est=${String(r.estInputTokens).padStart(4)}  sha256=${r.sha256.slice(0, 12)}  ${r.expect.map(e => `${e.name}:${e.severity}:${e.min !== undefined ? '>=' + e.min : '<=' + e.max}`).join(' ')}`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${built.files.length + 1} files, ${built.totals.requests} requests, ${built.totals.questions} questions, est input tokens ${built.totals.estInputTokens} of ceiling ${built.plan.tokenCeiling}`)
process.exit(differs && !write ? 1 : 0)
