import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { codeEntryCard, decideBrowserEntry, readBrowserEntry } from './egdesk-browser-task.mjs'
import { guardedFetch } from './egdesk-browser-open-item-measure.mjs'

// L8 c43: L2's side question from V2 (c60): does a message that names no place but matches the open page count as a page task? Decisions only (no page, no engine).
// The request is the PRODUCT's own entry request: decideBrowserEntry is run once with a capturing stand-in client to get the exact body it would send (the follow-up it might ask is
// captured, never sent), and that body goes out unchanged through the guarded Decision client. The outcome is read by the product's own readBrowserEntry. Pre-registered in
// scripts/egdesk-entry-placeless-plan.json. Verdicts by code from the plan alone.
export const ENTRY_PLACELESS_PLAN_FILE = new URL('../scripts/egdesk-entry-placeless-plan.json', import.meta.url)
export const ENTRY_PLACELESS_HARD = Object.freeze({ maxRequests: 13, tokenCeiling: 8000 })
const sha = text => createHash('sha256').update(text).digest('hex')

export function loadEntryPlacelessPlan(file = ENTRY_PLACELESS_PLAN_FILE) {
  const bytes = readFileSync(file)
  const plan = JSON.parse(bytes.toString('utf8'))
  const bad = [], ids = new Set()
  if (!(plan.evidence && Object.values(plan.evidence).every(e => e.card?.host && e.card?.title))) bad.push('evidence')
  if (!(Number.isSafeInteger(plan.maxRequests) && plan.maxRequests <= ENTRY_PLACELESS_HARD.maxRequests)) bad.push('maxRequests')
  if (!(Number.isSafeInteger(plan.tokenCeiling) && plan.tokenCeiling <= ENTRY_PLACELESS_HARD.tokenCeiling)) bad.push('tokenCeiling')
  for (const r of Array.isArray(plan.replies) ? plan.replies : []) {
    if (!(typeof r.id === 'string' && !ids.has(r.id) && r.message?.trim() && plan.evidence?.[r.evidence])) bad.push(`reply ${r.id}`)
    ids.add(r.id)
    if (!['enter', 'not'].includes(r.want) || !(Array.isArray(r.acceptable) && r.acceptable.every(o => ['enter', 'not'].includes(o)))) bad.push(`${r.id}.want`)
    const total = Object.values(r.predicted ?? {}).reduce((a, b) => a + b, 0)
    if (!(total > 0.989 && total < 1.011)) bad.push(`${r.id}: prediction sums to 1`)
  }
  if (!(plan.replies?.length >= 1 && plan.replies.length <= plan.maxRequests)) bad.push('replies within maxRequests')
  if (!(Array.isArray(plan.dropOrder) && plan.dropOrder.every(id => ids.has(id)) && new Set(plan.dropOrder).size === plan.dropOrder.length)) bad.push('dropOrder')
  if (bad.length) throw new Error(`bad entry-placeless plan: ${bad.join('; ')}`)
  return Object.freeze({ ...plan, sha256: createHash('sha256').update(bytes).digest('hex') })
}

const cardsOf = (plan, reply) => [{ ...plan.evidence[reply.evidence].card }]

/** The product's own first entry request for this reply: decideBrowserEntry run against a stand-in that records what it is asked. */
export async function captureEntryRequest(plan, reply) {
  const cards = cardsOf(plan, reply), asked = []
  const stand = { decide: async request => { asked.push(request); return { answers: Object.fromEntries(request.questions.map(q => [q.name, { type: 'predicate', probability: 0.5 }])), usage: null } } }
  await decideBrowserEntry({ message: reply.message, cards, client: stand })
  return { request: asked[0], cards, followUps: asked.length - 1 }
}

export const entryVerdict = (reply, outcome) => (reply.want === 'enter' ? (outcome === 'enter' ? 'correct' : reply.acceptable.includes('not') ? 'acceptable' : 'safe_miss') : (outcome === 'not' ? 'correct' : 'wrong'))

export function scoreEntry(plan, rows) {
  const by = v => rows.filter(r => r.verdict === v).length
  return { ran: rows.length, notRun: plan.replies.length - rows.length, correct: by('correct'), acceptable: by('acceptable'), safeMiss: by('safe_miss'), wrong: by('wrong'),
    wrongReplies: rows.filter(r => r.verdict === 'wrong').map(r => r.id), pass: rows.length === plan.replies.length && by('wrong') === 0 }
}

/** The stand-in for sizing and tests (NOT a model): enter when the plan wants it. */
export function entryStandIn(plan) {
  return body => {
    const text = body.input?.[1]?.content ?? ''
    const reply = plan.replies.find(r => text.includes(`User message: ${r.message}`) && text.includes(plan.evidence[r.evidence].card.title))
    const enter = reply?.want === 'enter'
    return body.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'browser_entry_answer' ? 0.03 : enter ? 0.95 : 0.03 }))
  }
}

export async function selectEntry(plan, budget = plan.tokenCeiling) {
  const sized = await runEntryPlacelessPlan({ plan, scripted: entryStandIn(plan), unbounded: true })
  const est = Object.fromEntries(sized.requests.map(r => [r.id, r.estInputTokens]))
  const dropped = []
  let total = plan.replies.reduce((s, r) => s + (est[r.id] ?? 0), 0)
  for (const id of plan.dropOrder) { if (total <= budget) break; dropped.push(id); total -= est[id] ?? 0 }
  return { kept: plan.replies.filter(r => !dropped.includes(r.id)).map(r => r.id), dropped, estInputTokens: total, perReply: est }
}

export async function runEntryPlacelessPlan({ plan = loadEntryPlacelessPlan(), key = null, send = false, fetchImpl = globalThis.fetch, scripted = null, budget = null, unbounded = false } = {}) {
  const limits = unbounded ? { maxRequests: 1000, tokenCeiling: Number.MAX_SAFE_INTEGER } : { maxRequests: Math.min(plan.maxRequests, ENTRY_PLACELESS_HARD.maxRequests), tokenCeiling: Math.min(budget ?? plan.tokenCeiling, ENTRY_PLACELESS_HARD.tokenCeiling) }
  const chosen = unbounded ? { kept: plan.replies.map(r => r.id), dropped: [] } : await selectEntry(plan, limits.tokenCeiling)
  const planned = plan.replies.filter(r => chosen.kept.includes(r.id))
  const empty = why => ({ sent: 0, stoppedBecause: why, rows: [], requests: [], usage: { inputTokens: 0 }, limits, dropped: chosen.dropped, planSha256: plan.sha256, score: null })
  const realRun = send === true && scripted === null
  if (scripted === null && send !== true) return empty('dry_run')
  if (realRun && (typeof key !== 'string' || key.length < 20 || /\s/.test(key))) return empty('no_key')
  const record = { requests: [], tokens: 0, stopped: null, current: null }
  const client = createDecisionClient({ getApiKey: async () => (realRun ? key : 'egd-synthetic-not-a-key-0008'), recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model),
    fetchImpl: guardedFetch({ record, limits, fetchImpl, scripted: realRun ? null : scripted ?? entryStandIn(plan) }) })
  const rows = []
  for (const reply of planned) {
    if (record.stopped) break
    record.current = reply.id
    const { request, cards } = await captureEntryRequest(plan, reply)
    try {
      const result = await client.decide(request)
      const entry = readBrowserEntry(result.answers, cards, { codeCard: codeEntryCard(reply.message, cards) })
      const outcome = entry.kind === 'browser' ? 'enter' : 'not'
      rows.push({ id: reply.id, message: reply.message, evidence: reply.evidence, want: reply.want, kind: entry.kind, outcome, web: entry.web ?? null, answerP: entry.answerP ?? null, cardsP: entry.cardsP ?? null, verdict: entryVerdict(reply, outcome) })
    } catch (error) { record.stopped ??= error?.name === 'MeasurementStopped' ? record.stopped : `error_${error?.code ?? 'unknown'}`; break }
  }
  return { sent: record.requests.length, stoppedBecause: record.stopped, rows, requests: record.requests, usage: { inputTokens: record.tokens }, limits, dropped: chosen.dropped, planSha256: plan.sha256, score: scoreEntry({ ...plan, replies: planned }, rows) }
}
