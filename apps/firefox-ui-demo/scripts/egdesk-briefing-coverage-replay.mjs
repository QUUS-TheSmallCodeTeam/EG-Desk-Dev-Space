#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COVERAGE_REPLAY_DIR, buildCoverageReplayPlan } from '../helper/egdesk-briefing-coverage-replay.mjs'
import { loadPlan, scoreRequest } from '../helper/egdesk-decision-real-runner.mjs'

// The coverage re-measure of the layer replay (lane L4 c48). Sends nothing, reads no key, starts no engine.
//   node scripts/egdesk-briefing-coverage-replay.mjs                          # rebuild and compare with the committed files
//   node scripts/egdesk-briefing-coverage-replay.mjs --write                  # write plan.json and requests/<id>.json
//   node scripts/egdesk-briefing-coverage-replay.mjs --score <results.json> [--plan <plan.json>]   # score a runner results file against a committed plan (default: this one): per request, hard / soft, each check's probability
// Main sends it with the runner: node scripts/egdesk-decision-real-measure.mjs proofs/decision-real-measure/briefing-coverage-replay/plan.json --send --out <results.json>
const args = process.argv.slice(2), at = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), dir = path.join(root, COVERAGE_REPLAY_DIR)
if (at('--score')) {
  const plan = loadPlan(at('--plan') ? path.resolve(at('--plan')) : path.join(dir, 'plan.json')), file = JSON.parse(readFileSync(at('--score'), 'utf8')), results = file.results ?? file
  let hard = 0
  for (const request of plan.requests) {
    const row = scoreRequest(request, results[request.id])
    console.log(`${request.id.padEnd(18)} ${row.state}${row.hard ? `  hard ${row.hard.passed}/${row.hard.total}  soft ${row.soft.passed}/${row.soft.total}` : ''}${row.hardFailures?.length ? `  HARD FAILED: ${row.hardFailures.join(',')}` : ''}`)
    for (const c of row.checks ?? []) console.log(`    ${c.pass ? 'pass' : 'FAIL'} ${c.severity.padEnd(4)} ${c.name} p=${c.observed?.probability}${c.notDecidedNo ? ` (> ${c.above})` : c.min !== undefined ? ` (>= ${c.min})` : c.max !== undefined ? ` (<= ${c.max})` : ''}`)
    hard += row.hardFailures?.length ?? 0
  }
  console.log(`hard failures: ${hard}`)
  process.exit(hard ? 1 : 0)
}
const write = args.includes('--write'), built = await buildCoverageReplayPlan()
let differs = 0
for (const [name, bytes] of [['plan.json', built.planBytes], ...built.files.map(f => [f.file, f.bytes])]) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${COVERAGE_REPLAY_DIR}/${name}`) } }
}
console.log(`== coverage replay (${COVERAGE_REPLAY_DIR})`)
for (const r of built.requests) console.log(`${r.id.padEnd(18)} est=${String(r.estInputTokens).padStart(5)}  sha256=${r.sha256.slice(0, 12)}  ${r.expect.length} checks (${r.expect.filter(e => e.severity === 'hard').length} hard)`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${built.files.length + 1} files, ${built.totals.requests} requests, ${built.totals.questions} questions, ${built.totals.bytes} bytes, est input tokens ${built.totals.estInputTokens} of ceiling ${built.plan.tokenCeiling}`)
console.log(`values of each fact that are not on the recorded board: ${JSON.stringify(built.evidence.map(e => [e.fact, e.absentValues.length]))}`)
process.exit(differs && !write ? 1 : 0)
