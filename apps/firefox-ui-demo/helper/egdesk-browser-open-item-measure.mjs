import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DECISIONS_ENDPOINT, createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { createBrowserTaskStore } from './egdesk-browser-task.mjs'
import { decideOpenItem, optionQuestionName, openItemOptions } from './egdesk-browser-open-items.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'
import { seedRefusal } from './egdesk-scenario-seed-guard.mjs'

// L8 c38: Decisions-only measurement of the open browser task's option predicates (helper/egdesk-browser-open-items.mjs) on short realistic replies after a
// hand-over. Pre-registered in scripts/egdesk-browser-open-item-plan.json (replies, the outcome each should have, the acceptable set, the prediction).
//  - The requests are the PRODUCT's own (decideOpenItem on a task built by the product's store): nothing is hand-written here, so a wording change in the product is
//    what the next measurement sees. No page, no engine, no network for anything but the Decision request.
//  - Only with send === true and a key the caller read from one environment variable; official endpoint only; no retries; the request limit and the input-token ceiling
//    are checked before every request; the first failed request stops the run. The key is never logged, stored or returned.
//  - Verdicts are computed by code from the plan: correct, acceptable (another acceptable option, or not settled where the plan allows it), safe_miss (not settled where
//    an option was wanted: never an error of safety), wrong (settled to an option outside the acceptable set: the unsafe error). The plan passes when no reply is wrong.
const OFFICIAL = 'https://api.openai.com/v1/decisions'
if (DECISIONS_ENDPOINT !== OFFICIAL) throw new Error('unexpected Decisions endpoint')
export const OPEN_ITEM_PLAN_FILE = new URL('../scripts/egdesk-browser-open-item-plan.json', import.meta.url)
// c40: v1 = the plan as sent (c57, 19:08), v2 = the same replies with the c40 option wording and its own pre-registered predictions
export const OPEN_ITEM_PLAN_FILES = Object.freeze({ v1: OPEN_ITEM_PLAN_FILE, v2: new URL('../scripts/egdesk-browser-open-item-plan-v2.json', import.meta.url) })
export const OPEN_ITEM_HARD_LIMITS = Object.freeze({ maxRequests: 12, tokenCeiling: 14000 }) // the plan's own default ceiling is 4000; --budget raises it, never past this (c40: the narrowed wording is ~90 tokens longer per request: 12 replies are about 13.4k)
const NOW = Date.parse('2026-11-25T10:00:00Z')

export function loadOpenItemPlan(file = OPEN_ITEM_PLAN_FILE) {
  const bytes = readFileSync(file)
  const plan = JSON.parse(bytes.toString('utf8'))
  const bad = []
  const options = new Set(['continue', 'retry', 'abandon', 'ask_page', 'change'])
  if (typeof plan.set !== 'string') bad.push('set')
  if (!(plan.task && typeof plan.task.goal === 'string' && plan.task.pause?.kind && plan.task.pause?.code && typeof plan.task.question === 'string')) bad.push('task')
  if (!(Number.isSafeInteger(plan.maxRequests) && plan.maxRequests >= 1 && plan.maxRequests <= OPEN_ITEM_HARD_LIMITS.maxRequests)) bad.push('maxRequests')
  if (!(Number.isSafeInteger(plan.tokenCeiling) && plan.tokenCeiling >= 1 && plan.tokenCeiling <= OPEN_ITEM_HARD_LIMITS.tokenCeiling)) bad.push('tokenCeiling')
  const ids = new Set()
  for (const reply of Array.isArray(plan.replies) ? plan.replies : []) {
    if (!(typeof reply.id === 'string' && !ids.has(reply.id) && typeof reply.message === 'string' && reply.message.trim())) bad.push(`reply ${reply.id}`)
    ids.add(reply.id)
    if (!(reply.want === 'none' || options.has(reply.want))) bad.push(`${reply.id}.want`)
    if (!(Array.isArray(reply.acceptable) && reply.acceptable.every(id => options.has(id)))) bad.push(`${reply.id}.acceptable`)
    if (reply.uncertainOk !== undefined && reply.uncertainOk !== true) bad.push(`${reply.id}.uncertainOk`)
    if (reply.want !== 'none' && !reply.acceptable.includes(reply.want)) bad.push(`${reply.id}: the wanted option is acceptable`)
    const total = Object.values(reply.predicted ?? {}).reduce((a, b) => a + b, 0)
    if (!(total > 0.99 - 0.0001 && total < 1.01) || !reply.note) bad.push(`${reply.id}: prediction sums to 1 and has a note`)
  }
  if (!(plan.replies?.length >= 1 && plan.replies.length <= plan.maxRequests)) bad.push('replies within maxRequests')
  if (!(Array.isArray(plan.dropOrder) && plan.dropOrder.length === ids.size && plan.dropOrder.every(id => ids.has(id)) && new Set(plan.dropOrder).size === ids.size)) bad.push('dropOrder names every reply once')
  if (bad.length) throw new Error(`bad open-item plan: ${bad.join('; ')}`)
  return Object.freeze({ ...plan, sha256: createHash('sha256').update(bytes).digest('hex') })
}

/** The open task of the plan, built by the product's own store (the state a hand-over leaves). */
export function planTask(plan) {
  const store = createBrowserTaskStore({ now: () => NOW })
  const task = store.create({ conversationKey: 'dm', cardId: 'card', goal: plan.task.goal })
  task.status = 'paused'; task.pause = { ...plan.task.pause }; task.steps = plan.task.steps ?? 1; task.question = plan.task.question
  return task
}

/** verdict(reply, read) -> 'correct' | 'acceptable' | 'safe_miss' | 'wrong' (by code, from the plan alone). */
export function verdict(reply, read) {
  if (read.kind === 'settled') {
    if (reply.want !== 'none' && read.optionId === reply.want) return 'correct'
    return reply.acceptable.includes(read.optionId) ? 'acceptable' : 'wrong'
  }
  if (read.kind === 'none') return reply.want === 'none' ? 'correct' : 'safe_miss'
  // uncertain: nothing was applied. Where the plan wants none, or says not settling is right (uncertainOk: a message that asks for two things), it is acceptable; otherwise it is a miss that costs only a turn.
  return reply.want === 'none' || reply.uncertainOk === true ? 'acceptable' : 'safe_miss'
}

export function scoreOpenItemRun(plan, rows) {
  const by = name => rows.filter(r => r.verdict === name).length
  const ran = rows.length
  return { ran, notRun: plan.replies.length - ran, correct: by('correct'), acceptable: by('acceptable'), safeMiss: by('safe_miss'), wrong: by('wrong'),
    wrongReplies: rows.filter(r => r.verdict === 'wrong').map(r => r.id), pass: ran === plan.replies.length && by('wrong') === 0 }
}

/**
 * selectReplies(plan, budget) -> { kept, dropped, estInputTokens }: the replies that fit the token budget by the typed estimate, dropping in the plan's pre-registered order
 * (first dropped first). The estimate is of the product's own request for each reply (sizes from the stand-in; nothing is sent).
 */
export async function selectReplies(plan, budget = plan.tokenCeiling) {
  const sized = await runOpenItemPlan({ plan: { ...plan, tokenCeiling: OPEN_ITEM_HARD_LIMITS.tokenCeiling * 100 }, scripted: standIn(plan), unbounded: true })
  const est = Object.fromEntries(sized.requests.map(r => [r.id, r.estInputTokens]))
  const dropped = []
  let total = plan.replies.reduce((sum, r) => sum + (est[r.id] ?? 0), 0)
  for (const id of plan.dropOrder) { if (total <= budget) break; dropped.push(id); total -= est[id] ?? 0 }
  return { kept: plan.replies.filter(r => !dropped.includes(r.id)).map(r => r.id), dropped, estInputTokens: total, perReply: est }
}

const sha = text => createHash('sha256').update(text).digest('hex')

function guardedFetch({ record, limits, fetchImpl, scripted }) {
  const refuse = why => { record.stopped ??= why; throw Object.assign(new Error(`measurement stopped: ${why}`), { name: 'MeasurementStopped' }) }
  return async (url, init) => {
    if (url !== OFFICIAL) refuse('unofficial_endpoint')
    if (record.stopped) refuse(record.stopped)
    let body
    try { body = JSON.parse(init.body) } catch { refuse('bad_request_body') }
    const questions = body.questions ?? [], bytes = Buffer.byteLength(init.body, 'utf8')
    const estimate = estimateTokens(0, questions.length, bytes)
    if (!scripted && seedRefusal(init.body)) refuse('scenario_seed')
    if (record.requests.length >= limits.maxRequests) refuse('request_limit')
    if (record.tokens + estimate > limits.tokenCeiling) refuse('token_ceiling')
    const row = { id: record.current, names: questions.map(q => q.name), bytes, sha256: sha(init.body), estInputTokens: estimate, status: null, inputTokens: null }
    record.requests.push(row)
    let response
    if (scripted) response = { ok: true, status: 200, text: async () => JSON.stringify({ answers: scripted(body), usage: { input_tokens: estimate } }) }
    else { try { response = await fetchImpl(url, init) } catch (error) { row.status = 'network'; record.tokens += estimate; record.stopped ??= 'network'; throw error } }
    row.status = response.status ?? 200
    let text = null, parsed = null
    try { text = await response.text(); parsed = JSON.parse(text) } catch { parsed = null }
    const used = parsed?.usage?.input_tokens
    row.inputTokens = Number.isFinite(used) ? used : null
    record.tokens += Number.isFinite(used) ? used : estimate
    if (row.status !== 200) record.stopped ??= `http_${row.status}`
    return { ok: row.status === 200, status: row.status, text: async () => text ?? '' }
  }
}

/** The stand-in for the dry estimate and the tests only (NOT a model): it answers each predicate as the plan's own `want` says. */
export function standIn(plan) {
  return body => {
    const message = /User message: (.*)/.exec(body.input?.[1]?.content ?? '')?.[1] ?? ''
    const reply = plan.replies.find(r => r.message === message)
    const yes = new Set(reply ? (reply.want === 'none' ? [] : reply.uncertainOk === true ? reply.acceptable : [reply.want]) : [])
    return body.questions.map(q => ({ name: q.name, type: 'predicate', probability: yes.has(q.name.replace(/^open_browser_/, '')) ? 0.97 : 0.03 }))
  }
}

export async function runOpenItemPlan({ plan = loadOpenItemPlan(), key = null, send = false, fetchImpl = globalThis.fetch, scripted = null, budget = null, unbounded = false } = {}) {
  const limits = unbounded ? { maxRequests: 1000, tokenCeiling: Number.MAX_SAFE_INTEGER } : { maxRequests: Math.min(plan.maxRequests, OPEN_ITEM_HARD_LIMITS.maxRequests), tokenCeiling: Math.min(budget ?? plan.tokenCeiling, OPEN_ITEM_HARD_LIMITS.tokenCeiling) }
  const chosen = unbounded ? { kept: plan.replies.map(r => r.id), dropped: [] } : await selectReplies(plan, limits.tokenCeiling)
  const planned = plan.replies.filter(r => chosen.kept.includes(r.id))
  const empty = why => ({ sent: 0, stoppedBecause: why, rows: [], requests: [], usage: { inputTokens: 0 }, limits, dropped: chosen.dropped, planSha256: plan.sha256, score: null })
  const realRun = send === true && scripted === null
  if (scripted === null && send !== true) return empty('dry_run')
  if (realRun && (typeof key !== 'string' || key.length < 20 || /\s/.test(key))) return empty('no_key')
  const record = { requests: [], tokens: 0, stopped: null, current: null }
  const apiKey = realRun ? key : 'egd-synthetic-not-a-key-0008' // the stand-in never sends
  const client = createDecisionClient({ getApiKey: async () => apiKey, recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model),
    fetchImpl: guardedFetch({ record, limits, fetchImpl, scripted: realRun ? null : scripted ?? standIn(plan) }) })
  const rows = []
  for (const reply of planned) {
    if (record.stopped) break
    record.current = reply.id
    const task = planTask(plan)
    try {
      const read = await decideOpenItem({ message: reply.message, task, change: plan.task.change === true, client })
      rows.push({ id: reply.id, message: reply.message, want: reply.want, acceptable: reply.acceptable, kind: read.kind, optionId: read.optionId ?? null, p: read.p, verdict: verdict(reply, read), ms: read.ms })
    } catch (error) { record.stopped ??= error?.name === 'MeasurementStopped' ? record.stopped : `error_${error?.code ?? 'unknown'}`; break }
  }
  return { sent: record.requests.length, stoppedBecause: record.stopped, rows, requests: record.requests, usage: { inputTokens: record.tokens }, limits, dropped: chosen.dropped, planSha256: plan.sha256, score: scoreOpenItemRun({ ...plan, replies: planned }, rows) }
}

export { optionQuestionName, openItemOptions }
