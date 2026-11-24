#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { sendStampPath, stampingFetch } from '../helper/egdesk-decision-send-stamp.mjs'
import { LIVE_LIMITS, LIVE_RUNS, estimateLive, runLive } from '../helper/egdesk-memory-live-runner.mjs'

// LIVE turn-memory measurement: the real adaptive loop against the public synthetic wiki, 3 scenarios x first/mid. Dry run by default.
//   node scripts/egdesk-memory-live-measure.mjs [--max-tokens N]                                   # dry run: prints the plan, sends nothing
//   OPENAI_API_KEY=... node scripts/egdesk-memory-live-measure.mjs --send [--out results.json]      # real, after approval
//   node scripts/egdesk-memory-live-measure.mjs --set v2 [--send --out results.json]               # v2: the journey (see egdesk-memory-journey.mjs)
// The key is read from OPENAI_API_KEY only and is never printed or written. No retries; a request limit and an input-token ceiling stop the run.
const args = process.argv.slice(2)
const flag = name => args.includes(name), value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
// The one place the key is read; both measurements get it only through this object.
const sending = { key: flag('--send') ? process.env.OPENAI_API_KEY ?? null : null, send: flag('--send'),
  ...(flag('--send') ? { fetchImpl: stampingFetch(globalThis.fetch, { file: sendStampPath(), runner: 'memory-live-measure' }) } : {}) }
// --set v2: the journey (real runtime; 'about' + one packet + confirmation; six turns in two sessions; ceiling 30k). Same safety rules.
if (value('--set') === 'v2') {
  const { JOURNEY_LIMITS, JOURNEY_PASS_RULE, JOURNEY_TURNS, estimateJourney, runJourneyLive } = await import('../helper/egdesk-memory-journey.mjs')
  const ceiling = value('--max-tokens') ? Number(value('--max-tokens')) : JOURNEY_LIMITS.tokenCeiling
  console.table(JOURNEY_TURNS.map(t => ({ turn: t.id, session: t.session, message: t.message })))
  const estimate = await estimateJourney()
  console.log(JSON.stringify({ note: 'sizes from a lexical stand-in, not a model; the real loop is adaptive', estimatedRequests: estimate.requests, estimatedInputTokens: estimate.estInputTokens, perTurn: estimate.turns,
    requestLimit: JOURNEY_LIMITS.maxRequests, tokenCeiling: Math.min(ceiling, JOURNEY_LIMITS.hardTokenMax), passRule: JOURNEY_PASS_RULE }))
  const outcome = await runJourneyLive({ ...sending, tokenCeiling: ceiling })
  console.log(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens, ceiling: outcome.ceiling }))
  if (outcome.scorecard) {
    console.log(JSON.stringify({ turnsPassed: outcome.scorecard.turnsPassed, pass: outcome.scorecard.pass, absolute: outcome.scorecard.absolute,
      turns: outcome.scorecard.scored.map(s => ({ id: s.id, pass: s.pass, hardFailures: s.hardFailures, softMisses: s.softMisses, ...(s.failureClass ? { class: s.failureClass } : {}) })) }, null, 1))
    const out = value('--out')
    if (out) writeFileSync(out, JSON.stringify({ set: 'v2', outcome: { sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, usage: outcome.usage, ceiling: outcome.ceiling }, turns: outcome.turns, requests: outcome.requests,
      scorecard: outcome.scorecard.scored.map(s => ({ id: s.id, pass: s.pass, failureClass: s.failureClass ?? null, checks: s.checks })) }, null, 1), { mode: 0o600 })
  }
  if (flag('--send') && outcome.stoppedBecause === 'no_key') { console.error('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); process.exit(3) }
  process.exit(0)
}
const maxTokens = value('--max-tokens') ? Number(value('--max-tokens')) : LIVE_LIMITS.tokenCeiling
console.table(LIVE_RUNS.map(r => ({ turn: r.id, position: r.position, held: r.held.length, required: r.required.join(' '), write: r.write ? `${r.write.pageId} -> ${r.write.status}` : 'none' })))
const estimate = await estimateLive()
console.log(JSON.stringify({ note: 'sizes from a lexical stand-in, not a model; the real loop is adaptive', estimatedRequests: estimate.requests, estimatedInputTokens: estimate.estInputTokens,
  requestLimit: LIVE_LIMITS.maxRequests, tokenCeiling: Math.min(maxTokens, LIVE_LIMITS.hardTokenMax), caps: LIVE_LIMITS.caps }))
const outcome = await runLive({ ...sending, tokenCeiling: maxTokens })
console.log(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens, ceiling: outcome.ceiling }))
if (outcome.scorecard) {
  console.log(JSON.stringify({ turnsPassed: outcome.scorecard.turnsPassed, pass: outcome.scorecard.pass, absolute: outcome.scorecard.absolute,
    turns: outcome.scorecard.scored.map(s => ({ id: s.id, pass: s.pass, class: s.failureClass, hardFailures: s.hardFailures, softMisses: s.softMisses })),
    latency: outcome.turns.map(t => ({ id: t.id, packetMs: t.packetMs, capMs: t.capMs, totalMs: t.totalMs, partial: t.partial })) }, null, 1))
  const out = value('--out')
  if (out) writeFileSync(out, JSON.stringify({ outcome: { sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, usage: outcome.usage, ceiling: outcome.ceiling }, turns: outcome.turns, requests: outcome.requests,
    scorecard: outcome.scorecard.scored.map(s => ({ id: s.id, pass: s.pass, failureClass: s.failureClass, checks: s.checks })) }, null, 1), { mode: 0o600 })
}
if (flag('--send') && outcome.stoppedBecause === 'no_key') { console.error('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); process.exit(3) }
