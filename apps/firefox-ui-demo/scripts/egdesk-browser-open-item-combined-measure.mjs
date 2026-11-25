#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { sendStampPath, stampingFetch } from '../helper/egdesk-decision-send-stamp.mjs'
import { OPEN_ITEM_HARD_LIMITS } from '../helper/egdesk-browser-open-item-measure.mjs'
import { COMBINED_PLAN_FILES, combinedStandIn, loadCombinedPlan, runCombined, selectCombined } from '../helper/egdesk-browser-open-item-combined.mjs'

// c42: the product's own turn-start request when a browser task is open (the resolver's referent question + the option predicates, one request) on 12 short replies after a
// hand-over and 4 controls with another open item. Pre-registered in scripts/egdesk-browser-open-item-combined-plan.json. Decisions only. Dry by default.
//   node scripts/egdesk-browser-open-item-combined-measure.mjs                                   # dry: sizes, drop order, the plan
//   --plan v1 (as sent in c62) | v2 (c43: after the summary change)
//   OPENAI_API_KEY=... node scripts/egdesk-browser-open-item-combined-measure.mjs [--plan v2] --send [--budget 16000] [--out results.json]
// The key is read from OPENAI_API_KEY only and is never printed or written. No retries; the request limit and the token ceiling (16k) stop it.
const args = process.argv.slice(2)
const flag = name => args.includes(name), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const planName = value('--plan') ?? 'v1'
if (!COMBINED_PLAN_FILES[planName]) { console.error(`unknown --plan (${Object.keys(COMBINED_PLAN_FILES).join(' | ')})`); process.exit(2) }
const plan = loadCombinedPlan(COMBINED_PLAN_FILES[planName])
const budget = Number.isSafeInteger(Number(value('--budget'))) && Number(value('--budget')) > 0 ? Number(value('--budget')) : plan.tokenCeiling
if (budget > OPEN_ITEM_HARD_LIMITS.tokenCeiling) { console.error(`--budget is at most ${OPEN_ITEM_HARD_LIMITS.tokenCeiling}`); process.exit(2) }
console.table(plan.replies.map(r => ({ reply: r.id, message: r.message, items: r.items.join('+'), wantItem: r.wantItem, wantOption: r.wantOption ?? '' })))
const chosen = await selectCombined(plan, budget)
const estimate = await runCombined({ plan, budget, scripted: combinedStandIn(plan) })
console.log(JSON.stringify({ plan: plan.set, planSha256: plan.sha256, note: 'sizes from a scripted stand-in that answers as the plan wants, not a model', requests: estimate.sent, estInputTokens: estimate.usage.inputTokens, requestLimit: plan.maxRequests, budget,
  kept: chosen.kept, dropped: chosen.dropped, estimatedFull: Object.values(chosen.perReply).reduce((a, b) => a + b, 0), hardLimits: OPEN_ITEM_HARD_LIMITS, standInPass: estimate.score.pass, perReply: estimate.requests.map(r => `${r.id}:${r.estInputTokens}`) }))
const outcome = await runCombined({ plan, budget, send: flag('--send'), key: flag('--send') ? process.env.OPENAI_API_KEY ?? null : null,
  ...(flag('--send') ? { fetchImpl: stampingFetch(globalThis.fetch, { file: sendStampPath(), runner: `browser-open-item-combined-measure ${plan.set}` }) } : {}) })
console.log(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens, limits: outcome.limits }))
if (outcome.score) {
  console.log(JSON.stringify({ score: outcome.score, rows: outcome.rows.map(r => ({ id: r.id, message: r.message, items: r.items, want: `${r.wantItem}${r.wantOption ? ':' + r.wantOption : ''}`, outcome: r.outcome, verdict: r.verdict, refs: r.refs, p: r.p })) }, null, 1))
  const out = value('--out')
  if (out) writeFileSync(out, JSON.stringify(outcome, null, 1), { mode: 0o600 })
}
if (flag('--send') && outcome.stoppedBecause === 'no_key') { console.error('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); process.exit(3) }
if (outcome.score && !outcome.score.pass) process.exit(1)
