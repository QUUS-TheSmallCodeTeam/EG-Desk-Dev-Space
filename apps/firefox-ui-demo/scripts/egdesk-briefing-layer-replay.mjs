#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAYER_REPLAY_DIR, buildLayerReplayPlan, replayLayers } from '../helper/egdesk-briefing-layer-replay.mjs'

// The Decisions-only replay of the briefing's layers on recorded real inputs (lane L4 c46). Sends nothing, reads no key, starts no engine.
//   node scripts/egdesk-briefing-layer-replay.mjs                      # rebuild the plan and compare with the committed files
//   node scripts/egdesk-briefing-layer-replay.mjs --write              # write plan.json and requests/<id>.json
//   node scripts/egdesk-briefing-layer-replay.mjs --results <file>     # feed the runner's results back through the product flow: layers, code-built checks, timings (exit 1 on a hard failure)
// Main sends the plan with the runner: node scripts/egdesk-decision-real-measure.mjs proofs/decision-real-measure/briefing-layer-replay/plan.json --send --out <results.json>
const args = process.argv.slice(2), at = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null)
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', LAYER_REPLAY_DIR)
if (at('--results')) {
  const report = await replayLayers({ results: JSON.parse(readFileSync(at('--results'), 'utf8')) })
  console.log(JSON.stringify({ layers: report.layers, checks: report.checks.map(c => ({ name: c.name, severity: c.severity, pass: c.pass, observed: c.observed })) }, null, 1))
  console.log('== timings (ms): replay request / what check-29br\'s own flow measured for that stage')
  for (const t of report.table) console.log(`${t.id.padEnd(20)} ${String(t.ms).padStart(6)} / ${t.recordedMs}`)
  console.log(`total ${report.totalMs} ms over ${report.timings.length} requests, ${report.inputTokens} input tokens; hard failures: ${report.hardFailures.length ? report.hardFailures.join('; ') : 'none'}`)
  process.exit(report.hardFailures.length ? 1 : 0)
}
const write = args.includes('--write'), built = await buildLayerReplayPlan()
let differs = 0
for (const [name, bytes] of [['plan.json', built.planBytes], ...built.files.map(f => [f.file, f.bytes])]) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${LAYER_REPLAY_DIR}/${name}`) } }
}
console.log(`== layer replay (${LAYER_REPLAY_DIR})`)
for (const r of built.requests) console.log(`${r.id.padEnd(20)} est=${String(r.estInputTokens).padStart(5)}  sha256=${r.sha256.slice(0, 12)}  ${r.recordOnly ? 'record-only' : `${r.expect.length} checks (${r.expect.filter(e => e.severity === 'hard').length} hard)`}`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${built.files.length + 1} files, ${built.totals.requests} requests, ${built.totals.questions} questions, ${built.totals.bytes} bytes, est input tokens ${built.totals.estInputTokens} of ceiling ${built.plan.tokenCeiling}`)
console.log(`offline flows: ${JSON.stringify(built.flows)}`)
process.exit(differs && !write ? 1 : 0)
