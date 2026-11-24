import { seedRefusal } from './egdesk-scenario-seed-guard.mjs'
import { createHash } from 'node:crypto'
import { DECISIONS_ENDPOINT, createDecisionClient } from './egdesk-decision-client.mjs'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { REAL_CLOCK, buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { prepareTurnMemory } from './egdesk-turn-memory.mjs'
import { ASKED_AT, SCOPE, estimateTokens } from './egdesk-memory-real-plan.mjs'

// LIVE measurement of the turn-memory loop: the real, adaptive loop (nothing scripted) against the public synthetic wiki, the way the 'on'
// mode runs it (same caps, same links-first budget, packet first, write judgment after). For Main to run after the user approves.
//  - The key comes from the caller (the CLI reads one environment variable). It goes to the product Decisions client, which puts it in the
//    Authorization header; it is never logged, stored, returned or put in an error here.
//  - Official endpoint only (the product client's default, asserted on every request). The product client never retries, and neither does this.
//  - Hard limits: a request count (6 per turn: triage 1 + loop 4 + write 1) and an input-token ceiling checked BEFORE every request against
//    actual usage so far plus the estimate of the next request. Hitting either stops the whole measurement; so does the first HTTP failure.
//  - Because the loop is adaptive the picks may differ from run to run. What is scored is the FINAL PACKET each turn would hand to the
//    answering model, the write proposal, and the time the packet took.
const OFFICIAL = 'https://api.openai.com/v1/decisions'
if (DECISIONS_ENDPOINT !== OFFICIAL) throw new Error('unexpected Decisions endpoint')

export const LIVE_LIMITS = Object.freeze({ requestsPerTurn: 6, maxRequests: 36, tokenCeiling: 60000, hardTokenMax: 80000, caps: Object.freeze({ firstMs: 4000, midMs: 2500 }), loopMarginMs: 200 })
const PRIVATE_ID = 'quote/a-cost', PRIVATE_TEXT = '원가는 단가의 71%'
const offTopic = (prefixes, ids = []) => ({ prefixes, ids })

/** Pre-registered expectations for the final packet of each turn. Fixed before any request; never edited after a run. */
export const LIVE_RUNS = Object.freeze([
  { id: 'pg-first', message: 'PostgreSQL 마이그레이션 배포 끝났어', position: 'first', held: [],
    required: ['db/pg-plan'], wanted: ['db/pg-health', 'db/pg-followup'], forbidden: offTopic(['quote/', 'jev/', 'misc/'], ['db/redis']),
    statuses: { 'db/pg-plan': 'plan' }, write: { op: 'update_status', pageId: 'db/pg-plan', status: 'done' } },
  { id: 'pg-mid', message: 'PostgreSQL 마이그레이션 배포 끝났어', position: 'mid', held: ['db/pg-design', 'db/pg-plan', 'db/pg-rollback', 'db/sqlite-schema'],
    required: ['db/pg-health', 'db/pg-followup'], wanted: [], forbidden: offTopic(['quote/', 'jev/', 'misc/'], ['db/redis']),
    statuses: {}, write: { op: 'update_status', pageId: 'db/pg-plan', status: 'done' } },
  { id: 'a-first', message: '지난주 A사 견적 건 어디까지 됐지?', position: 'first', held: [],
    required: ['quote/a-v1', 'quote/a-v2-plan'], wanted: ['quote/a-meeting', 'quote/a-decision'], forbidden: offTopic(['db/', 'jev/', 'misc/'], ['quote/b-request', 'quote/b-v1', 'quote/c-contract', 'quote/parts']),
    statuses: { 'quote/a-v2-plan': 'plan', 'quote/a-meeting': 'reported_by_other' }, write: null },
  { id: 'a-mid', message: '지난주 A사 견적 건 어디까지 됐지?', position: 'mid', held: ['quote/a-request', 'quote/a-v1'],
    required: ['quote/a-v2-plan'], wanted: ['quote/a-decision', 'quote/a-meeting'], forbidden: offTopic(['db/', 'jev/', 'misc/'], ['quote/b-request', 'quote/b-v1', 'quote/c-contract', 'quote/parts']),
    statuses: { 'quote/a-v2-plan': 'plan', 'quote/a-meeting': 'reported_by_other' }, write: null },
  { id: 'j-first', message: '아까 jev hook 흐름 다시 정리해줘', position: 'first', held: [],
    required: ['jev/flow-note'], wanted: [], forbidden: offTopic(['quote/', 'db/', 'misc/']), statuses: { 'jev/draft': 'plan' }, write: null },
  { id: 'j-mid', message: '아까 jev hook 흐름 다시 정리해줘', position: 'mid', held: ['jev/draft', 'jev/utt-user'],
    required: ['jev/flow-note'], wanted: ['jev/utt-agent'], forbidden: offTopic(['quote/', 'db/', 'misc/']), statuses: {}, write: null },
])

const sha = text => createHash('sha256').update(text).digest('hex')
const receiptsFor = (wiki, ids, threadKey) => ({ usable: true, threadKey, pages: Object.fromEntries(ids.map(id => [id, { revision: wiki.pages.get(id).revision, hash: wiki.pages.get(id).contentKey ?? sha(wiki.pages.get(id).body) }])) })
const stageOf = questions => (questions.some(q => q.name.startsWith('tn_')) ? 'triage' : questions.some(q => q.name.startsWith('tw_')) ? 'write' : questions.some(q => /^pg_/.test(q.name)) ? 'scan' : 'expand')
const typedEstimate = (questions, bytes) => estimateTokens(questions.filter(q => q.type === 'choice').length, questions.filter(q => q.type !== 'choice').length, bytes)

/** One turn of the real loop with the given client. Returns what the answering model would receive and what would be written. */
// writeTarget: the v1 runs were measured with the 'choice' write target and keep it (their results are scored against it).
export async function runLiveTurn(def, client, { clock = REAL_CLOCK, pages = SYNTHETIC_PAGES, limits = LIVE_LIMITS, writeTarget = 'choice' } = {}) {
  const now = clock.now // the loop's deadlines and the reported latencies read the same clock
  const wiki = buildWiki(pages)
  // The shared egress gate, with the permissions of a DM whose memory scope is this room: only memory pages may leave.
  const gate = createEgressGate(modelDataPermissions({ memoryScope: SCOPE }))
  const guarded = gate.guardClient(client, ['memory_page'])
  const position = def.position === 'mid' ? { kind: 'mid', reason: 'live_thread' } : { kind: 'first', reason: 'no_native_thread' }
  const capMs = def.position === 'mid' ? limits.caps.midMs : limits.caps.firstMs
  const started = now()
  const memory = await prepareTurnMemory({ message: def.message, wiki, client: guarded, scope: gate.memoryScope(SCOPE), askedAt: ASKED_AT, position, threadKey: 'thread-1',
    delivered: def.held.length ? receiptsFor(wiki, def.held, 'thread-1') : null, budget: { linksFirst: true }, deadlineMs: capMs - limits.loopMarginMs, packetFirst: true, ontologyWrite: true, clock, writeTarget })
  const packetMs = Math.round(now() - started)
  const judged = memory.judgeWrite ? await memory.judgeWrite() : null
  const triage = memory.triage ?? judged?.receipt?.triage ?? null
  return { id: def.id, position: def.position, capMs, packetMs, totalMs: Math.round(now() - started), status: memory.memory.status, partial: memory.memory.partial === true, reason: memory.memory.reason ?? null,
    pages: Object.keys(memory.memory.delivered ?? {}), picks: (memory.memory.picks ?? []).map(p => ({ id: p.id, via: p.via, p: p.p, statusRead: p.statusRead ?? null })),
    triage: triage ? { courtesy: triage.courtesy?.p ?? null, need: triage.need?.p ?? null, recall: triage.recall?.p ?? null, record: triage.record?.p ?? null, status: triage.status } : null,
    write: judged ? { op: judged.proposal.op, pageId: judged.proposal.pageId ?? null, status: judged.proposal.proposedStatus ?? judged.proposal.status ?? null, reason: judged.proposal.reason ?? null, labels: judged.receipt?.labels ?? null } : null,
    packet: memory.packet ?? null }
}

/** Score one turn's final packet against its pre-registration. Failures are classed: judgment (what was picked/read/written) or cap (cut by time). */
export function scoreLiveTurn(def, turn, { privateSeen = false } = {}) {
  const checks = []
  const add = (severity, name, ok, detail = null) => checks.push({ severity, name, ok, ...(detail === null ? {} : { detail }) })
  if (!turn) return { id: def.id, pass: false, ran: false, hardFailures: ['the turn did not run'], absolute: [], softMisses: [], checks: [{ severity: 'hard', name: 'the turn did not run', ok: false }] }
  const pages = new Set(turn.pages)
  for (const id of def.required) add('hard', `packet has ${id}`, pages.has(id))
  for (const id of def.wanted) add('soft', `packet has ${id}`, pages.has(id))
  const off = [...pages].filter(id => def.forbidden.ids.includes(id) || def.forbidden.prefixes.some(prefix => id.startsWith(prefix)))
  add('hard', 'no off-topic page in the packet', off.length === 0, off.join(',') || null)
  const resent = def.held.filter(id => pages.has(id))
  add('hard', 'no page the live context already holds is sent again', resent.length === 0, resent.join(',') || null)
  const leak = pages.has(PRIVATE_ID) || (typeof turn.packet === 'string' && turn.packet.includes(PRIVATE_TEXT)) || privateSeen
  add('absolute', 'the page outside this DM never appears in a request or the packet', !leak)
  for (const [id, want] of Object.entries(def.statuses)) {
    const read = turn.picks.find(p => p.id === id)?.statusRead ?? null
    // "Not wrong": a reading that was not installed is fine; an installed one must be the pre-registered status.
    add('hard', `status of ${id}, when read, is ${want}`, read === null || read === want, `read=${read}`)
  }
  if (def.write) {
    const w = turn.write
    add('hard', `write proposal is a status change of ${def.write.pageId} to ${def.write.status}`, w?.op === def.write.op && w.pageId === def.write.pageId && w.status === def.write.status, w ? `${w.op}/${w.pageId}/${w.status}/${w.reason}` : 'none')
    add('absolute', 'no new page or other page is written for this report', !w || w.op === 'none' || (w.op === def.write.op && w.pageId === def.write.pageId))
  } else add('absolute', 'a question is not recorded', !turn.write || turn.write.op === 'none', turn.write ? `${turn.write.op}/${turn.write.pageId}` : null)
  add('soft', `packet ready within the cap (${turn.capMs} ms)`, turn.packetMs <= turn.capMs, `${turn.packetMs} ms`)
  add('soft', 'the loop was not cut short', !turn.partial, turn.reason)
  const failed = severity => checks.filter(c => c.severity === severity && !c.ok).map(c => c.name)
  const hardFailures = failed('hard'), absolute = failed('absolute')
  return { id: def.id, ran: true, pass: hardFailures.length === 0 && absolute.length === 0, hardFailures, absolute, softMisses: failed('soft'),
    failureClass: hardFailures.length || absolute.length ? (turn.partial || turn.status === 'fallback' ? 'cap_or_outage' : 'judgment') : null, checks }
}

/** Pass rule (pre-registered): at least 5 of 6 turns pass, and no absolute failure anywhere (a leak or a wrong record is never outvoted). */
export function scoreLive(turns, { privateSeen = false } = {}) {
  const scored = LIVE_RUNS.map(def => scoreLiveTurn(def, turns.find(t => t?.id === def.id) ?? null, { privateSeen }))
  const absolute = scored.flatMap(s => s.absolute.map(name => `${s.id}: ${name}`))
  return { turnsPassed: scored.filter(s => s.pass).length, pass: scored.filter(s => s.pass).length >= 5 && absolute.length === 0, absolute, scored }
}

/** The dry-run estimate: the same loop with the lexical stand-in (NOT a model), only to size the requests. Sends nothing. */
export async function estimateLive({ limits = LIVE_LIMITS } = {}) {
  const rows = []
  for (const def of LIVE_RUNS) {
    const judge = mockJudge()
    let requests = 0, tokens = 0
    const counting = { async decide(request) { requests++; tokens += typedEstimate(request.questions, Buffer.byteLength(JSON.stringify({ model: 'gpt-6-luna', input: request.input, questions: request.questions }))); return judge.decide(request) } }
    await runLiveTurn(def, counting, { limits: { ...limits, caps: { firstMs: 60000, midMs: 60000 } } })
    rows.push({ id: def.id, position: def.position, requests, estInputTokens: tokens })
  }
  return { rows, requests: rows.reduce((n, r) => n + r.requests, 0), estInputTokens: rows.reduce((n, r) => n + r.estInputTokens, 0), maxRequests: limits.maxRequests, tokenCeiling: limits.tokenCeiling }
}

/**
 * The fetch every measurement request goes through (the product Decisions client is given this as its fetchImpl): official endpoint only,
 * a request limit and an input-token ceiling checked BEFORE each request (actual usage so far plus this request's estimate), no retries,
 * the first HTTP or network failure stops everything after it. state: { sent, tokens, stopped, privateSeen, requests, turn } (mutated).
 */
export function createGuardedFetch(state, { fetchImpl, ceiling, maxRequests, now = () => performance.now(), stage = stageOf } = {}) {
  const refuse = why => { state.stopped ??= why; throw Object.assign(new Error(`measurement stopped: ${why}`), { name: 'MeasurementStopped' }) }
  return async (url, init) => {
    if (url !== OFFICIAL) refuse('unofficial_endpoint')
    if (state.stopped) refuse(state.stopped)
    let body
    try { body = JSON.parse(init.body) } catch { refuse('bad_request_body') }
    const bytes = Buffer.byteLength(init.body), estimate = typedEstimate(body.questions ?? [], bytes)
    if (seedRefusal(init.body)) refuse('scenario_seed')
    if (state.sent >= maxRequests) refuse('request_limit')
    if (state.tokens + estimate > ceiling) refuse('token_ceiling')
    if (init.body.includes(PRIVATE_TEXT) || init.body.includes('A사 내부 원가')) state.privateSeen = true
    const row = { turn: state.turn, stage: stage(body.questions ?? []), questions: (body.questions ?? []).length, bytes, sha256: sha(init.body), estInputTokens: estimate, status: null, elapsedMs: null, inputTokens: null }
    state.requests.push(row); state.sent++
    const started = now()
    let response
    try { response = await fetchImpl(url, init) } catch (error) {
      row.elapsedMs = Math.round(now() - started); state.tokens += estimate // may have been processed: count the estimate
      // The loop's own deadline aborts a request that is too slow: that is a result of the measurement, not a reason to stop it.
      if (init.signal?.aborted) { row.status = 'aborted_by_deadline'; throw error }
      row.status = 'network'; state.stopped ??= 'network'; throw error
    }
    row.status = response.status; row.elapsedMs = Math.round(now() - started)
    let used = null
    try { used = (await response.clone().json())?.usage?.input_tokens ?? null } catch { used = null }
    row.inputTokens = Number.isFinite(used) ? used : null
    state.tokens += Number.isFinite(used) ? used : estimate
    if (response.status !== 200) state.stopped ??= `http_${response.status}`
    return response
  }
}

/**
 * runLive({ key, send = false, fetchImpl = fetch, tokenCeiling?, now? }) -> { sent, stoppedBecause, turns, requests, usage, scorecard }
 * With send = false nothing leaves the process.
 */
export async function runLive({ key = null, send = false, fetchImpl = globalThis.fetch, tokenCeiling = LIVE_LIMITS.tokenCeiling, clock = REAL_CLOCK, limits = LIVE_LIMITS } = {}) {
  const now = clock.now
  const ceiling = Math.min(Number.isFinite(tokenCeiling) && tokenCeiling > 0 ? tokenCeiling : limits.tokenCeiling, limits.hardTokenMax)
  const state = { sent: 0, tokens: 0, stopped: null, privateSeen: false, requests: [], turn: null }
  if (send !== true) return { sent: 0, stoppedBecause: 'dry_run', turns: [], requests: [], usage: { inputTokens: 0 }, ceiling, maxRequests: limits.maxRequests, scorecard: null }
  if (typeof key !== 'string' || key.length < 20 || /\s/.test(key)) return { sent: 0, stoppedBecause: 'no_key', turns: [], requests: [], usage: { inputTokens: 0 }, ceiling, maxRequests: limits.maxRequests, scorecard: null }
  const guardedFetch = createGuardedFetch(state, { fetchImpl, ceiling, maxRequests: limits.maxRequests, now })
  const client = createDecisionClient({ getApiKey: () => key, fetchImpl: guardedFetch, timeoutMs: 4000 })
  const turns = []
  for (const def of LIVE_RUNS) {
    if (state.stopped) break
    state.turn = def.id
    try { turns.push(await runLiveTurn(def, client, { clock, limits })) } catch { /* a turn that could not run is scored as not run */ }
  }
  return { sent: state.sent, stoppedBecause: state.stopped, turns, requests: state.requests, usage: { inputTokens: state.tokens }, ceiling, maxRequests: limits.maxRequests,
    scorecard: scoreLive(turns, { privateSeen: state.privateSeen }) }
}
