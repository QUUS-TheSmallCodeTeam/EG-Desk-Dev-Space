import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DECISIONS_ENDPOINT, DECISION_MODEL, normalizeDecisionResponse, validateDecisionRequest } from './egdesk-decision-client.mjs'

// Generic real-measurement runner for a DECLARATIVE plan (one plan per decision type, written by its lane).
// For Main to run after the owner approves. Nothing here is called by the product.
//
// Safety rules (the same as egdesk-memory-real-runner.mjs, with the plan read from files):
//  - Dry run by default: the plan is validated and printed; nothing leaves the process.
//  - Sending needs send === true AND a key the caller took from the OPENAI_API_KEY environment variable. The key is used only in
//    the Authorization header of the POST; it is never logged, written to results, or echoed in an error.
//  - The endpoint is the official one, fixed in code (not a parameter); redirects are refused (redirect: 'error').
//  - A request body is the EXACT bytes of its file. Every body is hashed when the plan is loaded and hashed again immediately
//    before it is sent; any mismatch with the plan's sha256 sends nothing.
//  - No retries. The first non-200 answer or network error stops the run; later requests are reported as not sent.
//  - The run refuses to start when the declared estimates exceed the plan's tokenCeiling, and stops as soon as the input tokens
//    the provider actually reported exceed it.
//  - Results are written to a 0600 file: answers, latency, openai-processing-ms, usage and the scorecard. Never the key or a header.
//
// Plan format (paths relative to the plan file):
//  { "set": name, "tokenCeiling": int, "passRule": text,
//    "requests": [ { "id", "file": "requests/<id>.json", "sha256": hex of the exact file bytes, "estInputTokens": int,
//        "expect": [ { "name", "kind": "predicate", "min"?: 0..1, "max"?: 0..1, "severity": "hard"|"soft", "note" },
//                    { "name", "kind": "choice", "equals"?: value, "oneOf"?: [values], "minConfidence"?: 0..1, "severity", "note" } ] } ] }
// A request passes when it has no failed hard check. An answer that is refused, missing or malformed fails its check.
const OFFICIAL = DECISIONS_ENDPOINT
if (OFFICIAL !== 'https://api.openai.com/v1/decisions') throw new Error('unexpected Decisions endpoint')
export const REAL_RUN_LIMITS = Object.freeze({ maxRequests: 200, maxBodyBytes: 4 * 1024 * 1024, timeoutMs: 20000 })
export const EXIT = Object.freeze({ ok: 0, usage: 2, noKey: 3, stopped: 4 })

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const unit = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const plausibleKey = key => typeof key === 'string' && key.length >= 20 && !/\s/.test(key)
// Typed input-token model solved from real requests of 2026-11-24 (egdesk-memory-real-plan.mjs). Only a cross-check of declared estimates.
export const independentEstimate = (choiceQuestions, predicateQuestions, bytes) => Math.round(56.5 * choiceQuestions + 134.8 * predicateQuestions + 0.1983 * bytes)

class PlanError extends Error { constructor(message) { super(message); this.name = 'PlanError' } }
const bad = message => { throw new PlanError(message) }

function checkExpectation(raw, where, questions) {
  if (!record(raw) || typeof raw.name !== 'string' || !raw.name) bad(`${where}: an expectation needs a question name`)
  if (raw.severity !== 'hard' && raw.severity !== 'soft') bad(`${where} ${raw.name}: severity must be "hard" or "soft"`)
  const question = questions.find(q => q.name === raw.name)
  if (!question) bad(`${where} ${raw.name}: the request has no question with this name`)
  const base = { name: raw.name, kind: raw.kind, severity: raw.severity, note: typeof raw.note === 'string' ? raw.note : '' }
  if (raw.kind === 'predicate') {
    if (question.type !== 'predicate') bad(`${where} ${raw.name}: expected a predicate but the question is ${question.type}`)
    const hasMin = raw.min !== undefined, hasMax = raw.max !== undefined
    if (!hasMin && !hasMax) bad(`${where} ${raw.name}: a predicate expectation needs min and/or max`)
    if ((hasMin && !unit(raw.min)) || (hasMax && !unit(raw.max)) || (hasMin && hasMax && raw.min > raw.max)) bad(`${where} ${raw.name}: min/max must be probabilities with min <= max`)
    return { ...base, ...(hasMin ? { min: raw.min } : {}), ...(hasMax ? { max: raw.max } : {}) }
  }
  if (raw.kind === 'choice') {
    if (question.type !== 'choice') bad(`${where} ${raw.name}: expected a choice but the question is ${question.type}`)
    const values = question.choices.map(choice => choice.value)
    const hasEquals = raw.equals !== undefined, hasOneOf = raw.oneOf !== undefined
    if (hasEquals === hasOneOf) bad(`${where} ${raw.name}: a choice expectation needs exactly one of equals / oneOf`)
    const wanted = hasEquals ? [raw.equals] : raw.oneOf
    if (!Array.isArray(wanted) || !wanted.length || wanted.some(value => !values.includes(value))) bad(`${where} ${raw.name}: expected value is not one of the question's choices`)
    if (raw.minConfidence !== undefined && !unit(raw.minConfidence)) bad(`${where} ${raw.name}: minConfidence must be a probability`)
    return { ...base, ...(hasEquals ? { equals: raw.equals } : { oneOf: [...raw.oneOf] }), ...(raw.minConfidence !== undefined ? { minConfidence: raw.minConfidence } : {}), options: values.length }
  }
  return bad(`${where} ${raw.name}: kind must be "predicate" or "choice"`)
}

/**
 * loadPlan(planFile) → { set, tokenCeiling, passRule, dir, requests: [{ id, file, sha256, bytes (Buffer), estInputTokens, independentEst, questions, counts, images, expect }], totals }
 * Throws PlanError (never sends) on anything that is not exactly the declared plan: a missing or escaping file, a hash mismatch,
 * a body that is not a valid Decisions request for the fixed model, or an expectation that names no question.
 */
export function loadPlan(planFile) {
  let raw
  try { raw = JSON.parse(readFileSync(planFile, 'utf8')) } catch { bad(`cannot read the plan file ${path.basename(String(planFile))}`) }
  if (!record(raw) || typeof raw.set !== 'string' || !raw.set.trim()) bad('the plan needs a set name')
  if (!Number.isSafeInteger(raw.tokenCeiling) || raw.tokenCeiling <= 0) bad('the plan needs a positive integer tokenCeiling')
  if (typeof raw.passRule !== 'string' || !raw.passRule.trim()) bad('the plan needs a passRule text')
  if (!Array.isArray(raw.requests) || !raw.requests.length || raw.requests.length > REAL_RUN_LIMITS.maxRequests) bad(`the plan needs 1 to ${REAL_RUN_LIMITS.maxRequests} requests`)
  const dir = realpathSync(path.dirname(path.resolve(planFile)))
  const seen = new Set()
  const requests = raw.requests.map((item, index) => {
    const where = `request ${index + 1}`
    if (!record(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(item.id)) bad(`${where}: id must be 1-100 letters, digits, dot, dash or underscore`)
    if (seen.has(item.id)) bad(`${where}: duplicate id ${item.id}`)
    seen.add(item.id)
    if (typeof item.file !== 'string' || !item.file || path.isAbsolute(item.file)) bad(`${item.id}: file must be a path relative to the plan`)
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) bad(`${item.id}: sha256 must be 64 lowercase hex characters`)
    if (!Number.isSafeInteger(item.estInputTokens) || item.estInputTokens <= 0) bad(`${item.id}: estInputTokens must be a positive integer`)
    const target = path.resolve(dir, item.file)
    let real, info
    try { info = lstatSync(target); real = realpathSync(target) } catch { bad(`${item.id}: request file not found`) }
    if (info.isSymbolicLink() || !info.isFile() || !(real === dir || real.startsWith(dir + path.sep))) bad(`${item.id}: the request file must be a regular file inside the plan directory`)
    if (info.size > REAL_RUN_LIMITS.maxBodyBytes) bad(`${item.id}: request file is too large`)
    const bytes = readFileSync(real)
    if (sha256(bytes) !== item.sha256) bad(`${item.id}: sha256 mismatch (the file is not the body the plan declares)`)
    let body
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { bad(`${item.id}: the request file is not UTF-8 JSON`) }
    if (!record(body) || body.model !== DECISION_MODEL) bad(`${item.id}: the body must name model ${DECISION_MODEL}`)
    const extra = Object.keys(body).filter(key => !['model', 'input', 'questions', 'prompt_cache_key', 'safety_identifier'].includes(key))
    if (extra.length) bad(`${item.id}: unexpected body field ${extra[0]}`)
    try { validateDecisionRequest({ input: body.input, questions: body.questions, promptCacheKey: body.prompt_cache_key ?? null, safetyIdentifier: body.safety_identifier ?? null }) }
    catch (error) { bad(`${item.id}: not a valid Decisions request (${error?.message || 'invalid'})`) }
    if (!Array.isArray(item.expect)) bad(`${item.id}: expect must be an array`)
    const expect = item.expect.map(entry => checkExpectation(entry, item.id, body.questions))
    const counts = { choice: body.questions.filter(q => q.type === 'choice').length, predicate: body.questions.filter(q => q.type === 'predicate').length, score: body.questions.filter(q => q.type === 'score').length }
    const text = bytes.toString('utf8')
    return { id: item.id, file: item.file, sha256: item.sha256, bytes, estInputTokens: item.estInputTokens, independentEst: independentEstimate(counts.choice, counts.predicate + counts.score, bytes.length),
      questions: body.questions, counts, images: (text.match(/"type"\s*:\s*"input_image"/g) || []).length, expect }
  })
  const totals = { requests: requests.length, estInputTokens: requests.reduce((sum, r) => sum + r.estInputTokens, 0), independentEst: requests.reduce((sum, r) => sum + r.independentEst, 0),
    bytes: requests.reduce((sum, r) => sum + r.bytes.length, 0) }
  return { set: raw.set, tokenCeiling: raw.tokenCeiling, passRule: raw.passRule, dir, requests, totals }
}

export function planTable(plan) {
  return plan.requests.map(r => ({ id: r.id, bytes: r.bytes.length, sha: r.sha256.slice(0, 12), choice: r.counts.choice, predicate: r.counts.predicate, score: r.counts.score, images: r.images,
    estInputTokens: r.estInputTokens, independentEst: r.independentEst, hard: r.expect.filter(e => e.severity === 'hard').length, soft: r.expect.filter(e => e.severity === 'soft').length }))
}

/** What the answer says about one expectation. observed carries what a later threshold analysis needs: probability, or choice + top/second/margin/N. */
export function scoreExpectation(expectation, answer) {
  const out = { name: expectation.name, kind: expectation.kind, severity: expectation.severity, note: expectation.note }
  if (expectation.kind === 'predicate') {
    if (answer?.type !== 'predicate') return { ...out, pass: false, observed: { state: answer?.type ?? 'missing' } }
    const p = answer.probability
    return { ...out, ...(expectation.min !== undefined ? { min: expectation.min } : {}), ...(expectation.max !== undefined ? { max: expectation.max } : {}),
      pass: (expectation.min === undefined || p >= expectation.min) && (expectation.max === undefined || p <= expectation.max), observed: { probability: p } }
  }
  if (answer?.type !== 'choice') return { ...out, pass: false, observed: { state: answer?.type ?? 'missing' } }
  const ranked = answer.probabilities || []
  const top = ranked[0]?.probability ?? null, second = ranked[1]?.probability ?? null
  const wanted = expectation.equals !== undefined ? [expectation.equals] : expectation.oneOf
  const picked = wanted.includes(answer.choice)
  const confident = expectation.minConfidence === undefined || answer.confidence >= expectation.minConfidence
  return { ...out, ...(expectation.equals !== undefined ? { equals: expectation.equals } : { oneOf: expectation.oneOf }), ...(expectation.minConfidence !== undefined ? { minConfidence: expectation.minConfidence } : {}),
    pass: picked && confident, ...(picked && !confident ? { reason: 'below_min_confidence' } : !picked ? { reason: 'other_choice' } : {}),
    observed: { choice: answer.choice, confidence: answer.confidence, top, second, margin: top !== null && second !== null ? Math.round((top - second) * 1e6) / 1e6 : null, options: expectation.options } }
}

export function scoreRequest(request, result) {
  if (!result) return { id: request.id, state: 'not_sent', pass: false, hardFailures: [], softMisses: [], checks: [] }
  if (result.status !== 200) return { id: request.id, state: 'failed', pass: false, hardFailures: [], softMisses: [], checks: [] }
  let answers = {}
  try { answers = normalizeDecisionResponse({ answers: result.answers }, request.questions).answers } catch { answers = {} }
  const checks = request.expect.map(expectation => scoreExpectation(expectation, answers[expectation.name]))
  const hardFailures = checks.filter(check => check.severity === 'hard' && !check.pass).map(check => check.name)
  return { id: request.id, state: 'answered', pass: hardFailures.length === 0, hardFailures, softMisses: checks.filter(check => check.severity === 'soft' && !check.pass).map(check => check.name), checks }
}

/**
 * runPlan({ plan, key, send = false, fetchImpl = fetch, timeoutMs, now }) → { set, sent, stoppedBecause, results, scorecard, totals, tokenCeiling, usage }
 * send !== true: a dry run; nothing leaves the process and no key is looked at.
 */
export async function runPlan({ plan, key = null, send = false, fetchImpl = globalThis.fetch, timeoutMs = REAL_RUN_LIMITS.timeoutMs, now = () => performance.now() } = {}) {
  const base = { set: plan.set, passRule: plan.passRule, totals: { requests: plan.totals.requests, estInputTokens: plan.totals.estInputTokens, independentEst: plan.totals.independentEst }, tokenCeiling: plan.tokenCeiling }
  const empty = stoppedBecause => ({ ...base, sent: 0, stoppedBecause, results: {}, scorecard: null, usage: { inputTokens: 0 } })
  if (send !== true) return empty('dry_run')
  if (!plausibleKey(key)) return empty('no_key')
  if (plan.totals.estInputTokens > plan.tokenCeiling) return empty('over_token_ceiling')
  // Nothing is sent unless every body still is exactly what the plan declares.
  for (const request of plan.requests) if (sha256(request.bytes) !== request.sha256) return { ...empty('hash_mismatch'), mismatch: request.id }
  const results = {}
  let sent = 0, stoppedBecause = null, inputTokens = 0
  for (const request of plan.requests) {
    if (sha256(request.bytes) !== request.sha256) { stoppedBecause = 'hash_mismatch'; break }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = now()
    try {
      const response = await fetchImpl(OFFICIAL, { method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: request.bytes })
      sent++
      let body = null
      try { body = await response.json() } catch { body = null }
      const usage = record(body?.usage) ? { input_tokens: body.usage.input_tokens ?? null, output_tokens: body.usage.output_tokens ?? null,
        cached_tokens: body.usage.input_tokens_details?.cached_tokens ?? null } : null
      const apiCode = record(body?.error) && typeof (body.error.code ?? body.error.type) === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(body.error.code ?? body.error.type) ? body.error.code ?? body.error.type : null
      results[request.id] = { status: response.status, elapsedMs: Math.round(now() - started), openaiProcessingMs: response.headers?.get?.('openai-processing-ms') ?? null,
        model: typeof body?.model === 'string' ? body.model : null, usage, ...(apiCode ? { apiCode } : {}), answers: Array.isArray(body?.answers) ? body.answers : [] }
      if (Number.isFinite(usage?.input_tokens)) inputTokens += usage.input_tokens
      if (response.status !== 200) { stoppedBecause = `http_${response.status}`; break }
      if (inputTokens > plan.tokenCeiling) { stoppedBecause = 'token_ceiling_reached'; break }
    } catch (error) {
      results[request.id] = { status: 0, elapsedMs: Math.round(now() - started), error: error?.name === 'AbortError' ? 'timeout' : 'network', answers: [] }
      stoppedBecause = results[request.id].error
      break
    } finally { clearTimeout(timer) }
  }
  const scored = plan.requests.map(request => scoreRequest(request, results[request.id]))
  const answered = scored.filter(row => row.state === 'answered')
  const scorecard = { requestsPassed: `${answered.filter(row => row.pass).length}/${plan.requests.length}`, answered: answered.length, notSent: scored.filter(row => row.state === 'not_sent').length,
    hardFailures: scored.reduce((sum, row) => sum + row.hardFailures.length, 0), softMisses: scored.reduce((sum, row) => sum + row.softMisses.length, 0),
    allAnsweredPassed: answered.length === plan.requests.length && answered.every(row => row.pass), requests: scored }
  return { ...base, sent, stoppedBecause, results, scorecard, usage: { inputTokens } }
}

/** Results go to a private file. An existing file is replaced and closed to others. The key is never part of `outcome`. */
export function writeResults(file, outcome, at = new Date()) {
  const payload = { set: outcome.set, at: at.toISOString(), endpoint: OFFICIAL, automaticRetries: 0, passRule: outcome.passRule,
    outcome: { sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, totals: outcome.totals, tokenCeiling: outcome.tokenCeiling, usage: outcome.usage }, results: outcome.results, scorecard: outcome.scorecard }
  writeFileSync(file, JSON.stringify(payload, null, 1), { mode: 0o600 })
  chmodSync(file, 0o600)
  return payload
}

/**
 * main(argv, { env, fetchImpl, print, printError, now }) → exit code. The CLI wrapper calls this; tests call it with a mock fetch.
 *   <plan.json>            dry run: validate, print the table, send nothing
 *   <plan.json> --send     real run (needs OPENAI_API_KEY); --out <file> writes the 0600 results file
 */
export async function main(argv, { env = {}, fetchImpl = globalThis.fetch, print = line => console.log(line), printError = line => console.error(line), now } = {}) {
  const args = [...argv]
  const flag = name => args.includes(name)
  const valueOf = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? null : null }
  const known = new Set(['--send', '--out'])
  const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--out')
  const unknown = args.find(arg => arg.startsWith('--') && !known.has(arg))
  if (unknown || positional.length !== 1 || (flag('--out') && !valueOf('--out'))) {
    printError('usage: egdesk-decision-real-measure.mjs <plan.json> [--out results.json] [--send]   (dry run unless --send; the key is read from OPENAI_API_KEY only)')
    return EXIT.usage
  }
  let plan
  try { plan = loadPlan(positional[0]) } catch (error) {
    printError(error?.name === 'PlanError' ? `plan refused: ${error.message}` : 'plan refused: unreadable plan')
    return EXIT.usage
  }
  const send = flag('--send')
  print(JSON.stringify({ set: plan.set, mode: send ? 'send' : 'dry_run', endpoint: OFFICIAL, requests: plan.totals.requests, bytes: plan.totals.bytes, estInputTokens: plan.totals.estInputTokens,
    independentEst: plan.totals.independentEst, tokenCeiling: plan.tokenCeiling, withinCeiling: plan.totals.estInputTokens <= plan.tokenCeiling,
    ...(plan.totals.independentEst > plan.totals.estInputTokens * 1.5 ? { warning: 'declared estimates are much lower than the independent estimate' } : {}), passRule: plan.passRule }))
  for (const row of planTable(plan)) print(JSON.stringify(row))
  const outcome = await runPlan({ plan, key: send ? env.OPENAI_API_KEY ?? null : null, send, fetchImpl, ...(now ? { now } : {}) })
  print(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens,
    ...(outcome.scorecard ? { requestsPassed: outcome.scorecard.requestsPassed, hardFailures: outcome.scorecard.hardFailures, softMisses: outcome.scorecard.softMisses } : {}) }))
  if (outcome.scorecard) for (const row of outcome.scorecard.requests) print(JSON.stringify({ id: row.id, state: row.state, pass: row.pass, hardFailures: row.hardFailures, softMisses: row.softMisses }))
  const out = valueOf('--out')
  if (out && outcome.sent > 0) writeResults(out, outcome)
  if (outcome.stoppedBecause === 'no_key') { printError('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); return EXIT.noKey }
  if (outcome.stoppedBecause === 'dry_run') return outcome.totals.estInputTokens > outcome.tokenCeiling ? EXIT.stopped : EXIT.ok
  return outcome.stoppedBecause ? EXIT.stopped : EXIT.ok
}
