import { seedRefusal } from './egdesk-scenario-seed-guard.mjs'
import { createDecisionTransport } from './egdesk-decision-transport.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
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
//                    { "name", "kind": "choice", "equals"?: value, "oneOf"?: [values], "minConfidence"?: 0..1,
//                      "minMargin"?: 0..1, "whenAccepted"?: { "minConfidence": 0..1, "minMargin": 0..1 }, "severity", "note" },
//                    { "name", "kind": "score", "min"?: level, "max"?: level, "minConfidence"?: 0..1, "maxConfidence"?: 0..1, "severity", "note" } ],
//        "recordOnly"?: true, "diagnostic"?: true, "waitBeforeMs"?: 0..120000 } ],
//    "transport"?: "product" }
// waitBeforeMs: the runner waits that long before sending the request (a latency probe's idle gap). It is a pause, never a retry; the
// total of all waits is bounded (REAL_RUN_LIMITS.maxTotalWaitMs). transport "product": send through the product's own Decisions transport
// (helper/egdesk-decision-transport.mjs: the bridge's keep-alive pool and idle window, no retry, redirects refused), and record before
// each request whether that transport had a warm socket (warmBefore), i.e. which turn-context budget the product would have used.
// A request passes when it has no failed hard check. An answer that is refused, missing or malformed fails its check.
// A request with no expectations is refused unless it says "recordOnly": true; a record-only request is sent and its answers kept,
// but it is never counted as passed (its state is "recorded"), so a pass can never mean "nothing was checked".
// A choice expectation with whenAccepted checks only an answer the product would install at that bar (confidence >= minConfidence and
// top minus the runner-up >= minMargin, the runner-up being at least the unreported mass): below the bar it passes, because nothing is
// installed; at or above it, the choice must be one of the expected values. A hard whenAccepted check therefore fails only on a wrong install.
// Any expectation may say "diagnostic": true: a deliberately looser (or otherwise non-product) check, exempt from the product-bar lint.
// "productBars" (optional, plan level) declares the bars the PRODUCT acts on, per question family (the name with digit runs as "#") or per kind:
//   { "<family>"|"*predicate"|"*choice"|"*score": { "yes"?, "no"?, "minConfidence"?, "minMargin"?, "source"? } }
// When it is present, a hard expectation looser than its bar is REFUSED at load (dry run and send alike): a predicate min below "yes",
// a max above "no", a choice without minConfidence/minMargin at least the bar, a whenAccepted check at a stricter bar than the product's
// (it would miss wrong installs the product makes), a score check without minConfidence at least the bar. A hard expectation with no
// declared bar for its family or kind is refused too. Without productBars, the runner prints that the checks were not compared.
// Every request body is checked with the grouped-question lint (helper/egdesk-decision-grouping.mjs): when one question family is asked
// about several items, each question must carry its own item. A request that fails is REFUSED (dry run and send) unless the request says
// "diagnostic": true (a deliberate reproduction, such as the contamination study's copy of the L1 c12 construction).
// A score expectation is the conjunction of the bounds it gives (min <= score <= max, minConfidence <= confidence <= maxConfidence).
const OFFICIAL = DECISIONS_ENDPOINT
if (OFFICIAL !== 'https://api.openai.com/v1/decisions') throw new Error('unexpected Decisions endpoint')
export const REAL_RUN_LIMITS = Object.freeze({ maxRequests: 200, maxBodyBytes: 4 * 1024 * 1024, timeoutMs: 20000, maxWaitMs: 120_000, maxTotalWaitMs: 600_000 })
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
  if (raw.diagnostic !== undefined && raw.diagnostic !== true) bad(`${where} ${raw.name}: diagnostic must be true when present`)
  const base = { name: raw.name, kind: raw.kind, severity: raw.severity, note: typeof raw.note === 'string' ? raw.note : '', ...(raw.diagnostic === true ? { diagnostic: true } : {}) }
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
    if (raw.minMargin !== undefined && !unit(raw.minMargin)) bad(`${where} ${raw.name}: minMargin must be a probability`)
    if (raw.whenAccepted !== undefined && raw.minMargin !== undefined) bad(`${where} ${raw.name}: give either minMargin or whenAccepted, not both`)
    if (raw.whenAccepted !== undefined) {
      const w = raw.whenAccepted
      if (!w || typeof w !== 'object' || Array.isArray(w) || Object.keys(w).sort().join() !== 'minConfidence,minMargin' || !unit(w.minConfidence) || !unit(w.minMargin))
        bad(`${where} ${raw.name}: whenAccepted needs exactly { minConfidence, minMargin }, both probabilities`)
      if (raw.minConfidence !== undefined) bad(`${where} ${raw.name}: give either minConfidence or whenAccepted, not both`)
    }
    return { ...base, ...(hasEquals ? { equals: raw.equals } : { oneOf: [...raw.oneOf] }), ...(raw.minConfidence !== undefined ? { minConfidence: raw.minConfidence } : {}),
      ...(raw.minMargin !== undefined ? { minMargin: raw.minMargin } : {}),
      ...(raw.whenAccepted !== undefined ? { whenAccepted: { minConfidence: raw.whenAccepted.minConfidence, minMargin: raw.whenAccepted.minMargin } } : {}), options: values.length }
  }
  if (raw.kind === 'score') {
    if (question.type !== 'score') bad(`${where} ${raw.name}: expected a score but the question is ${question.type}`)
    const top = question.levels.length - 1
    const keys = ['min', 'max', 'minConfidence', 'maxConfidence'].filter(key => raw[key] !== undefined)
    if (!keys.length) bad(`${where} ${raw.name}: a score expectation needs at least one of min, max, minConfidence, maxConfidence`)
    for (const key of ['min', 'max']) if (raw[key] !== undefined && !(typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= top)) bad(`${where} ${raw.name}: ${key} must be a level between 0 and ${top}`)
    for (const key of ['minConfidence', 'maxConfidence']) if (raw[key] !== undefined && !unit(raw[key])) bad(`${where} ${raw.name}: ${key} must be a probability`)
    if (raw.min !== undefined && raw.max !== undefined && raw.min > raw.max) bad(`${where} ${raw.name}: min must be <= max`)
    if (raw.minConfidence !== undefined && raw.maxConfidence !== undefined && raw.minConfidence > raw.maxConfidence) bad(`${where} ${raw.name}: minConfidence must be <= maxConfidence`)
    return { ...base, ...Object.fromEntries(keys.map(key => [key, raw[key]])), levels: question.levels.length }
  }
  return bad(`${where} ${raw.name}: kind must be "predicate", "choice" or "score"`)
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
    if (item.recordOnly !== undefined && item.recordOnly !== true) bad(`${item.id}: recordOnly must be true when present`)
    const recordOnly = item.recordOnly === true
    if (!item.expect.length && !recordOnly) bad(`${item.id}: no expectations; add expectations, or mark the request "recordOnly": true (it will be sent and kept, never counted as passed)`)
    if (item.expect.length && recordOnly) bad(`${item.id}: a recordOnly request carries no expectations`)
    const expect = item.expect.map(entry => checkExpectation(entry, item.id, body.questions))
    if (item.diagnostic !== undefined && item.diagnostic !== true) bad(`${item.id}: diagnostic must be true when present`)
    // Scenario seeds (helper/egdesk-scenario-seed-guard.mjs): a body carrying a local-only seed's material, or a declared seed that is not
    // owner-approved, or an owner-approved seed's material with a secret left in it, is refused at load (dry run and send alike).
    const seedProblem = seedRefusal(bytes.toString('utf8'), { declared: [...(Array.isArray(raw.seeds) ? raw.seeds : []), ...(Array.isArray(item.seeds) ? item.seeds : [])] })
    if (seedProblem) bad(`${item.id}: ${seedProblem}`)
    if (item.waitBeforeMs !== undefined && (!Number.isSafeInteger(item.waitBeforeMs) || item.waitBeforeMs < 0 || item.waitBeforeMs > REAL_RUN_LIMITS.maxWaitMs)) bad(`${item.id}: waitBeforeMs must be an integer from 0 to ${REAL_RUN_LIMITS.maxWaitMs}`)
    const grouping = lintGroupedRequest(body)
    if (!grouping.ok && item.diagnostic !== true) bad(`${item.id}: grouped questions do not each carry their own item (${grouping.families.filter(f => f.problems.length).map(f => `${f.family}: ${[...new Set(f.problems.map(x => x.problem))].join('/')}`).join('; ')}); fix the request, or mark it "diagnostic": true if it reproduces the defect on purpose`)
    const counts = { choice: body.questions.filter(q => q.type === 'choice').length, predicate: body.questions.filter(q => q.type === 'predicate').length, score: body.questions.filter(q => q.type === 'score').length }
    const text = bytes.toString('utf8')
    return { id: item.id, file: item.file, sha256: item.sha256, bytes, estInputTokens: item.estInputTokens, independentEst: independentEstimate(counts.choice, counts.predicate + counts.score, bytes.length),
      questions: body.questions, counts, images: (text.match(/"type"\s*:\s*"input_image"/g) || []).length, expect, recordOnly, diagnostic: item.diagnostic === true, groupingOk: grouping.ok, waitBeforeMs: item.waitBeforeMs ?? 0 }
  })
  if (raw.transport !== undefined && raw.transport !== 'product') bad('transport must be "product" when present')
  const totalWaitMs = requests.reduce((sum, r) => sum + r.waitBeforeMs, 0)
  if (totalWaitMs > REAL_RUN_LIMITS.maxTotalWaitMs) bad(`the waits add up to ${totalWaitMs} ms, over ${REAL_RUN_LIMITS.maxTotalWaitMs}`)
  const productBars = checkProductBars(raw.productBars)
  if (productBars) {
    const problems = requests.flatMap(r => r.expect.filter(e => e.severity === 'hard' && !e.diagnostic).map(e => lintExpectation(e, r, productBars)).filter(Boolean).map(text => `${r.id} ${text}`))
    if (problems.length) bad(`hard checks looser than the declared product bars (mark a deliberate one "diagnostic": true): ${problems.join('; ')}`)
  }
  const totals = { requests: requests.length, estInputTokens: requests.reduce((sum, r) => sum + r.estInputTokens, 0), independentEst: requests.reduce((sum, r) => sum + r.independentEst, 0),
    bytes: requests.reduce((sum, r) => sum + r.bytes.length, 0) }
  return { set: raw.set, tokenCeiling: raw.tokenCeiling, passRule: raw.passRule, dir, requests, totals: { ...totals, waitMs: totalWaitMs }, productBars, transport: raw.transport ?? null,
    diagnostic: requests.reduce((n, r) => n + r.expect.filter(e => e.diagnostic).length, 0) }
}

export const familyOf = name => String(name).replace(/\d+/g, '#')
const BAR_KEYS = ['yes', 'no', 'minConfidence', 'minMargin', 'source']
function checkProductBars(raw) {
  if (raw === undefined) return null
  if (!record(raw) || !Object.keys(raw).length) bad('productBars must be an object of { family|*predicate|*choice|*score: bars }')
  const out = {}
  for (const [key, bars] of Object.entries(raw)) {
    if (!record(bars) || Object.keys(bars).some(k => !BAR_KEYS.includes(k))) bad(`productBars ${key}: only ${BAR_KEYS.join(', ')}`)
    for (const k of ['yes', 'no', 'minConfidence', 'minMargin']) if (bars[k] !== undefined && !unit(bars[k])) bad(`productBars ${key}.${k} must be a probability`)
    if (bars.yes !== undefined && bars.no !== undefined && !(bars.no < bars.yes)) bad(`productBars ${key}: no must be below yes`)
    if (bars.source !== undefined && typeof bars.source !== 'string') bad(`productBars ${key}.source must be text`)
    out[key] = { ...bars }
  }
  return out
}
/** null when the hard expectation is at least as strict as the product bar; otherwise the reason. */
export function lintExpectation(e, request, productBars) {
  const bar = productBars[familyOf(e.name)] ?? productBars[`*${e.kind}`]
  if (!bar) return `${e.name}: no product bar declared for family ${familyOf(e.name)} or kind ${e.kind}`
  const at = `${e.name} (${familyOf(e.name)})`
  if (e.kind === 'predicate') {
    if (e.min !== undefined) { if (bar.yes === undefined) return `${at}: no "yes" bar declared`; if (e.min < bar.yes) return `${at}: min ${e.min} < product yes bar ${bar.yes}` }
    if (e.max !== undefined) { if (bar.no === undefined) return `${at}: no "no" bar declared`; if (e.max > bar.no) return `${at}: max ${e.max} > product no bar ${bar.no}` }
    return null
  }
  if (e.kind === 'choice') {
    if (bar.minConfidence === undefined && bar.minMargin === undefined) return `${at}: no choice bar declared`
    if (e.whenAccepted) {
      if (bar.minConfidence !== undefined && e.whenAccepted.minConfidence > bar.minConfidence) return `${at}: whenAccepted confidence ${e.whenAccepted.minConfidence} > product ${bar.minConfidence} (would miss wrong installs)`
      if (bar.minMargin !== undefined && e.whenAccepted.minMargin > bar.minMargin) return `${at}: whenAccepted margin ${e.whenAccepted.minMargin} > product ${bar.minMargin} (would miss wrong installs)`
      return null
    }
    if (bar.minConfidence !== undefined && !(e.minConfidence >= bar.minConfidence)) return `${at}: minConfidence ${e.minConfidence ?? 'none'} < product ${bar.minConfidence}`
    if (bar.minMargin !== undefined && !(e.minMargin >= bar.minMargin)) return `${at}: minMargin ${e.minMargin ?? 'none'} < product ${bar.minMargin}`
    return null
  }
  if (e.kind === 'score') {
    if (bar.minConfidence === undefined) return `${at}: no score confidence bar declared`
    if (!(e.minConfidence >= bar.minConfidence)) return `${at}: minConfidence ${e.minConfidence ?? 'none'} < product ${bar.minConfidence}`
    return null
  }
  return `${at}: unknown kind`
}

export function planTable(plan) {
  return plan.requests.map(r => ({ id: r.id, bytes: r.bytes.length, sha: r.sha256.slice(0, 12), choice: r.counts.choice, predicate: r.counts.predicate, score: r.counts.score, images: r.images,
    estInputTokens: r.estInputTokens, independentEst: r.independentEst, recordOnly: r.recordOnly, ...(r.waitBeforeMs ? { waitBeforeMs: r.waitBeforeMs } : {}), ...(r.diagnostic ? { diagnostic: true } : {}), ...(r.groupingOk ? {} : { groupingLint: 'fails' }), hard: r.expect.filter(e => e.severity === 'hard').length, soft: r.expect.filter(e => e.severity === 'soft').length }))
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
  if (expectation.kind === 'score') {
    if (answer?.type !== 'score') return { ...out, pass: false, observed: { state: answer?.type ?? 'missing' } }
    const bounds = Object.fromEntries(['min', 'max', 'minConfidence', 'maxConfidence'].filter(key => expectation[key] !== undefined).map(key => [key, expectation[key]]))
    const failed = [
      ...(expectation.min !== undefined && !(answer.score >= expectation.min) ? ['below_min'] : []),
      ...(expectation.max !== undefined && !(answer.score <= expectation.max) ? ['above_max'] : []),
      ...(expectation.minConfidence !== undefined && !(answer.confidence >= expectation.minConfidence) ? ['below_min_confidence'] : []),
      ...(expectation.maxConfidence !== undefined && !(answer.confidence <= expectation.maxConfidence) ? ['above_max_confidence'] : []),
    ]
    const ranked = answer.probabilities || []
    return { ...out, ...bounds, pass: failed.length === 0, ...(failed.length ? { reason: failed.join('+') } : {}),
      observed: { score: answer.score, confidence: answer.confidence, top: ranked[0]?.probability ?? null, topLevel: ranked[0]?.value ?? null, levels: expectation.levels } }
  }
  if (answer?.type !== 'choice') return { ...out, pass: false, observed: { state: answer?.type ?? 'missing' } }
  const ranked = answer.probabilities || []
  const top = ranked[0]?.probability ?? null, second = ranked[1]?.probability ?? null
  const wanted = expectation.equals !== undefined ? [expectation.equals] : expectation.oneOf
  const picked = wanted.includes(answer.choice)
  const confident = expectation.minConfidence === undefined || answer.confidence >= expectation.minConfidence
  const observed = { choice: answer.choice, confidence: answer.confidence, top, second, margin: top !== null && second !== null ? Math.round((top - second) * 1e6) / 1e6 : null, options: expectation.options }
  const head = { ...out, ...(expectation.equals !== undefined ? { equals: expectation.equals } : { oneOf: expectation.oneOf }), ...(expectation.minConfidence !== undefined ? { minConfidence: expectation.minConfidence } : {}),
    ...(expectation.minMargin !== undefined ? { minMargin: expectation.minMargin } : {}) }
  // The product's margin: the chosen value's probability minus the best other one, the unreported mass counting as another one.
  const chosen = ranked.find(row => row.value === answer.choice)?.probability ?? top
  const rest = ranked.filter(row => row.value !== answer.choice).map(row => row.probability)
  const unreported = Math.max(0, 1 - ranked.reduce((sum, row) => sum + (Number.isFinite(row.probability) ? row.probability : 0), 0))
  const runnerUp = Math.max(0, ...rest, ranked.length < expectation.options ? unreported : 0)
  const productMargin = Number.isFinite(chosen) ? chosen - runnerUp : null
  if (expectation.whenAccepted) {
    const { minConfidence, minMargin } = expectation.whenAccepted
    const accepted = Number.isFinite(answer.confidence) && answer.confidence >= minConfidence && Number.isFinite(chosen) && chosen - runnerUp >= minMargin - 1e-9
    return { ...head, whenAccepted: expectation.whenAccepted, pass: !accepted || picked, ...(accepted && !picked ? { reason: 'wrong_install' } : {}), observed: { ...observed, accepted } }
  }
  const wide = expectation.minMargin === undefined || (productMargin !== null && productMargin >= expectation.minMargin - 1e-9)
  return { ...head, pass: picked && confident && wide, ...(!picked ? { reason: 'other_choice' } : !confident ? { reason: 'below_min_confidence' } : !wide ? { reason: 'below_min_margin' } : {}),
    observed: expectation.minMargin !== undefined ? { ...observed, productMargin: Math.round(productMargin * 1e6) / 1e6 } : observed }
}

export function scoreRequest(request, result) {
  if (!result) return { id: request.id, state: 'not_sent', pass: false, hardFailures: [], softMisses: [], checks: [] }
  if (result.status !== 200) return { id: request.id, state: 'failed', pass: false, hardFailures: [], softMisses: [], checks: [] }
  let answers = {}
  // A record-only request was checked against nothing: it is never a pass.
  if (request.recordOnly) return { id: request.id, state: 'recorded', pass: null, hardFailures: [], softMisses: [], checks: [] }
  try { answers = normalizeDecisionResponse({ answers: result.answers }, request.questions).answers } catch { answers = {} }
  const checks = request.expect.map(expectation => scoreExpectation(expectation, answers[expectation.name]))
  const hardChecks = checks.filter(check => check.severity === 'hard'), softChecks = checks.filter(check => check.severity === 'soft')
  const hardFailures = hardChecks.filter(check => !check.pass).map(check => check.name)
  return { id: request.id, state: 'answered', pass: hardFailures.length === 0, hard: { passed: hardChecks.length - hardFailures.length, total: hardChecks.length },
    soft: { passed: softChecks.filter(check => check.pass).length, total: softChecks.length }, hardFailures, softMisses: softChecks.filter(check => !check.pass).map(check => check.name), checks }
}

/**
 * runPlan({ plan, key, send = false, fetchImpl = fetch, timeoutMs, now }) → { set, sent, stoppedBecause, results, scorecard, totals, tokenCeiling, usage }
 * send !== true: a dry run; nothing leaves the process and no key is looked at.
 */
export async function runPlan({ plan, key = null, send = false, fetchImpl = globalThis.fetch, timeoutMs = REAL_RUN_LIMITS.timeoutMs, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), warm = null, annotate = null } = {}) {
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
    if (seedRefusal(request.bytes.toString('utf8'))) { stoppedBecause = 'scenario_seed'; break }
    // A latency probe's idle gap: a pause before this request, never a second attempt of anything.
    if (request.waitBeforeMs > 0) await sleep(request.waitBeforeMs)
    let warmBefore = null
    if (typeof warm === 'function') { try { warmBefore = warm() === true } catch { warmBefore = null } }
    const probe = { ...(request.waitBeforeMs > 0 ? { waitedMs: request.waitBeforeMs } : {}), ...(warmBefore !== null ? { warmBefore } : {}) }
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
      const phases = typeof annotate === 'function' ? annotate() ?? {} : {}
      results[request.id] = { ...probe, ...phases, status: response.status, elapsedMs: Math.round(now() - started), openaiProcessingMs: response.headers?.get?.('openai-processing-ms') ?? null,
        model: typeof body?.model === 'string' ? body.model : null, usage, ...(apiCode ? { apiCode } : {}), answers: Array.isArray(body?.answers) ? body.answers : [] }
      if (Number.isFinite(usage?.input_tokens)) inputTokens += usage.input_tokens
      if (response.status !== 200) { stoppedBecause = `http_${response.status}`; break }
      if (inputTokens > plan.tokenCeiling) { stoppedBecause = 'token_ceiling_reached'; break }
    } catch (error) {
      const phases = typeof annotate === 'function' ? annotate() ?? {} : {}
      results[request.id] = { ...probe, ...phases, status: 0, elapsedMs: Math.round(now() - started), error: error?.name === 'AbortError' ? 'timeout' : 'network', answers: [] }
      stoppedBecause = results[request.id].error
      break
    } finally { clearTimeout(timer) }
  }
  const scored = plan.requests.map(request => scoreRequest(request, results[request.id]))
  const answered = scored.filter(row => row.state === 'answered'), checked = plan.requests.filter(request => !request.recordOnly).length
  // requestsPassed counts only requests that were checked; record-only requests are reported apart and never as passed.
  const scorecard = { requestsPassed: `${answered.filter(row => row.pass).length}/${checked}`, answered: answered.length, recordedOnly: scored.filter(row => row.state === 'recorded').length,
    notSent: scored.filter(row => row.state === 'not_sent').length,
    hardFailures: scored.reduce((sum, row) => sum + row.hardFailures.length, 0), softMisses: scored.reduce((sum, row) => sum + row.softMisses.length, 0),
    allAnsweredPassed: checked > 0 && answered.length === checked && answered.every(row => row.pass), requests: scored }
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
/** Numbers only, from the product transport's data-free trace of one request: socket reuse and connection phases in ms. */
export function transportPhases(marks) {
  const at = phase => marks.find(m => m.phase === phase)?.t, start = at('start')
  if (!Number.isFinite(start)) return {}
  const ms = t => (Number.isFinite(t) ? Math.round(t - start) : null)
  const out = { reusedSocket: marks.some(m => m.reused === true) }
  for (const [name, phase] of [['dnsMs', 'lookup'], ['connectMs', 'connect'], ['tlsMs', 'secureConnect'], ['responseMs', 'response']]) { const v = ms(at(phase)); if (v !== null) out[name] = v }
  return out
}

export async function main(argv, { env = {}, fetchImpl = globalThis.fetch, print = line => console.log(line), printError = line => console.error(line), now, sleep, createTransport = createDecisionTransport } = {}) {
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
    ...(plan.totals.independentEst > plan.totals.estInputTokens * 1.5 ? { warning: 'declared estimates are much lower than the independent estimate' } : {}),
    ...(plan.totals.waitMs ? { waitMs: plan.totals.waitMs } : {}), ...(plan.transport ? { transport: plan.transport } : {}), passRule: plan.passRule }))
  for (const row of planTable(plan)) print(JSON.stringify(row))
  print(JSON.stringify(plan.productBars ? { productBars: 'declared and checked', families: Object.keys(plan.productBars), diagnosticChecks: plan.diagnostic }
    : { productBars: 'not declared', warning: 'hard checks were NOT compared with the bars the product acts on' }))
  // transport "product": the bridge's own Decisions transport, created only when something is really sent.
  const marks = []
  const transport = send && plan.transport === 'product' ? createTransport({ trace: mark => marks.push(mark) }) : null
  const outcome = await runPlan({ plan, key: send ? env.OPENAI_API_KEY ?? null : null, send, fetchImpl: transport ? transport.fetch : fetchImpl,
    ...(transport?.warm ? { warm: () => transport.warm(), annotate: () => transportPhases(marks.splice(0)) } : {}), ...(now ? { now } : {}), ...(sleep ? { sleep } : {}) })
  try { transport?.close?.() } catch { /* nothing to close */ }
  print(JSON.stringify({ sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens,
    ...(outcome.scorecard ? { requestsPassed: outcome.scorecard.requestsPassed, recordedOnly: outcome.scorecard.recordedOnly, hardFailures: outcome.scorecard.hardFailures, softMisses: outcome.scorecard.softMisses } : {}) }))
  if (outcome.scorecard) for (const row of outcome.scorecard.requests) print(JSON.stringify({ id: row.id, state: row.state, pass: row.pass,
    ...(row.hard ? { hard: `${row.hard.passed}/${row.hard.total}`, soft: `${row.soft.passed}/${row.soft.total}` } : {}), hardFailures: row.hardFailures, softMisses: row.softMisses }))
  const declared = outcome.totals.estInputTokens
  print(JSON.stringify({ usageTotal: { inputTokens: outcome.usage.inputTokens, declaredEstimate: declared, tokenCeiling: outcome.tokenCeiling, requestsSent: outcome.sent } }))
  const out = valueOf('--out')
  if (out && outcome.sent > 0) writeResults(out, outcome)
  if (outcome.stoppedBecause === 'no_key') { printError('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); return EXIT.noKey }
  if (outcome.stoppedBecause === 'dry_run') return outcome.totals.estInputTokens > outcome.tokenCeiling ? EXIT.stopped : EXIT.ok
  return outcome.stoppedBecause ? EXIT.stopped : EXIT.ok
}
