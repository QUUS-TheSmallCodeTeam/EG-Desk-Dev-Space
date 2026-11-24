#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { HARD_LIMITS, estimateLive, loadLivePlan, runLive } from '../helper/egdesk-browser-live-runner.mjs'

// LIVE browser-task measurement: the product's objective browser loop over synthetic pages, the monthly tax-invoice journey
// pre-registered in scripts/egdesk-browser-live-plan.json. Dry run by default.
//   node scripts/egdesk-browser-live-measure.mjs                                                  # dry run: prints the plan and its size, sends nothing
//   OPENAI_API_KEY=... node scripts/egdesk-browser-live-measure.mjs --send [--out results.json]    # real, after approval
// The key is read from OPENAI_API_KEY only and is never printed or written. No retries; the first failed request, the request limit
// (14), the input-token ceiling (12k) or the first hard/absolute failure stops the journey.
const args = process.argv.slice(2)
const flag = name => args.includes(name), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const plan = loadLivePlan()
console.table(plan.checks.map(c => ({ check: c.id, phase: c.phase, severity: c.severity })))
const estimate = await estimateLive({ plan })
console.log(JSON.stringify({ plan: plan.set, planSha256: plan.sha256, note: 'sizes from a scripted stand-in that answers as the plan expects, not a model; the real loop is adaptive',
  estimatedRequests: estimate.requests, perPhase: estimate.perPhase, estimatedInputTokens: estimate.estInputTokens, requestLimit: plan.maxRequests, tokenCeiling: plan.tokenCeiling,
  hardLimits: HARD_LIMITS, standInPasses: estimate.scorecard.pass }))
const outcome = await runLive({ key: flag('--send') ? process.env.OPENAI_API_KEY ?? null : null, send: flag('--send'), plan })
console.log(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens, limits: outcome.limits }))
if (outcome.scorecard) {
  console.log(JSON.stringify({ pass: outcome.scorecard.pass, hardFailures: outcome.scorecard.hardFailures, absolute: outcome.scorecard.absolute, softMisses: outcome.scorecard.softMisses,
    requests: outcome.requests.map(r => ({ phase: r.phase, stage: r.stage, status: r.status, inputTokens: r.inputTokens, answers: r.answers })) }, null, 1))
  const out = value('--out')
  if (out) writeFileSync(out, JSON.stringify(outcome, null, 1), { mode: 0o600 })
}
if (flag('--send') && outcome.stoppedBecause === 'no_key') { console.error('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); process.exit(3) }
if (outcome.scorecard && !outcome.scorecard.pass) process.exit(1)
