#!/usr/bin/env node
import os from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadOwnerExclusions } from '../helper/egdesk-scenario-exclusion.mjs'
import { buildNunchiEvalPlans, buildNunchiFreshPlans, buildNunchiMergedPlans, defaultExamplesDir, listFiles, loadExamples, nunchiAgreement, nunchiMergedReport, readPriorLabels } from '../helper/egdesk-nunchi-plans.mjs'

// L7 u1: the measurement plan of the nunchi judgment (U17), Decisions only. It only writes files (and reads results); it never sends. Main sends each chunk with
// scripts/egdesk-decision-real-measure.mjs after the owner approves; the first chunk holds the synthetic controls.
//   node scripts/egdesk-nunchi-plan.mjs plan <outDir> [--examples <dir>] [--labels <dir of earlier label results>] [--per-class 4]
//   node scripts/egdesk-nunchi-plan.mjs report <results.json> <preregistration.json>
//   node scripts/egdesk-nunchi-plan.mjs merged-plan <outDir>             u2: twelve NEW synthetic turns that validate the merged reading (no conversation example, no exclusion needed)
//   node scripts/egdesk-nunchi-plan.mjs fresh-plan <outDir>              u3: sixteen more NEW synthetic turns with no assistant message before them (the Claude path); read with merged-report
//   node scripts/egdesk-nunchi-plan.mjs merged-report <results.json> <preregistration.json>
// The owner's exclusion file (local, outside the repository; default <examples>/../local/exclude.json, or --exclude) is applied before anything is built; what it excludes is counted, never named.
// A missing or broken exclusion file stops the run (fail closed).
const [mode, a, b, ...rest] = process.argv.slice(2)
const opt = name => { const i = [a, b, ...rest].indexOf(name); return i >= 0 ? [a, b, ...rest][i + 1] : null }
if (mode === 'plan' && a) {
  const examplesDir = opt('--examples') ?? defaultExamplesDir(os.homedir())
  // the exclusion file sits beside the examples (local/exclude.json) unless named; with none the run stops (fail closed): nothing is built that the owner's rule could not be applied to
  const excludeFile = opt('--exclude') ?? path.join(path.dirname(examplesDir), 'local', 'exclude.json')
  if (!existsSync(excludeFile)) { console.error('the owner exclusion file was not found: nothing was built'); process.exit(2) }
  const exclusions = loadOwnerExclusions({ file: excludeFile })
  const { examples, counts } = loadExamples(listFiles(examplesDir, /\.jsonl$/), { exclusions })
  const labelsDir = opt('--labels')
  const labels = labelsDir ? readPriorLabels(listFiles(labelsDir, /plan-results\.json$/)) : new Map()
  const chunks = buildNunchiEvalPlans({ examples, labels, perClass: Number(opt('--per-class') ?? 4) })
  for (const { plan, files, estInputTokens, preregistration } of chunks) {
    const out = path.join(a, plan.set)
    mkdirSync(path.join(out, 'requests'), { recursive: true })
    for (const { file, bytes } of files) writeFileSync(path.join(out, file), bytes)
    writeFileSync(path.join(out, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`)
    writeFileSync(path.join(out, 'preregistration.json'), `${JSON.stringify(preregistration, null, 1)}\n`)
    console.log(JSON.stringify({ set: plan.set, requests: plan.requests.length, estInputTokens, tokenCeiling: plan.tokenCeiling }))
  }
  console.log(JSON.stringify({ examples: { read: counts.read, excludedByOwner: counts.excludedByOwner, usable: examples.length, labelled: labels.size, exclusionActive: exclusions.active } }))
} else if ((mode === 'merged-plan' || mode === 'fresh-plan') && a) {
  for (const { plan, files, estInputTokens, preregistration } of (mode === 'fresh-plan' ? buildNunchiFreshPlans() : buildNunchiMergedPlans())) {
    const out = path.join(a, plan.set)
    mkdirSync(path.join(out, 'requests'), { recursive: true })
    for (const { file, bytes } of files) writeFileSync(path.join(out, file), bytes)
    writeFileSync(path.join(out, 'plan.json'), `${JSON.stringify(plan, null, 1)}\n`)
    writeFileSync(path.join(out, 'preregistration.json'), `${JSON.stringify(preregistration, null, 1)}\n`)
    console.log(JSON.stringify({ set: plan.set, requests: plan.requests.length, estInputTokens, tokenCeiling: plan.tokenCeiling }))
  }
} else if (mode === 'merged-report' && a && b) {
  console.log(nunchiMergedReport(JSON.parse(readFileSync(a, 'utf8')), JSON.parse(readFileSync(b, 'utf8'))).text)
} else if (mode === 'report' && a && b) {
  console.log(nunchiAgreement(JSON.parse(readFileSync(a, 'utf8')), JSON.parse(readFileSync(b, 'utf8'))).text)
} else { console.error('usage: egdesk-nunchi-plan.mjs plan <outDir> [--examples <dir>] [--labels <dir>] [--per-class n] | report <results.json> <preregistration.json> | merged-plan <outDir> | fresh-plan <outDir> | merged-report <results.json> <preregistration.json>'); process.exit(2) }
