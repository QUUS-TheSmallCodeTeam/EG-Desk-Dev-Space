#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { sendStampPath, stampingFetch } from '../helper/egdesk-decision-send-stamp.mjs'
import { OPEN_ITEM_HARD_LIMITS, loadOpenItemPlan, runOpenItemPlan, selectReplies, standIn } from '../helper/egdesk-browser-open-item-measure.mjs'

// c38: which option of an open browser task the Decision model settles for 12 short replies after a hand-over (pre-registered in scripts/egdesk-browser-open-item-plan.json).
// Decisions only: no page, no engine. Dry by default (the stand-in sizes the requests; nothing leaves the process).
//   node scripts/egdesk-browser-open-item-measure.mjs                                        # dry: the requests' sizes, the plan's checks
//   OPENAI_API_KEY=... node scripts/egdesk-browser-open-item-measure.mjs --send [--budget 13000] [--out results.json]    # real, after approval (default budget 4000: three replies; 13000: all twelve)
// The key is read from OPENAI_API_KEY only and is never printed or written. No retries; the request limit (12) and the input-token ceiling (4k) stop it.
const args = process.argv.slice(2)
const flag = name => args.includes(name), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const plan = loadOpenItemPlan()
const budget = Number.isSafeInteger(Number(value('--budget'))) && Number(value('--budget')) > 0 ? Number(value('--budget')) : plan.tokenCeiling
if (budget > OPEN_ITEM_HARD_LIMITS.tokenCeiling) { console.error(`--budget is at most ${OPEN_ITEM_HARD_LIMITS.tokenCeiling}`); process.exit(2) }
const chosen = await selectReplies(plan, budget)
console.table(plan.replies.map(r => ({ reply: r.id, message: r.message, want: r.want, acceptable: r.acceptable.join('|') })))
const estimate = await runOpenItemPlan({ plan, budget, scripted: standIn(plan) })
console.log(JSON.stringify({ plan: plan.set, planSha256: plan.sha256, note: 'sizes from a scripted stand-in that answers as the plan wants, not a model', requests: estimate.sent, estInputTokens: estimate.usage.inputTokens,
  requestLimit: plan.maxRequests, budget, kept: chosen.kept, dropped: chosen.dropped, estimatedFull: Object.values(chosen.perReply).reduce((a, b) => a + b, 0), hardLimits: OPEN_ITEM_HARD_LIMITS, standInPass: estimate.score.pass, perReply: estimate.requests.map(r => `${r.id}:${r.estInputTokens}`) }))
const outcome = await runOpenItemPlan({ plan, budget, send: flag('--send'), key: flag('--send') ? process.env.OPENAI_API_KEY ?? null : null,
  ...(flag('--send') ? { fetchImpl: stampingFetch(globalThis.fetch, { file: sendStampPath(), runner: `browser-open-item-measure ${plan.set}` }) } : {}) })
console.log(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens, limits: outcome.limits }))
if (outcome.score) {
  console.log(JSON.stringify({ score: outcome.score, rows: outcome.rows.map(r => ({ id: r.id, message: r.message, want: r.want, outcome: r.kind === 'settled' ? r.optionId : r.kind, verdict: r.verdict, p: r.p })) }, null, 1))
  const out = value('--out')
  if (out) writeFileSync(out, JSON.stringify(outcome, null, 1), { mode: 0o600 })
}
if (flag('--send') && outcome.stoppedBecause === 'no_key') { console.error('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); process.exit(3) }
if (outcome.score && !outcome.score.pass) process.exit(1)
