#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STUDY_DIR, analyzeStudy, buildStudy, outcomeTable } from '../helper/egdesk-utterance-threshold-study.mjs'

// The utterance-axis threshold study. PREPARED, NOT SENT: this script never sends and never reads a key.
//   node scripts/egdesk-utterance-threshold-study.mjs                 # rebuild with the product code and compare with the committed files
//   node scripts/egdesk-utterance-threshold-study.mjs --write         # write labels.json and chunk-NN/{plan.json,requests/*.json}
//   node scripts/egdesk-utterance-threshold-study.mjs analyze <results.json>...   # after the owner sent chunks with the generic runner
// Sending (owner only, one chunk at a time): node scripts/egdesk-decision-real-measure.mjs <dir>/chunk-01/plan.json --send
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', STUDY_DIR)
const args = process.argv.slice(2)
if (args[0] === 'analyze') {
  const merged = {}
  for (const file of args.slice(1)) Object.assign(merged, JSON.parse(readFileSync(file, 'utf8')).results || {})
  const out = analyzeStudy(merged)
  console.log(JSON.stringify({ answered: out.answered, missing: out.missing }))
  for (const b of out.byBar) console.log(JSON.stringify({ bar: b.bar, margin: b.margin, installs: b.installs, wrong: b.wrong, upper95PerInstall: b.upper95PerInstall, wrongSentences: b.wrongSentences, upper95PerSentence: b.upper95PerSentence, coverage: b.coverage, ambiguousInstalls: b.ambiguousInstalls }))
  process.exit(0)
}
const write = args.includes('--write')
const built = await buildStudy()
const files = [['labels.json', built.labels.bytes], ...built.chunks.flatMap(c => [[`${c.dir}/plan.json`, c.planBytes], ...c.files.map(f => [`${c.dir}/${f.file}`, f.bytes])])]
let differs = 0
for (const [name, bytes] of files) {
  const target = path.join(dir, name)
  if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
  else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
}
for (const c of built.chunks) console.log(`${c.dir}  sentences=${c.items.length} (${c.items.filter(s => s.ambiguous).length} ambiguous)  est=${c.est} of ${c.plan.tokenCeiling}  ${c.items.map(s => s.id).join(' ')}`)
console.log(`labels sha256 ${built.labels.sha256}`)
console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${files.length} files, ${built.totals.sentences} sentences (${built.totals.ambiguous} ambiguous), est input tokens ${built.totals.estInputTokens}, largest chunk ${built.totals.maxChunk}; nothing was sent`)
if (!write) console.log(JSON.stringify(outcomeTable()))
process.exitCode = differs ? 1 : 0
