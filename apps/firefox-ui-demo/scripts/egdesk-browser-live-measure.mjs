#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { sendStampPath, stampingFetch } from '../helper/egdesk-decision-send-stamp.mjs'
import { ALLON_PLAN_FILE, FAMILY_PLAN_FILES, HARD_LIMITS, RECORDED_PLAN_FILE, RENAMED_PLAN_FILE, estimateLive, loadLivePlan, runLive } from '../helper/egdesk-browser-live-runner.mjs'

// LIVE browser-task measurement: the product's objective browser loop over synthetic pages, the monthly tax-invoice journey
// pre-registered in scripts/egdesk-browser-live-plan.json. Dry run by default.
//   node scripts/egdesk-browser-live-measure.mjs [--plan recorded|allon|renamed|statement|delivery|settings|stability|settings-error|holdout|holdout-rerun|holdout2|stuck|entry|entry2|entry3|holdout2b|regression]                          # dry run: prints the plan and its size, sends nothing
//   plans: default browser-live-v2 (month 1 + changed page), recorded = browser-live-recorded-v3 (month 2 + renamed business), renamed = browser-live-renamed-v3 (c17 re-measure: renamed + SSO page),
//   allon = browser-live-allon-v1 (Main's all-on s10/s11 pages)
//   OPENAI_API_KEY=... node scripts/egdesk-browser-live-measure.mjs --send [--out results.json]    # real, after approval
// The key is read from OPENAI_API_KEY only and is never printed or written. No retries; the first failed request, the request limit
// (14), the input-token ceiling (12k) or the first hard/absolute failure stops the journey.
const args = process.argv.slice(2)
const flag = name => args.includes(name), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const planName = value('--plan')
// c19: statement / delivery / settings are the generalisation families (egdesk-browser-live-families.mjs)
const PLAN_FILES = { recorded: RECORDED_PLAN_FILE, allon: ALLON_PLAN_FILE, renamed: RENAMED_PLAN_FILE, ...FAMILY_PLAN_FILES }
if (planName !== null && !PLAN_FILES[planName]) { console.error(`unknown --plan (${Object.keys(PLAN_FILES).join(' | ')})`); process.exit(2) }
const plan = planName ? loadLivePlan(PLAN_FILES[planName]) : loadLivePlan()
console.table(plan.checks.map(c => ({ check: c.id, phase: c.phase, severity: c.severity })))
const estimate = await estimateLive({ plan })
console.log(JSON.stringify({ plan: plan.set, planSha256: plan.sha256, note: 'sizes from a scripted stand-in that answers as the plan expects, not a model; the real loop is adaptive',
  estimatedRequests: estimate.requests, perPhase: estimate.perPhase, estimatedInputTokens: estimate.estInputTokens, requestLimit: plan.maxRequests, tokenCeiling: plan.tokenCeiling,
  hardLimits: HARD_LIMITS, standInPasses: estimate.scorecard.pass }))
const outcome = await runLive({ key: flag('--send') ? process.env.OPENAI_API_KEY ?? null : null, send: flag('--send'), plan,
  ...(flag('--send') ? { fetchImpl: stampingFetch(globalThis.fetch, { file: sendStampPath(), runner: `browser-live-measure ${plan.set}` }) } : {}) })
console.log(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens, limits: outcome.limits }))
if (outcome.scorecard) {
  console.log(JSON.stringify({ pass: outcome.scorecard.pass, hardFailures: outcome.scorecard.hardFailures, absolute: outcome.scorecard.absolute, softMisses: outcome.scorecard.softMisses,
    requests: outcome.requests.map(r => ({ phase: r.phase, stage: r.stage, status: r.status, inputTokens: r.inputTokens, answers: r.answers })) }, null, 1))
  const out = value('--out')
  if (out) writeFileSync(out, JSON.stringify(outcome, null, 1), { mode: 0o600 })
}
if (flag('--send') && outcome.stoppedBecause === 'no_key') { console.error('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); process.exit(3) }
if (outcome.scorecard && !outcome.scorecard.pass) process.exit(1)
