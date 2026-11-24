#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { buildPlan, buildUtterancePlan, scoreFirstScan, scoreRemeasure, scoreUtteranceLabels } from '../helper/egdesk-memory-real-plan.mjs'
import { sendStampPath, stampingFetch } from '../helper/egdesk-decision-send-stamp.mjs'
import { diffPlan, planTable, runMeasurement } from '../helper/egdesk-memory-real-runner.mjs'

// End-to-end turn-memory measurement (public synthetic wiki, 6 runs). Dry run by default: prints the plan and sends nothing.
//   node scripts/egdesk-memory-real-measure.mjs [--set remeasure|first-scan|utterance-labels] [--plan plan.json] [--out results.json] [--max-tokens N]   # dry run
//   --set remeasure: the small re-measurement (failing stages plus controls); without it, the full 23-request plan.
//   OPENAI_API_KEY=... node scripts/egdesk-memory-real-measure.mjs --send [--plan plan.json] [--out results.json]    # real, after approval
// The key is read from OPENAI_API_KEY only and is never printed or written. No retries; the first failure stops the run.
const args = process.argv.slice(2)
const flag = name => args.includes(name), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const set = value('--set'), remeasure = set === 'remeasure', firstScan = set === 'first-scan', utterances = set === 'utterance-labels'
if (set && !remeasure && !firstScan && !utterances) { console.error(`unknown --set ${set} (remeasure | first-scan | utterance-labels)`); process.exit(2) }
const plan = utterances ? await buildUtterancePlan() : await buildPlan({ subset: set ?? null })
const planFile = value('--plan')
if (planFile) {
  const diffs = diffPlan(plan, JSON.parse(readFileSync(planFile, 'utf8')))
  if (diffs.length) { console.error(`plan differs from ${planFile}:\n${diffs.join('\n')}`); process.exit(2) }
  console.log(`plan matches ${planFile}`)
}
console.table(planTable(plan).map(({ run, name, stage, questions, bytes, estInputTokens, sha256 }) => ({ run, name, stage, questions, bytes, estInputTokens, sha: sha256.slice(0, 12) })))
const maxTokens = value('--max-tokens') ? Number(value('--max-tokens')) : null
const key = flag('--send') ? process.env.OPENAI_API_KEY ?? null : null
const outcome = await runMeasurement({ plan, key, send: flag('--send'), ...(flag('--send') ? { fetchImpl: stampingFetch(globalThis.fetch, { file: sendStampPath(process.env), runner: 'memory-real-measure' }) } : {}), maxEstimatedTokens: maxTokens, ...(remeasure ? { score: scoreRemeasure } : firstScan ? { score: scoreFirstScan } : utterances ? { score: scoreUtteranceLabels } : {}) })
console.log(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, totals: outcome.totals, ceiling: outcome.ceiling }))
if (outcome.scorecard) {
  const out = value('--out')
  const compact = { runsPassed: outcome.scorecard.runsPassed, pass: outcome.scorecard.pass, triageFailures: outcome.scorecard.triageFailures ?? [],
    ...(Number.isFinite(outcome.scorecard.installed) ? { labelsInstalled: `${outcome.scorecard.installed}/${outcome.scorecard.axes}` } : {}),
    runs: outcome.scorecard.scored.map(s => ({ id: s.id, pass: s.pass, hardFailures: s.hardFailures, softMisses: s.softMisses })) }
  console.log(JSON.stringify(compact, null, 1))
  if (out) writeFileSync(out, JSON.stringify({ outcome: { sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, totals: outcome.totals }, results: outcome.results, scorecard: outcome.scorecard.scored.map(s => ({ id: s.id, pass: s.pass, checks: s.checks })) }, null, 1), { mode: 0o600 })
}
if (flag('--send') && outcome.stoppedBecause === 'no_key') { console.error('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); process.exit(3) }
