import { DECISIONS_ENDPOINT } from './egdesk-decision-client.mjs'
import { RUNS, buildPlan, scorePlan, scoreRemeasure } from './egdesk-memory-real-plan.mjs'

// Sends the pre-built measurement requests, one at a time, to the OFFICIAL Decisions endpoint. For Main to run after the user approves.
//  - The key comes from the caller (the CLI reads one environment variable); it is used only in the Authorization header of the POST and is
//    never logged, stored, put in results, or echoed in an error.
//  - Every request body is re-hashed and compared with the plan before ANY request is sent; a mismatch sends nothing.
//  - No retries. The first non-200 answer or network error stops the run; later requests are marked not sent.
//  - A token ceiling (estimated total x 1.25 unless given) refuses to start rather than overspend.
//  - redirect: 'error', per-request timeout, official endpoint only (the endpoint is not a parameter).
const OFFICIAL = DECISIONS_ENDPOINT
if (OFFICIAL !== 'https://api.openai.com/v1/decisions') throw new Error('unexpected Decisions endpoint')

export function planTable(plan) {
  return plan.runs.flatMap(run => run.requests.map(r => ({ run: run.id, position: run.position, name: r.name, stage: r.stage, questions: r.questions, bytes: r.bytes, sha256: r.sha256, estInputTokens: r.estInputTokens })))
}

/** Compare a rebuilt plan with a saved plan.json (names, order, sha256, bytes). Returns the list of differences. */
export function diffPlan(plan, saved) {
  const mine = planTable(plan), theirs = Array.isArray(saved?.requests) ? saved.requests : []
  const diffs = []
  if (mine.length !== theirs.length) diffs.push(`request count ${mine.length} != ${theirs.length}`)
  mine.forEach((row, i) => { const t = theirs[i]; if (!t || t.name !== row.name || t.sha256 !== row.sha256 || t.bytes !== row.bytes) diffs.push(`request ${i + 1} (${row.name}) differs`) })
  return diffs
}

/**
 * runMeasurement({ plan, key, send = false, fetchImpl = fetch, maxEstimatedTokens, timeoutMs = 20000, now })
 * -> { sent, stoppedBecause, results, scorecard, totals }. With send = false nothing leaves the process (a dry run).
 */
export async function runMeasurement({ plan, key = null, send = false, fetchImpl = globalThis.fetch, maxEstimatedTokens = null, timeoutMs = 20000, now = () => performance.now(), score = scorePlan } = {}) {
  const table = planTable(plan)
  const totals = { requests: table.length, estInputTokens: table.reduce((n, r) => n + r.estInputTokens, 0) }
  const ceiling = Number.isFinite(maxEstimatedTokens) ? maxEstimatedTokens : Math.ceil(totals.estInputTokens * 1.25)
  const results = {}
  if (send !== true) return { sent: 0, stoppedBecause: 'dry_run', results, scorecard: null, totals, ceiling }
  if (typeof key !== 'string' || key.length < 20 || /\s/.test(key)) return { sent: 0, stoppedBecause: 'no_key', results, scorecard: null, totals, ceiling }
  if (totals.estInputTokens > ceiling) return { sent: 0, stoppedBecause: 'over_token_ceiling', results, scorecard: null, totals, ceiling }
  // Nothing is sent unless every body still hashes to what the plan says.
  const { createHash } = await import('node:crypto')
  for (const run of plan.runs) for (const r of run.requests) {
    const text = JSON.stringify(r.body)
    if (createHash('sha256').update(text).digest('hex') !== r.sha256) return { sent: 0, stoppedBecause: 'hash_mismatch', mismatch: r.name, results, scorecard: null, totals, ceiling }
  }
  let sent = 0, stoppedBecause = null
  outer: for (const run of plan.runs) for (const r of run.requests) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = now()
    try {
      const response = await fetchImpl(OFFICIAL, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(r.body) })
      sent++
      let body = null
      try { body = await response.json() } catch { body = null }
      results[r.name] = { status: response.status, elapsedMs: Math.round(now() - started), openaiProcessingMs: response.headers?.get?.('openai-processing-ms') ?? null,
        usage: body?.usage ? { input_tokens: body.usage.input_tokens ?? null, output_tokens: body.usage.output_tokens ?? null } : null, answers: Array.isArray(body?.answers) ? body.answers : [] }
      if (response.status !== 200) { stoppedBecause = `http_${response.status}`; break outer }
    } catch (error) {
      results[r.name] = { status: 0, elapsedMs: Math.round(now() - started), error: error?.name === 'AbortError' ? 'timeout' : 'network', answers: [] }
      stoppedBecause = results[r.name].error; break outer
    } finally { clearTimeout(timer) }
  }
  // Requests after a stop are simply absent from results: the scorer reports them as "not sent".
  return { sent, stoppedBecause, results, scorecard: score(plan, results), totals, ceiling }
}

export { RUNS, buildPlan, scorePlan, scoreRemeasure }
