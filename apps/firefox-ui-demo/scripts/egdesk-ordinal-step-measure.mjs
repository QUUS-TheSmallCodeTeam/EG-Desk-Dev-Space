#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { sendStampPath, stampingFetch } from '../helper/egdesk-decision-send-stamp.mjs'
import { ORDINAL_HARD, loadOrdinalPlan, ordinalStandIn, runOrdinalPlan, selectOrdinal } from '../helper/egdesk-ordinal-step-measure.mjs'

// c44: the objective step after an ordinal reply ("두번째") to a choice the browser task asked: the old bare line, the code-resolved line, the reply with the asked list. The product's own step
// request over the portal fixture. Pre-registered in scripts/egdesk-ordinal-step-plan.json. Decisions only. Dry by default.
//   node scripts/egdesk-ordinal-step-measure.mjs                                   # dry: sizes, the plan
//   OPENAI_API_KEY=... node scripts/egdesk-ordinal-step-measure.mjs --send [--budget 5000] [--out results.json]
// The key is read from OPENAI_API_KEY only and is never printed or written. No retries; the request limit (4) and the token ceiling (5k) stop it.
const args = process.argv.slice(2)
const flag = name => args.includes(name), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const plan = loadOrdinalPlan()
const budget = Number.isSafeInteger(Number(value('--budget'))) && Number(value('--budget')) > 0 ? Number(value('--budget')) : plan.tokenCeiling
if (budget > ORDINAL_HARD.tokenCeiling) { console.error(`--budget is at most ${ORDINAL_HARD.tokenCeiling}`); process.exit(2) }
console.table(plan.replies.map(r => ({ reply: r.id, message: r.message, line: r.line })))
const chosen = await selectOrdinal(plan, budget)
const estimate = await runOrdinalPlan({ plan, budget, scripted: ordinalStandIn(plan) })
console.log(JSON.stringify({ plan: plan.set, planSha256: plan.sha256, note: 'sizes from a scripted stand-in that answers as the plan expects, not a model', requests: estimate.sent, estInputTokens: estimate.usage.inputTokens, requestLimit: plan.maxRequests, budget,
  kept: chosen.kept, dropped: chosen.dropped, estimatedFull: Object.values(chosen.perReply).reduce((a, b) => a + b, 0), hardLimits: ORDINAL_HARD, standInPass: estimate.score.pass, perReply: estimate.requests.map(r => `${r.id}:${r.estInputTokens}`) }))
const outcome = await runOrdinalPlan({ plan, budget, send: flag('--send'), key: flag('--send') ? process.env.OPENAI_API_KEY ?? null : null,
  ...(flag('--send') ? { fetchImpl: stampingFetch(globalThis.fetch, { file: sendStampPath(), runner: `ordinal-step-measure ${plan.set}` }) } : {}) })
console.log(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens, limits: outcome.limits }))
if (outcome.score) {
  console.log(JSON.stringify({ score: outcome.score, rows: outcome.rows.map(r => ({ id: r.id, message: r.message, line: r.line, value: r.value, confidence: r.confidence, margin: r.margin, verdict: r.verdict, ranked: r.ranked })) }, null, 1))
  const out = value('--out')
  if (out) writeFileSync(out, JSON.stringify(outcome, null, 1), { mode: 0o600 })
}
if (flag('--send') && outcome.stoppedBecause === 'no_key') { console.error('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); process.exit(3) }
if (outcome.score && !outcome.score.pass) process.exit(1)
