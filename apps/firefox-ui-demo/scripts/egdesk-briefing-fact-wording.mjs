#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FACT_WORDING_DIR, buildFactWordingPlan } from '../helper/egdesk-briefing-fact-wording.mjs'
import { loadPlan, scoreRequest } from '../helper/egdesk-decision-real-runner.mjs'

// The coverage fact wording measure (lane L4 c49). Sends nothing, reads no key, starts no engine.
//   node scripts/egdesk-briefing-fact-wording.mjs                       # rebuild and compare with the committed files
//   node scripts/egdesk-briefing-fact-wording.mjs --write               # write plan.json and requests/fact-wording.json
//   node scripts/egdesk-briefing-fact-wording.mjs --score <results.json>   # the four wordings' probabilities, and the hard checks
// Main sends it: OPENAI_API_KEY=... node scripts/egdesk-decision-real-measure.mjs proofs/decision-real-measure/briefing-fact-wording/plan.json --send --out results.json
const args = process.argv.slice(2), at = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', FACT_WORDING_DIR)
if (at('--score')) {
  const plan = loadPlan(path.join(dir, 'plan.json')), file = JSON.parse(readFileSync(at('--score'), 'utf8')), results = file.results ?? file, row = scoreRequest(plan.requests[0], results[plan.requests[0].id])
  console.log(`${row.id} ${row.state}  hard ${row.hard?.passed}/${row.hard?.total}  soft ${row.soft?.passed}/${row.soft?.total}`)
  for (const c of row.checks ?? []) console.log(`  ${c.pass ? 'pass' : 'FAIL'} ${c.severity.padEnd(4)} ${c.name} p=${c.observed?.probability}`)
  process.exit(row.hardFailures?.length ? 1 : 0)
}
const write = args.includes('--write'), built = buildFactWordingPlan()
let differs = 0
for (const [name, bytes] of [['plan.json', built.planBytes], ...built.files.map(f => [f.file, f.bytes])]) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${FACT_WORDING_DIR}/${name}`) } }
}
console.log(`== fact wording (${FACT_WORDING_DIR})`)
console.log(`${built.requests[0].id}  est=${built.requests[0].estInputTokens}  sha256=${built.requests[0].sha256.slice(0, 12)}  ${built.requests[0].expect.length} checks (${built.requests[0].expect.filter(e => e.severity === 'hard').length} hard)`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${built.files.length + 1} files, ${built.totals.requests} request, ${built.totals.questions} questions, ${built.totals.bytes} bytes, est input tokens ${built.totals.estInputTokens} of ceiling ${built.plan.tokenCeiling}`)
process.exit(differs && !write ? 1 : 0)
