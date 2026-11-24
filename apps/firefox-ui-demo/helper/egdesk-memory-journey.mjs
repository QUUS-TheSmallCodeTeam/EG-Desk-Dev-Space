import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'
import { CodexChatRuntime, TURN_MEMORY_KEY } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { DECISION_CONTEXT_KEY, candidatesFromOntologyGraph } from './egdesk-context-setup.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { createTurnMemoryConfig } from './egdesk-turn-memory-wiring.mjs'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'
import { createGuardedFetch } from './egdesk-memory-live-runner.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'

// LIVE measurement v2 of turn memory as a JOURNEY: the real runtime (CodexChatRuntime) with turn memory 'on' and the three options this
// lane added, all on: the 'about' write target (now the default), one packet with the context selection, and confirmation of pending
// readings through the conversation (and the utterance labels written once, at page creation). Six turns in two sessions of one person, every Decision request real; the answering model is a
// scripted stand-in (it says what was noted when the note is given to it, as instructed). Public synthetic wiki, a temporary directory,
// nothing of the person's. Dry run by default; Main sends it after approval (scripts/egdesk-memory-live-measure.mjs --set v2).
export const JOURNEY_LIMITS = Object.freeze({ maxRequests: 48, tokenCeiling: 30000, hardTokenMax: 32000 })
const OWNER = 'codex:synthetic:journey', AGENT = 'sol'
const SLICE = { past: 'past', present: 'present', planned: 'future', hypothetical: 'hypothetical' }
// Eight pages: the PostgreSQL migration and the A사 quote, and one that belongs to neither (a plan of its own, so "a plan exists" is not
// enough to be picked). The ontology graph the bridge reads, built the way the all-on harness builds it. The ontology carries no recorded
// status, so every page starts with status unknown.
export const JOURNEY_PAGE_IDS = Object.freeze(['db/pg-design', 'db/pg-plan', 'db/pg-health', 'db/pg-followup',
  'quote/a-v1', 'quote/a-v2-plan', 'quote/a-decision', 'db/redis'])
// The context selection is given two of these as its candidates (the bridge would offer all ontology candidates; two keep the journey under
// its token ceiling and are enough for the case one packet exists for: a page offered to both features).
export const SELECTION_IDS = Object.freeze(['db/pg-plan', 'quote/a-v2-plan'])
const PAGES = JOURNEY_PAGE_IDS.map(id => SYNTHETIC_PAGES.find(p => p.id === id))
export const JOURNEY_GRAPH = Object.freeze({ snapshots: [], nodes: PAGES.map(p => ({ id: p.id, label: p.title, body: p.body, timeSlice: SLICE[p.time.slice] ?? 'present' })),
  edges: PAGES.flatMap(p => (p.links || []).filter(l => JOURNEY_PAGE_IDS.includes(l.to)).map(l => ({ source: p.id, target: l.to, relation: l.type }))) })
const page = id => `ontology:${id}`

/**
 * The six turns, pre-registered before any request (never edited after a run). session: a native thread; S2 is a new conversation.
 * checks: [severity, name, (observed) => boolean]; severity 'hard' | 'soft' | 'absolute' (absolute is never outvoted).
 */
export const JOURNEY_TURNS = Object.freeze([
  { id: 't1-done-first', session: 'S1', message: 'PostgreSQL 마이그레이션 배포 끝났어', answer: '수고하셨어요. 배포 후에는 헬스체크 3종부터 확인하세요.',
    note: 'first turn of a session: reconstruct, then the write judgment (about) over the pages it found' },
  { id: 't2-question', session: 'S1', message: '그럼 헬스체크는 뭐부터 보면 돼?', answer: '연결 풀 응답부터 보세요.', note: 'the pending reading of t1 is mentioned to the answering model' },
  { id: 't3-thanks', session: 'S1', message: '고마워', answer: '네.', note: 'silence about the note: it must stay pending' },
  { id: 't4-yes', session: 'S1', message: '응, 맞아.', answer: '네, 그렇게 기록해 두었어요.', note: 'an explicit yes to the note the previous reply stated' },
  { id: 't5-done-first-gap', session: 'S2', message: 'A사에 수정 견적서 보냈어', answer: '알겠어요. A사 회신을 기다리면 되겠네요.',
    note: 'the known gap: a completion report whose plan page must be found by retrieval first; if it is missed, the report becomes a new page' },
  { id: 't6-question', session: 'S2', message: '그럼 팀장 승인 기한은 언제였지?', answer: '11월 25일이에요.', note: 'a follow-up question in the second session' },
])

const has = (o, id) => o.packetPages.includes(page(id)) || o.heldPages.includes(page(id))
const ONE_PACKET = ['hard', 'one packet: never both keys, and no page body twice', o => !(o.keys.includes(DECISION_CONTEXT_KEY) && o.keys.includes(TURN_MEMORY_KEY)) && o.duplicateBodies === 0]
export const JOURNEY_CHECKS = Object.freeze({
  't1-done-first': [
    ['hard', 'the plan page is in the packet', o => o.packetPages.includes(page('db/pg-plan'))],
    ['hard', 'write: a pending "done" reading on the plan page', o => o.write?.op === 'update_status' && o.write.pageId === page('db/pg-plan') && o.write.status === 'done' && o.write.applied === 'recorded_pending'],
    ['absolute', 'no new page and no other page is changed for this report', o => !o.write || o.write.op === 'none' || (o.write.op === 'update_status' && o.write.pageId === page('db/pg-plan'))],
    ONE_PACKET,
    ['soft', 'the health and follow-up checklists are in the packet', o => o.packetPages.includes(page('db/pg-health')) && o.packetPages.includes(page('db/pg-followup'))],
    ['soft', 'the plan status is not changed yet (pending only)', o => o.status['db/pg-plan'] === 'unknown']],
  't2-question': [
    ['hard', 'the health checklist is available (in this packet or already held)', o => has(o, 'db/pg-health')],
    ['hard', 'the note about the plan is given to the answering model', o => o.noteGiven],
    ['hard', 'no page the model holds is sent again', o => o.resent.length === 0],
    ['absolute', 'a question is not recorded', o => !o.write || o.write.op === 'none'],
    ONE_PACKET],
  't3-thanks': [
    ['hard', 'the confirmation was judged', o => o.confirm?.judged === 1],
    ['absolute', 'thanks never promotes: the plan status is still not done', o => o.status['db/pg-plan'] !== 'done'],
    ['hard', 'the reading is still pending', o => o.readings['db/pg-plan']?.includes('done:pending')],
    ['absolute', 'nothing is recorded', o => !o.write || o.write.op === 'none'],
    ['soft', 'no memory fetch for a thank-you', o => o.fetches === 0], ONE_PACKET],
  't4-yes': [
    ['hard', 'the confirmation promoted the reading: the plan is done by the person\'s confirmation', o => o.confirm?.actions?.some(a => a.action === 'promoted') && o.status['db/pg-plan'] === 'done' && o.readings['db/pg-plan']?.includes('done:accepted')],
    ['absolute', 'nothing else is recorded', o => !o.write || o.write.op === 'none'], ONE_PACKET],
  't5-done-first-gap': [
    ['hard', 'the v2 plan page is in the packet (retrieval found the record the report completes)', o => o.packetPages.includes(page('quote/a-v2-plan'))],
    ['hard', 'write: a pending "done" reading on the v2 plan page, not a new page', o => o.write?.op === 'update_status' && o.write.pageId === page('quote/a-v2-plan') && o.write.status === 'done'],
    ['absolute', 'no other existing page is changed', o => !o.write || o.write.op !== 'update_status' || o.write.pageId === page('quote/a-v2-plan')],
    ['soft', 'the first session\'s confirmed status is unchanged', o => o.status['db/pg-plan'] === 'done'], ONE_PACKET],
  't6-question': [
    ['hard', 'the decision memo (approval deadline) is available', o => has(o, 'quote/a-decision')],
    ['absolute', 'a question is not recorded', o => !o.write || o.write.op === 'none'],
    ['soft', 'the note about the v2 plan is given, when t5 recorded one', o => (o.prior?.t5Pending ? o.noteGiven : true)], ONE_PACKET],
})
export const JOURNEY_PASS_RULE = 'At least 5 of 6 turns pass (no failed hard check) and no absolute check fails anywhere. t5 is the known gap: if it fails with a new page '
  + 'written and the v2 plan page not in the packet, it is classed retrieval_miss (the gap reproduced), not a write-target error.'

/** The class of a failed t5 (or any report turn): which stage lost the record. */
export function classifyReport(o, planId) {
  if (!o.write) return null
  if (o.write.op === 'new_page' && !o.packetPages.includes(page(planId)) && !o.heldPages.includes(page(planId))) return 'retrieval_miss'
  if (o.write.op === 'new_page') return 'target_miss' // the plan was there and was not taken as the record
  if (o.write.op === 'none') return 'not_written'
  return o.write.pageId === page(planId) ? null : 'wrong_record'
}

export function scoreJourney(observed) {
  const scored = JOURNEY_TURNS.map(def => {
    const o = observed.find(x => x?.id === def.id)
    if (!o) return { id: def.id, ran: false, pass: false, hardFailures: ['the turn did not run'], absolute: [], softMisses: [], checks: [] }
    const checks = JOURNEY_CHECKS[def.id].map(([severity, name, fn]) => { let ok = false; try { ok = fn(o) === true } catch { ok = false }; return { severity, name, ok } })
    const failed = sev => checks.filter(c => c.severity === sev && !c.ok).map(c => c.name)
    const out = { id: def.id, ran: true, hardFailures: failed('hard'), absolute: failed('absolute'), softMisses: failed('soft'), checks }
    out.pass = !out.hardFailures.length && !out.absolute.length
    if (def.id === 't5-done-first-gap' && !out.pass) out.failureClass = classifyReport(o, 'quote/a-v2-plan')
    return out
  })
  const absolute = scored.flatMap(s => s.absolute.map(name => `${s.id}: ${name}`))
  return { turnsPassed: scored.filter(s => s.pass).length, pass: scored.filter(s => s.pass).length >= 5 && absolute.length === 0, absolute, scored }
}

const stageOf = questions => {
  const names = questions.map(q => q.name)
  return names.includes('answer_type') ? 'context' : names.some(n => n.startsWith('rc_')) ? 'confirm' : names.some(n => n.startsWith('tw_')) ? 'write'
    : names.some(n => n.startsWith('tn_')) ? 'triage' : names.some(n => n.startsWith('pg_')) ? 'scan' : 'expand'
}

/**
 * runJourney(client, { dir }) -> observed turns. client: { decide } (the product Decisions client, or a stand-in for the dry run).
 * Everything lives in `dir` (a fresh temporary directory) and is removed afterwards unless keep is true.
 */
export async function runJourney(client, { keep = false, onTurn = () => {}, onTurnStart = () => {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-journey-')); chmodSync(dir, 0o700)
  const w = { now: Date.parse('2026-11-24T05:30:00Z'), starts: [], turns: 0, threads: 0, stages: [] }
  const captures = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [dir], now: () => w.now })
  const evidence = new MemoryEvidenceStore({ dataDir: path.join(dir, 'state'), captures, now: () => w.now })
  const store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic-journey' })
  let adapter = null
  const settingsDir = path.join(dir, 'settings')
  const config = createTurnMemoryConfig({ settings: { turnMemory: { mode: 'on' } }, ontologyStore: { readGraph: async () => JOURNEY_GRAPH }, onePacket: true, confirmInConversation: true,
    getAdapter: () => adapter ??= createWikiAdapter({ writes: openWikiWrites({ dataDir: settingsDir, log() {} }) }) })
  const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
  let chat = null
  const finishText = (p, base) => {
    // The stand-in answering model follows the note's instruction: it says, as a plain statement, what was noted.
    const note = Object.values(p.additionalContext ?? {}).map(e => (typeof e.value === 'string' ? e.value : '')).find(v => v.includes('[noted in this conversation, not confirmed]'))
    const titles = note ? [...note.matchAll(/^- "([^"]+)": the person reported it as done/gm)].map(m => m[1]) : []
    return titles.length ? `${base} ${titles.map(t => `${t}은 완료로 적어 둘게요.`).join(' ')}` : base
  }
  chat = new CodexChatRuntime({ now: () => (w.now += 1000), store, requireStore: true, getOwnerKey: () => OWNER, profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') return { thread: { id: `t${++w.threads}` }, cwd: '/work', model: 'syn' }
      if (method === 'thread/resume') return { thread: { id: p.threadId, turns: [] }, cwd: '/work' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      w.starts.push(p)
      const id = `turn-${++w.turns}`, timing = { threadId: p.threadId, turnId: id }, text = finishText(p, w.answer)
      setImmediate(() => setImmediate(async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }))
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { mode: () => 'on', settingsGeneration: () => 0, configured: () => true, budgetMs: 5000, memoryEvidence: evidence,
      client: { model: 'gpt-6-luna', async decide(request) { w.stages.push({ turn: w.turnId, stage: stageOf(request.questions) }); return client.decide(request) } },
      // the bridge's own candidate collection over the same ontology graph: this is how one page reaches the model under two keys
      // the bridge's own candidate collection (the recent-utterances candidate with the speech consent), plus SELECTION_IDS of the same
      // ontology graph the memory reads: this is how one page reaches the model under two keys without one packet
      collect: async ({ body, context, memoryEvidenceFor, speech }) => [
        ...(await collectDecisionCandidates({ body, clientThreadId: context.clientThreadId, excludeMessageId: context.localMessageId, chatStore: store, memoryEvidenceFor, speech })).candidates,
        ...candidatesFromOntologyGraph(JOURNEY_GRAPH).filter(c => SELECTION_IDS.some(id => c.id === page(id)))],
      // the person's utterances are labelled once, after the answer (L7 c14 'at-page'), not by questions on every turn: also a token saving here
      speechDesign: 'at-page',
      turnMemory: { ...config, get ontologyWrite() { return config.ontologyWrite } } } })
  chat.setConnection(true)
  const sessions = { S1: { thread: 'dm-1' }, S2: { thread: 'dm-2' } }
  const scope = thread => ({ ownerKey: OWNER, agentId: AGENT, clientThreadId: thread })
  const statusOf = async thread => {
    const wiki = await config.wiki({ body: { message: 'x' }, context: { clientThreadId: thread }, sources: {} })
    return { status: Object.fromEntries(JOURNEY_PAGE_IDS.map(id => [id, wiki.pages.get(page(id))?.status ?? null])),
      readings: Object.fromEntries(JOURNEY_PAGE_IDS.map(id => [id, (wiki.pages.get(page(id))?.statusReadings ?? []).map(r => `${r.status}:${r.state}`)])) }
  }
  const observed = [], completed = thread => { try { return store.listMessages(thread).messages.filter(m => m.role === 'assistant' && m.status === 'complete').length } catch { return 0 } }
  try {
    for (const def of JOURNEY_TURNS) {
      const s = sessions[def.session]
      if (!s.grant) { s.grant = evidence.enableSpeech(scope(s.thread)) } // the person allows reuse of this DM's utterances (needed to read the previous reply)
      w.turnId = def.id; w.answer = def.answer; onTurnStart(def)
      const before = completed(s.thread)
      const sent = await chat.send({ message: def.message, clientThreadId: s.thread, requestId: `r-${def.id}`, ...(s.cid ? { conversationId: s.cid } : {}), profileId: AGENT, replyDestination: 'direct' })
      s.cid ||= sent.conversationId
      for (let i = 0; i < 20000 && completed(s.thread) <= before; i++) await new Promise(resolve => setImmediate(resolve))
      await chat.turnMemoryIdle(); await chat.turnMemoryIdle()
      const run = [...chat.runs.values()].at(-1), turn = chat.turnMemoryTurns.get(run) ?? null, start = w.starts.at(-1) ?? { additionalContext: {} }
      const ctx = start.additionalContext ?? {}, all = Object.values(ctx).map(e => (typeof e.value === 'string' ? e.value : '')).join('\n')
      const packetPages = turn?.attached ? Object.keys(turn.result?.memory?.delivered ?? {}) : []
      const heldPages = turn?.result?.held ?? []
      const bodies = JOURNEY_PAGE_IDS.map(id => PAGES.find(p => p.id === id).body)
      const receipt = chat.turnMemoryWriteReceipts.get(run) ?? null
      const judged = turn?.result ? receipt : null
      const st = await statusOf(s.thread)
      const o = { id: def.id, session: def.session, position: turn?.position?.kind ?? null, keys: Object.keys(ctx), packetPages, heldPages,
        resent: packetPages.filter(id => heldPages.includes(id)), duplicateBodies: bodies.filter(b => all.split(b).length - 1 > 1).length,
        noteGiven: all.includes('[noted in this conversation, not confirmed]'), confirm: turn?.confirm ?? null,
        write: judged?.proposal ? { op: judged.proposal, pageId: judged.pageId, status: judged.status, applied: judged.applied, reason: judged.reason } : null,
        fetches: w.stages.filter(x => x.turn === def.id && (x.stage === 'scan' || x.stage === 'expand')).length,
        stages: w.stages.filter(x => x.turn === def.id).map(x => x.stage), memory: turn?.result?.memory?.status ?? null, partial: turn?.result?.memory?.partial === true, ...st }
      if (def.id === 't6-question') o.prior = { t5Pending: observed.find(x => x.id === 't5-done-first-gap')?.write?.applied === 'recorded_pending' }
      observed.push(o); onTurn(o)
    }
  } finally {
    store.close(); evidence.close()
    if (!keep) rmSync(dir, { recursive: true, force: true })
  }
  return observed
}

/** The dry run: the journey with the lexical stand-in (NOT a model), only to size the requests. Sends nothing. */
export async function estimateJourney() {
  const judge = mockJudge(), rows = []
  const counting = { async decide(request) {
    const bytes = Buffer.byteLength(JSON.stringify({ model: 'gpt-6-luna', input: request.input, questions: request.questions }))
    rows.push({ stage: stageOf(request.questions), questions: request.questions.length, bytes, est: estimateTokens(request.questions.filter(q => q.type === 'choice').length, request.questions.filter(q => q.type !== 'choice').length, bytes) })
    return judge.decide(request)
  } }
  const turns = []
  await runJourney(counting, { onTurn: o => turns.push({ id: o.id, requests: rows.length }) })
  const per = turns.map((t, i) => { const from = i ? turns[i - 1].requests : 0; const mine = rows.slice(from, t.requests); return { id: t.id, requests: mine.length, stages: mine.map(r => r.stage).join(' '), estInputTokens: mine.reduce((n, r) => n + r.est, 0) } })
  return { turns: per, requests: rows.length, estInputTokens: rows.reduce((n, r) => n + r.est, 0) }
}

/** The real run (Main, after approval). With send = false nothing leaves the process. */
export async function runJourneyLive({ key = null, send = false, fetchImpl = globalThis.fetch, tokenCeiling = JOURNEY_LIMITS.tokenCeiling, now = () => performance.now() } = {}) {
  const ceiling = Math.min(Number.isFinite(tokenCeiling) && tokenCeiling > 0 ? tokenCeiling : JOURNEY_LIMITS.tokenCeiling, JOURNEY_LIMITS.hardTokenMax)
  const state = { sent: 0, tokens: 0, stopped: null, privateSeen: false, requests: [], turn: null }
  if (send !== true) return { sent: 0, stoppedBecause: 'dry_run', turns: [], requests: [], usage: { inputTokens: 0 }, ceiling, scorecard: null }
  if (typeof key !== 'string' || key.length < 20 || /\s/.test(key)) return { sent: 0, stoppedBecause: 'no_key', turns: [], requests: [], usage: { inputTokens: 0 }, ceiling, scorecard: null }
  const guardedFetch = createGuardedFetch(state, { fetchImpl, ceiling, maxRequests: JOURNEY_LIMITS.maxRequests, now, stage: stageOf })
  const product = createDecisionClient({ getApiKey: () => key, fetchImpl: guardedFetch, timeoutMs: 4000 })
  const turns = await runJourney({ decide: request => { if (state.stopped) throw Object.assign(new Error(`measurement stopped: ${state.stopped}`), { code: 'unreachable' }); return product.decide(request) } },
    { onTurnStart: def => { state.turn = def.id } })
  return { sent: state.sent, stoppedBecause: state.stopped, turns, requests: state.requests, usage: { inputTokens: state.tokens }, ceiling, scorecard: scoreJourney(turns) }
}
