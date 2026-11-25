import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { OWNER, pageWorld } from './egdesk-browser-live-runner.mjs'
import { choiceContextLine, choiceListLine } from './egdesk-browser-choice-reply.mjs'
import { decisionThresholds, readChoice } from './egdesk-decision-questions.mjs'
import { guardedFetch } from './egdesk-browser-open-item-measure.mjs'

// L8 c44: the objective step after an ordinal reply to a choice the browser task asked (V4, c63: "두번째" read the right element at 0.60, under the bar; the loop asked again). Decisions only.
// The request is the PRODUCT's own step request: the real objective step (provider.runDirectTask over the portal fixture's /invoices page) is run once with a capturing stand-in to get the exact
// body, which goes out unchanged. Only the user-context line differs between variants and each is produced by the product's own function (the old bare line, choiceContextLine as the entry
// pushes it, choiceListLine as the entry pushes it when code cannot resolve). Verdicts by code from readChoice with the product's bar. Pre-registered in scripts/egdesk-ordinal-step-plan.json.
export const ORDINAL_PLAN_FILE = new URL('../scripts/egdesk-ordinal-step-plan.json', import.meta.url)
export const ORDINAL_HARD = Object.freeze({ maxRequests: 4, tokenCeiling: 5000 })

export function loadOrdinalPlan(file = ORDINAL_PLAN_FILE) {
  const bytes = readFileSync(file)
  const plan = JSON.parse(bytes.toString('utf8'))
  const bad = [], ids = new Set()
  if (!(plan.goal && plan.host && Array.isArray(plan.asked) && plan.asked.length >= 2 && plan.wantOption)) bad.push('task')
  if (!(Number.isSafeInteger(plan.maxRequests) && plan.maxRequests <= ORDINAL_HARD.maxRequests)) bad.push('maxRequests')
  if (!(Number.isSafeInteger(plan.tokenCeiling) && plan.tokenCeiling <= ORDINAL_HARD.tokenCeiling)) bad.push('tokenCeiling')
  for (const r of Array.isArray(plan.replies) ? plan.replies : []) {
    if (!(typeof r.id === 'string' && !ids.has(r.id) && r.message?.trim() && ['bare', 'code', 'list', 'below'].includes(r.line))) bad.push(`reply ${r.id}`)
    ids.add(r.id)
    const total = Object.values(r.predicted ?? {}).reduce((a, b) => a + b, 0)
    if (!(total > 0.989 && total < 1.011)) bad.push(`${r.id}: prediction sums to 1`)
  }
  if (!(plan.replies?.length >= 1 && plan.replies.length <= plan.maxRequests)) bad.push('replies within maxRequests')
  if (!(Array.isArray(plan.dropOrder) && plan.dropOrder.every(id => ids.has(id)) && new Set(plan.dropOrder).size === plan.dropOrder.length)) bad.push('dropOrder')
  if (bad.length) throw new Error(`bad ordinal plan: ${bad.join('; ')}`)
  return Object.freeze({ ...plan, sha256: createHash('sha256').update(bytes).digest('hex') })
}

/** The user-context line each variant sends, by the product's functions. */
export function contextLineFor(plan, reply) {
  if (reply.line === 'bare') return reply.message
  if (reply.line === 'code') return choiceContextLine(reply.message, plan.asked)
  return choiceListLine(reply.message, plan.asked) // list and below: the reply with the asked list, no resolution
}

/** The step request the product builds for this line: runDirectTask run once against a stand-in that records the first request. */
export async function captureStepRequest(plan, reply) {
  const world = pageWorld('base', plan.host, 'card'); world.go('/invoices')
  const asked = []
  const stand = { model: undefined, decide: async request => { asked.push(request); return { answers: Object.fromEntries(request.questions.map(q => [q.name, q.type === 'choice' ? { type: 'choice', choice: 'blocked', confidence: 0.9, probabilities: [{ value: 'blocked', probability: 0.9 }] } : { type: 'predicate', probability: q.name.startsWith('ps_') ? 0.01 : 0.02 }])), usage: null } } }
  const provider = createCodexBrowserToolProvider({ transport: world.transport, getOwnerKey: () => OWNER, decision: { mode: () => 'on', configured: () => true, client: stand, recipient: () => decisionTopicRecipient('egd-synthetic-not-a-key-0008', 1, undefined, undefined), generation: () => 0 } })
  provider.runtime = { emit: () => {} }
  const run = { answerId: 'ord-1', runId: 'ord-1', clientThreadId: 'ord-dm', status: 'inProgress', executionPolicy: { mode: 'browserBounded' } }
  const prepared = provider.prepare({ clientThreadId: 'ord-dm', effectiveExecutionPolicy: 'browserBounded', browserTransportId: 'ui', selectedSources: [{ id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
    browserToolSelection: { token: 'token-ord-1', threadId: 'ord-dm' }, browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 }, sourceRef: { viewId: 'card', profileId: 'synthetic', accountId: '', uri: `https://${plan.host}/invoices` } }] })
  await provider.bindRun(run, prepared)
  await provider.runDirectTask(run, { cardId: 'card', goal: plan.goal, userContext: [contextLineFor(plan, reply)], resumeState: null, priorRun: null, memoryPacket: null, maxSteps: 1, callId: `ord.${reply.id}`, today: plan.today })
  try { await provider.cancelRun(run) } catch { /* the run is a fixture */ }
  return asked.find(r => r.questions.some(q => q.name === 'next_step')) ?? null
}

/** verdict by code: the wanted option accepted = correct; another option accepted = wrong; not accepted = safe_miss. */
export function ordinalVerdict(plan, answers) {
  const read = readChoice(answers, 'next_step', { minConfidence: decisionThresholds().choice, minMargin: decisionThresholds().margin })
  const value = read.state === 'accepted' ? String(read.value) : null
  const verdict = value === null ? 'safe_miss' : value.replace(/^\[[A-Z]\d+\]\s*/, '') === plan.wantOption ? 'correct' : 'wrong'
  return { verdict, value, confidence: read.confidence, margin: read.margin, state: read.state, ranked: read.ranked }
}

export function scoreOrdinal(plan, rows) {
  const by = v => rows.filter(r => r.verdict === v).length
  return { ran: rows.length, notRun: plan.replies.length - rows.length, correct: by('correct'), safeMiss: by('safe_miss'), wrong: by('wrong'), wrongReplies: rows.filter(r => r.verdict === 'wrong').map(r => r.id), pass: rows.length === plan.replies.length && by('wrong') === 0 }
}

/** The stand-in for sizing and tests (NOT a model): the wanted option for the code-resolved line, the list lines and "아래 거", nothing sure for the bare reply (the V4 shape). */
export function ordinalStandIn(plan) {
  return body => {
    const text = body.input?.[1]?.content ?? ''
    const option = body.questions.find(q => q.name === 'next_step')?.choices?.find(c => String(c.value).includes(plan.wantOption))?.value
    const sure = /Chose "|asked to choose between/.test(text)
    return body.questions.map(q => (q.name === 'next_step'
      ? { name: q.name, type: 'choice', choice: option, confidence: sure ? 0.95 : 0.6, probabilities: [{ value: option, probability: sure ? 0.95 : 0.6 }] }
      : { name: q.name, type: 'predicate', probability: q.name.startsWith('ps_') ? 0.01 : 0.02 }))
  }
}

export async function selectOrdinal(plan, budget = plan.tokenCeiling) {
  const sized = await runOrdinalPlan({ plan, scripted: ordinalStandIn(plan), unbounded: true })
  const est = Object.fromEntries(sized.requests.map(r => [r.id, r.estInputTokens]))
  const dropped = []
  let total = plan.replies.reduce((s, r) => s + (est[r.id] ?? 0), 0)
  for (const id of plan.dropOrder) { if (total <= budget) break; dropped.push(id); total -= est[id] ?? 0 }
  return { kept: plan.replies.filter(r => !dropped.includes(r.id)).map(r => r.id), dropped, estInputTokens: total, perReply: est }
}

export async function runOrdinalPlan({ plan = loadOrdinalPlan(), key = null, send = false, fetchImpl = globalThis.fetch, scripted = null, budget = null, unbounded = false } = {}) {
  const limits = unbounded ? { maxRequests: 1000, tokenCeiling: Number.MAX_SAFE_INTEGER } : { maxRequests: Math.min(plan.maxRequests, ORDINAL_HARD.maxRequests), tokenCeiling: Math.min(budget ?? plan.tokenCeiling, ORDINAL_HARD.tokenCeiling) }
  const chosen = unbounded ? { kept: plan.replies.map(r => r.id), dropped: [] } : await selectOrdinal(plan, limits.tokenCeiling)
  const planned = plan.replies.filter(r => chosen.kept.includes(r.id))
  const empty = why => ({ sent: 0, stoppedBecause: why, rows: [], requests: [], usage: { inputTokens: 0 }, limits, dropped: chosen.dropped, planSha256: plan.sha256, score: null })
  const realRun = send === true && scripted === null
  if (scripted === null && send !== true) return empty('dry_run')
  if (realRun && (typeof key !== 'string' || key.length < 20 || /\s/.test(key))) return empty('no_key')
  const record = { requests: [], tokens: 0, stopped: null, current: null }
  const client = createDecisionClient({ getApiKey: async () => (realRun ? key : 'egd-synthetic-not-a-key-0008'), recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model),
    fetchImpl: guardedFetch({ record, limits, fetchImpl, scripted: realRun ? null : scripted ?? ordinalStandIn(plan) }) })
  const rows = []
  for (const reply of planned) {
    if (record.stopped) break
    record.current = reply.id
    const request = await captureStepRequest(plan, reply)
    if (!request) { record.stopped ??= 'no_step_request'; break }
    try {
      // only the body (input, questions): the product's scope hooks (the run's evidence gate, the signal) belong to the stand-in run, not to this send
      const result = await client.decide({ input: request.input, questions: request.questions })
      rows.push({ id: reply.id, message: reply.message, line: reply.line, context: contextLineFor(plan, reply), ...ordinalVerdict(plan, result.answers) })
    } catch (error) { record.stopped ??= error?.name === 'MeasurementStopped' ? record.stopped : `error_${error?.code ?? 'unknown'}`; break }
  }
  return { sent: record.requests.length, stoppedBecause: record.stopped, rows, requests: record.requests, usage: { inputTokens: record.tokens }, limits, dropped: chosen.dropped, planSha256: plan.sha256, score: scoreOrdinal({ ...plan, replies: planned }, rows) }
}
