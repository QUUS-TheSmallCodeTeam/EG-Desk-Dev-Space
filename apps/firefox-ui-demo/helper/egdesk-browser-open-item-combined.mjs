import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { createBrowserTaskStore } from './egdesk-browser-task.mjs'
import { createBrowserOpenItems, optionQuestionName } from './egdesk-browser-open-items.mjs'
import { buildRegistry, resolveOpenItem } from './egdesk-open-items.mjs'
import { OPEN_ITEM_HARD_LIMITS, guardedFetch } from './egdesk-browser-open-item-measure.mjs'

// L8 c42: the COMBINED measurement of the open-item path when a browser task is open (Decisions only: no page, no engine). The request is the product's own turn-start request:
// lane L1's referent question (oi_ref_<n>, bar 0.85) for every open item AND the browser provider's five option predicates, in ONE request, built by the same functions the
// runtime calls (buildRegistry, the provider's questions, resolveOpenItem with extraQuestions) over the items the runtime builds (the approval and memory summaries below are the
// runtime's own words: a test checks the runtime's source for them). Items are listed in the runtime's order: the built-ins first, the browser task last.
// Pre-registered in scripts/egdesk-browser-open-item-combined-plan.json. Verdicts by code from the plan alone.
export const COMBINED_PLAN_FILE = new URL('../scripts/egdesk-browser-open-item-combined-plan.json', import.meta.url)
export const COMBINED_PLAN_FILES = Object.freeze({ v1: COMBINED_PLAN_FILE, v2: new URL('../scripts/egdesk-browser-open-item-combined-plan-v2.json', import.meta.url) })
export const APPROVAL_SUMMARY = command => `A command waits for the person's yes or no before it runs: ${String(command).replace(/\s+/g, ' ').trim().slice(0, 200)}`
export const MEMORY_SUMMARY = 'EG-Desk told the person it noted something from the conversation and is waiting for the person to confirm or refuse it.'
const KEY = { cid: 'dm-1', clientThreadId: 'dm-1' }
const NOW = Date.parse('2026-11-25T10:00:00Z')
const ITEM_OF = { approval: 'approval', memory: 'memory', browser: 'browser' }

export function loadCombinedPlan(file = COMBINED_PLAN_FILE) {
  const bytes = readFileSync(file)
  const plan = JSON.parse(bytes.toString('utf8'))
  const bad = []
  const options = new Set(['continue', 'retry', 'abandon', 'ask_page', 'change'])
  const ids = new Set()
  if (!(plan.task?.goal && plan.task.pause?.code && plan.task.question && plan.others?.approval?.command)) bad.push('task and others')
  if (!(Number.isSafeInteger(plan.maxRequests) && plan.maxRequests <= OPEN_ITEM_HARD_LIMITS.maxRequests + 4)) bad.push('maxRequests')
  if (!(Number.isSafeInteger(plan.tokenCeiling) && plan.tokenCeiling <= OPEN_ITEM_HARD_LIMITS.tokenCeiling)) bad.push('tokenCeiling')
  for (const reply of Array.isArray(plan.replies) ? plan.replies : []) {
    if (!(typeof reply.id === 'string' && !ids.has(reply.id) && reply.message?.trim())) bad.push(`reply ${reply.id}`)
    ids.add(reply.id)
    if (!(Array.isArray(reply.items) && reply.items.at(-1) === 'browser' && reply.items.every(i => ITEM_OF[i]))) bad.push(`${reply.id}.items (the browser task last)`)
    if (!(reply.wantItem === 'none' || reply.items.includes(reply.wantItem))) bad.push(`${reply.id}.wantItem`)
    if (reply.wantItem === 'browser' && !options.has(reply.wantOption)) bad.push(`${reply.id}.wantOption`)
    if (!(Array.isArray(reply.acceptable) && reply.acceptable.every(o => options.has(o)))) bad.push(`${reply.id}.acceptable`)
    const total = Object.values(reply.predicted ?? {}).reduce((a, b) => a + b, 0)
    if (!(total > 0.989 && total < 1.011) || !reply.note) bad.push(`${reply.id}: prediction sums to 1 and has a note`)
  }
  if (!(plan.replies?.length >= 1 && plan.replies.length <= plan.maxRequests)) bad.push('replies within maxRequests')
  if (!(Array.isArray(plan.dropOrder) && plan.dropOrder.every(id => ids.has(id)) && new Set(plan.dropOrder).size === plan.dropOrder.length)) bad.push('dropOrder')
  if (bad.length) throw new Error(`bad combined plan: ${bad.join('; ')}`)
  return Object.freeze({ ...plan, sha256: createHash('sha256').update(bytes).digest('hex') })
}

/** The sources the runtime would hold for this reply: built-ins first (approval, memory when the reply says so), the browser task last. */
export function planSources(plan, reply) {
  const store = createBrowserTaskStore({ now: () => NOW })
  const task = store.create({ conversationKey: KEY.clientThreadId, cardId: 'card', goal: plan.task.goal })
  task.status = 'paused'; task.pause = { ...plan.task.pause }; task.steps = plan.task.steps ?? 1; task.question = plan.task.question
  const sources = []
  if (reply.items.includes('approval')) sources.push({ id: 'approval', builtin: true, items: () => [{ id: `approval:${KEY.cid}`, kind: 'approval', summary: APPROVAL_SUMMARY(plan.others.approval.command) }] })
  if (reply.items.includes('memory')) sources.push({ id: 'memory', builtin: true, items: () => [{ id: `memory:${KEY.cid}`, kind: 'memory', summary: MEMORY_SUMMARY }] })
  const browser = createBrowserOpenItems({ store, entry: { settle: async () => ({ handled: false, reason: 'measure_only' }) }, change: () => plan.task.change === true })
  sources.push(browser)
  return { sources, browser }
}

/** The product's request for one reply: the items, the extra (option) questions the providers contribute, exactly as runtime.resolveOpenItems builds them. */
export function planRequest(plan, reply) {
  const { sources, browser } = planSources(plan, reply)
  const items = buildRegistry(sources, KEY)
  const extraQuestions = [...new Set(items.map(item => item.source))].flatMap(source => (typeof source.questions === 'function' ? source.questions(source.builtin === true ? KEY : KEY.clientThreadId, reply.message) ?? [] : []))
  return { items, extraQuestions, browser }
}

/** outcome of one reply: { item: 'approval'|'memory'|'browser'|null, option, optionKind, outcome } */
export function outcomeOf(items, verdict, browser) {
  if (verdict.status !== 'settled') return { item: null, option: null, optionKind: null, outcome: 'none', reason: verdict.reason ?? null }
  const kind = verdict.item.kind === 'browser_task' ? 'browser' : verdict.item.kind
  if (kind !== 'browser') return { item: kind, option: null, optionKind: null, outcome: kind, reason: null }
  const read = browser.read(verdict.answers ?? {}, KEY.clientThreadId)
  return { item: 'browser', option: read.kind === 'settled' ? read.optionId : null, optionKind: read.kind, outcome: read.kind === 'settled' ? `browser:${read.optionId}` : 'browser:uncertain', p: read.p }
}

/** verdict(reply, outcome) -> 'correct' | 'acceptable' | 'safe_miss' | 'wrong' (by code, from the plan alone). */
export function combinedVerdict(reply, o) {
  if (reply.wantItem === 'none') {
    if (o.item === null) return 'correct'
    if (o.item !== 'browser') return 'wrong'
    if (o.optionKind === 'settled') return reply.acceptable.includes(o.option) ? 'acceptable' : 'wrong' // an option on a message that settles nothing
    return 'acceptable' // the item was referred but no option was settled: nothing is applied
  }
  if (o.item === null) return 'safe_miss'
  if (o.item !== reply.wantItem) return 'wrong'
  if (reply.wantItem !== 'browser') return 'correct'
  if (o.optionKind === 'settled') return o.option === reply.wantOption ? 'correct' : reply.acceptable.includes(o.option) ? 'acceptable' : 'wrong'
  return reply.uncertainOk === true ? 'acceptable' : 'safe_miss'
}

export function scoreCombined(plan, rows) {
  const by = v => rows.filter(r => r.verdict === v).length
  return { ran: rows.length, notRun: plan.replies.length - rows.length, correct: by('correct'), acceptable: by('acceptable'), safeMiss: by('safe_miss'), wrong: by('wrong'),
    wrongReplies: rows.filter(r => r.verdict === 'wrong').map(r => r.id), pass: rows.length === plan.replies.length && by('wrong') === 0 }
}

/** The stand-in for sizing and tests (NOT a model): the referent of the wanted item yes, the wanted option yes. */
export function combinedStandIn(plan) {
  return body => {
    const text = body.questions.map(q => q.instructions ?? '').join('\n')
    // the same message can be asked with different open items (page / ctl-mem-page): the reply is the one with this message AND this many referent questions AND these item summaries
    const refs = body.questions.filter(q => /^oi_ref_\d+$/.test(q.name))
    const reply = plan.replies.find(r => r.items.length === refs.length && refs.every((q, i) => q.instructions.includes(JSON.stringify(r.message)) && (r.items[i] === 'browser' ? q.instructions.includes('Browser task') : r.items[i] === 'approval' ? q.instructions.includes('A command waits') : q.instructions.includes('EG-Desk told the person'))))
    return body.questions.map(q => {
      let p = 0.03
      if (reply && /^oi_ref_(\d+)$/.test(q.name)) { const kind = { approval: 'approval', memory: 'memory', browser: 'browser' }[reply.items[Number(q.name.slice(7)) - 1]]; p = kind === reply.wantItem ? 0.97 : 0.03 }
      else if (reply && q.name.startsWith('open_browser_')) { const yes = reply.wantItem === 'browser' ? (reply.uncertainOk ? reply.acceptable : [reply.wantOption]) : []; p = yes.includes(q.name.replace('open_browser_', '')) ? 0.97 : 0.03 }
      return { name: q.name, type: 'predicate', probability: p }
    })
  }
}

export async function selectCombined(plan, budget = plan.tokenCeiling) {
  const sized = await runCombined({ plan, scripted: combinedStandIn(plan), unbounded: true })
  const est = Object.fromEntries(sized.requests.map(r => [r.id, r.estInputTokens]))
  const dropped = []
  let total = plan.replies.reduce((s, r) => s + (est[r.id] ?? 0), 0)
  for (const id of plan.dropOrder) { if (total <= budget) break; dropped.push(id); total -= est[id] ?? 0 }
  return { kept: plan.replies.filter(r => !dropped.includes(r.id)).map(r => r.id), dropped, estInputTokens: total, perReply: est }
}

export async function runCombined({ plan = loadCombinedPlan(), key = null, send = false, fetchImpl = globalThis.fetch, scripted = null, budget = null, unbounded = false } = {}) {
  const limits = unbounded ? { maxRequests: 1000, tokenCeiling: Number.MAX_SAFE_INTEGER } : { maxRequests: Math.min(plan.maxRequests, OPEN_ITEM_HARD_LIMITS.maxRequests + 4), tokenCeiling: Math.min(budget ?? plan.tokenCeiling, OPEN_ITEM_HARD_LIMITS.tokenCeiling) }
  const chosen = unbounded ? { kept: plan.replies.map(r => r.id), dropped: [] } : await selectCombined(plan, limits.tokenCeiling)
  const planned = plan.replies.filter(r => chosen.kept.includes(r.id))
  const empty = why => ({ sent: 0, stoppedBecause: why, rows: [], requests: [], usage: { inputTokens: 0 }, limits, dropped: chosen.dropped, planSha256: plan.sha256, score: null })
  const realRun = send === true && scripted === null
  if (scripted === null && send !== true) return empty('dry_run')
  if (realRun && (typeof key !== 'string' || key.length < 20 || /\s/.test(key))) return empty('no_key')
  const record = { requests: [], tokens: 0, stopped: null, current: null }
  const apiKey = realRun ? key : 'egd-synthetic-not-a-key-0008'
  const client = createDecisionClient({ getApiKey: async () => apiKey, recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model),
    fetchImpl: guardedFetch({ record, limits, fetchImpl, scripted: realRun ? null : scripted ?? combinedStandIn(plan) }) })
  const rows = []
  for (const reply of planned) {
    if (record.stopped) break
    record.current = reply.id
    const { items, extraQuestions, browser } = planRequest(plan, reply)
    let captured = null
    const wrapped = { decide: async request => { captured = await client.decide(request); return captured } }
    try {
      const verdict = await resolveOpenItem({ message: reply.message, items, client: wrapped, askedAt: NOW, extraQuestions })
      // c43: a measurement stop (the ceiling, the limit) is not a reply that ran: c62 counted the unrun last control as a safe miss
      if (verdict.status === 'none' && !['no_item_referred', 'several_items'].includes(verdict.reason) && record.stopped) break
      if (verdict.status === 'none' && !['no_item_referred', 'several_items'].includes(verdict.reason)) { record.stopped ??= `resolver_${verdict.reason}`; rows.push({ id: reply.id, message: reply.message, error: verdict.reason, verdict: 'safe_miss' }); break }
      const o = outcomeOf(items, verdict, browser)
      const refs = items.map((_, i) => captured?.answers?.[`oi_ref_${i + 1}`]?.probability ?? null)
      rows.push({ id: reply.id, message: reply.message, items: reply.items, wantItem: reply.wantItem, wantOption: reply.wantOption ?? null, ...o, refs, verdict: combinedVerdict(reply, o) })
    } catch (error) { record.stopped ??= error?.name === 'MeasurementStopped' ? record.stopped : `error_${error?.code ?? 'unknown'}`; break }
  }
  return { sent: record.requests.length, stoppedBecause: record.stopped, rows, requests: record.requests, usage: { inputTokens: record.tokens }, limits, dropped: chosen.dropped, planSha256: plan.sha256, score: scoreCombined({ ...plan, replies: planned }, rows) }
}

export { optionQuestionName }
