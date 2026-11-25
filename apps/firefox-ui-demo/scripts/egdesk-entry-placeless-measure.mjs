#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { sendStampPath, stampingFetch } from '../helper/egdesk-decision-send-stamp.mjs'
import { ENTRY_PLACELESS_HARD, entryStandIn, loadEntryPlacelessPlan, runEntryPlacelessPlan, selectEntry } from '../helper/egdesk-entry-placeless-measure.mjs'

// c43: does a message that names no place but matches the open page count as a page task? The product's own entry request, three levels of evidence about the open card, placeless
// messages and unrelated controls. Pre-registered in scripts/egdesk-entry-placeless-plan.json. Decisions only. Dry by default.
//   node scripts/egdesk-entry-placeless-measure.mjs                                   # dry: sizes, the plan
//   OPENAI_API_KEY=... node scripts/egdesk-entry-placeless-measure.mjs --send [--budget 8000] [--out results.json]
// The key is read from OPENAI_API_KEY only and is never printed or written. No retries; the request limit (13) and the token ceiling (8k) stop it.
const args = process.argv.slice(2)
const flag = name => args.includes(name), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const plan = loadEntryPlacelessPlan()
const budget = Number.isSafeInteger(Number(value('--budget'))) && Number(value('--budget')) > 0 ? Number(value('--budget')) : plan.tokenCeiling
if (budget > ENTRY_PLACELESS_HARD.tokenCeiling) { console.error(`--budget is at most ${ENTRY_PLACELESS_HARD.tokenCeiling}`); process.exit(2) }
console.table(plan.replies.map(r => ({ reply: r.id, message: r.message, evidence: r.evidence, want: r.want })))
const chosen = await selectEntry(plan, budget)
const estimate = await runEntryPlacelessPlan({ plan, budget, scripted: entryStandIn(plan) })
console.log(JSON.stringify({ plan: plan.set, planSha256: plan.sha256, note: 'sizes from a scripted stand-in that answers as the plan wants, not a model', requests: estimate.sent, estInputTokens: estimate.usage.inputTokens, requestLimit: plan.maxRequests, budget,
  kept: chosen.kept, dropped: chosen.dropped, estimatedFull: Object.values(chosen.perReply).reduce((a, b) => a + b, 0), hardLimits: ENTRY_PLACELESS_HARD, standInPass: estimate.score.pass, perReply: estimate.requests.map(r => `${r.id}:${r.estInputTokens}`) }))
const outcome = await runEntryPlacelessPlan({ plan, budget, send: flag('--send'), key: flag('--send') ? process.env.OPENAI_API_KEY ?? null : null,
  ...(flag('--send') ? { fetchImpl: stampingFetch(globalThis.fetch, { file: sendStampPath(), runner: `entry-placeless-measure ${plan.set}` }) } : {}) })
console.log(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens, limits: outcome.limits }))
if (outcome.score) {
  console.log(JSON.stringify({ score: outcome.score, rows: outcome.rows.map(r => ({ id: r.id, message: r.message, evidence: r.evidence, want: r.want, outcome: r.outcome, kind: r.kind, verdict: r.verdict, web: r.web, answerP: r.answerP, cardsP: r.cardsP })) }, null, 1))
  const out = value('--out')
  if (out) writeFileSync(out, JSON.stringify(outcome, null, 1), { mode: 0o600 })
}
if (flag('--send') && outcome.stoppedBecause === 'no_key') { console.error('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); process.exit(3) }
if (outcome.score && !outcome.score.pass) process.exit(1)
