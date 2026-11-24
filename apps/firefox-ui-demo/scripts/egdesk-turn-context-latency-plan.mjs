#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IDLE_DIR, LATENCY_DIR, analyzeIdle, analyzeLatency, buildIdlePlan, buildLatencyPlan } from '../helper/egdesk-turn-context-latency-plan.mjs'

// Turn-context cold/warm latency probe. Sends nothing, reads no key.
//   node scripts/egdesk-turn-context-latency-plan.mjs [--write]
//   node scripts/egdesk-turn-context-latency-plan.mjs analyze <rep-1 results.json> <rep-2 results.json>
// Sending (Main, each repetition in its own process):
//   node scripts/egdesk-decision-real-measure.mjs proofs/decision-real-measure/turn-context-latency/rep-1/plan.json --send --out <rep-1.json>
//   node scripts/egdesk-decision-real-measure.mjs proofs/decision-real-measure/turn-context-latency/rep-2/plan.json --send --out <rep-2.json>
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', LATENCY_DIR)
const args = process.argv.slice(2)
if (args[0] === 'analyze') {
  const out = analyzeLatency(args.slice(1).map(file => JSON.parse(readFileSync(file, 'utf8')).results))
  for (const row of out.rows) console.log(JSON.stringify(row))
  console.log(JSON.stringify(out.byCondition))
  process.exit(0)
}
if (args[0] === 'analyze-idle') { console.log(JSON.stringify(analyzeIdle(args.slice(1).map(file => JSON.parse(readFileSync(file, 'utf8')).results)))); process.exit(0) }
const write = args.includes('--write')
if (args.includes('--idle')) {
  // node scripts/egdesk-turn-context-latency-plan.mjs --idle [--write]: the cycle-15 idle probe (run-A, run-B)
  const idle = await buildIdlePlan(), idleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', IDLE_DIR)
  let diff = 0
  for (const [name, bytes] of idle.runs.flatMap(r => [[`${r.dir}/plan.json`, r.planBytes], ...r.files.map(f => [`${r.dir}/${f.file}`, f.bytes])])) {
    const target = path.join(idleDir, name)
    if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
    else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { diff++; console.log(`differs: ${name}`) } }
  }
  for (const r of idle.runs) console.log(`${r.dir}: ${r.plan.requests.map(x => `${x.id} est=${x.estInputTokens}`).join('  ')}  ceiling ${r.plan.tokenCeiling}`)
  console.log(`${write ? 'written' : diff ? 'DIFFERS' : 'matches'}: ${idle.totals.requests} requests, est input tokens ${idle.totals.estInputTokens}; nothing was sent`)
  process.exit(diff ? 1 : 0)
}
const built = await buildLatencyPlan()
const files = built.reps.flatMap(r => [[`${r.dir}/plan.json`, r.planBytes], ...r.files.map(f => [`${r.dir}/${f.file}`, f.bytes])])
let differs = 0
for (const [name, bytes] of files) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
}
for (const r of built.reps) console.log(`${r.dir}: ${r.plan.requests.map(x => `${x.id}${x.waitBeforeMs ? `(+${x.waitBeforeMs / 1000}s)` : ''} est=${x.estInputTokens}`).join('  ')}  total est ${r.est}`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${files.length} files, ${built.totals.requests} requests, est input tokens ${built.totals.estInputTokens}, ${built.totals.waitMsPerRep / 1000} s of waits per repetition; nothing was sent`)
process.exitCode = differs ? 1 : 0
