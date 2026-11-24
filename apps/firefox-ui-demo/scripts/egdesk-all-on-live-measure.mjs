#!/usr/bin/env node
// The all-on journey (lane L2) measured against the Decision model.
//
//   node scripts/egdesk-all-on-live-measure.mjs                      dry run: the journey with the scripted Decision answers; sends nothing
//   node scripts/egdesk-all-on-live-measure.mjs --out results.json   the same, and the results file of that dry run
//   node scripts/egdesk-all-on-live-measure.mjs --send --out r.json  the journey against the real Decision model (key: OPENAI_API_KEY only)
//   options: --plan <file> (default: the pre-registered plan next to this script), --token-ceiling <n> (default 80000), --max-requests <n> (default 80)
//
// What runs: the product code. The world is scripts/egdesk-all-on.support.mjs: CodexChatRuntime with its heartbeat, the turn memory and wiki
// adapter, the draft check, the browser entry and browser tool provider, the presence mirror, work placement and its HTTP route, the
// Board/Decisions handler with the briefing engine, and the chrome-side request builders (EGDeskWorkPlacement, EGDeskBriefingHost). Every
// Decisions request body is the exact string the product's Decision client built; this file never builds one, and refuses (stops the run on)
// any body that did not come from that client. The wiring between those modules follows codex-bridge-server.mjs by hand (it is not the
// bridge's start-up code). Scripted: the subjective model's turns (fixed texts; the browser turn answers from the task note it is given),
// the engine's command events, the portal pages and the ontology pages (synthetic, public).
//
// Sending goes through lane L6's guarded sender (helper/egdesk-decision-real-runner.mjs runPlan), one request at a time as the product asks:
// the official endpoint fixed in code, redirects refused, no retries, the key only in the Authorization header (never printed or written),
// the first non-200 answer or network failure stops the run. On top of it: a total input-token ceiling, a request cap and per-step caps from
// the plan; a request that would go over any of them is not sent and stops the run. Steps after a stop are not run.
//
// Results (one 0600 file): per step every Decision request (family, caller, sha256, bytes, estimate, answer, elapsedMs, usage) and what the
// person would see after the step (the conversation, flow messages, activity rows, the board, placement, the browser task, writes), plus the
// pre-registered expectations of the plan judged against those results. Synthetic harness only: no Firefox, no engine binary.
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EXIT, independentEstimate, runPlan } from '../helper/egdesk-decision-real-runner.mjs'
import { DECISIONS_ENDPOINT } from '../helper/egdesk-decision-client.mjs'
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'
import * as BriefingHost from '../overlay/resources/EGDeskBriefingHost.sys.mjs'
import { allOnWorld, callerOf, scriptedDecisions, DM } from './egdesk-all-on.support.mjs'

export const PLAN_FILE = fileURLToPath(new URL('./egdesk-all-on-live-measure.plan.json', import.meta.url))
export const SCRIPT_FILE = fileURLToPath(import.meta.url)
export const DEFAULT_CAPS = Object.freeze({ tokenCeiling: 80_000, maxRequests: 80 })
const LIMITS = Object.freeze({ tokenCeilingMax: 200_000, maxRequestsMax: 200 })
export const OWNERS = Object.freeze(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'])
export const BROWSER_ROOM = 'dm-browser'
const CLIENT = 'helper/egdesk-decision-client.mjs', SUPPORT = 'scripts/egdesk-all-on.support.mjs'

// ---- the journey: what the person says, and the scripted subjective model ----
export const SAYS = Object.freeze({ quote: '지난주 A사 견적 건 어디까지 됐지?', tidy: '방금 그 내용 정리해줘', tests: '전체 테스트 돌리고 결과 알려줘',
  deployed: 'PostgreSQL 마이그레이션 배포 끝났어', portal: '거래처 포털에서 이번 달 세금계산서 내려받아줘', second: '두 번째 사업자로' })
const AGENT_SAYS = Object.freeze({ quote: 'A사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.', tidy: 'A사 견적은 11월 3일 요청, 11월 6일 v1 발송, v2는 팀장 승인 후 발송 예정입니다.',
  tests: '테스트가 모두 통과했습니다.', noted: '네, 기록해 두겠습니다.', ask: '사업자가 둘입니다. 어느 쪽으로 받을까요?', got: '세금계산서를 내려받았습니다.', stuck: '포털 작업을 마치지 못했습니다.' })
export const COMMAND = 'npm test -- --suite=payroll-secret', COMMAND_OUTPUT = 'running 40 tests'
const rect = (x, y, width, height) => ({ x, y, width, height })
const people = () => [{ member: 'self', self: true, active: true, viewport: rect(0, 0, 1200, 800), focusCard: null, lastInputAgeMs: 500 },
  { member: 'm-jin', self: false, active: true, viewport: rect(4000, 0, 1200, 800), focusCard: null, lastInputAgeMs: 900 }]
const RESULT_CARDS = () => [{ id: 'own-doc', rect: rect(100, 100, 500, 400), kind: 'file', creator: 'user' }, { id: 'agent-result', rect: rect(-2600, 100, 720, 520), kind: 'result', creator: 'agent', taskId: 'run-1' }]

const running = w => w.state.last && w.runs().at(-1)?.status === 'inProgress'
// The scripted subjective model answers the turn it is in (nothing when no turn of this room is working).
async function agentSays(w, text) { if (running(w)) await w.answer(text) }
// The browser turn answers from the task note the runtime handed it: a question when the task needs the person, a report when it is done.
async function agentAnswersTask(w) {
  const note = w.note()
  await agentSays(w, note?.next === 'ask_user_in_chat' ? AGENT_SAYS.ask : note?.status === 'done' ? AGENT_SAYS.got : AGENT_SAYS.stuck)
}
// The result card needs its owner, who looks elsewhere; a second member is on the desk. The request body is the chrome builder's (attentionRequest),
// posted the way the surface posts its placement requests ({ clientThreadId, conversationId, dto }). No surface code sends this request yet.
async function resultNeedsOwner(w, j) {
  w.presenceMirror.accept(people())
  const cards = RESULT_CARDS()
  const scene = WP.enumerateWorkScene({ presence: w.presenceMirror.snapshot(), cards,
    tasks: [{ id: 'run-1', state: 'waiting_owner', requester: 'self', waiting: ['self'], ownerMustAct: true, surfaces: [{ kind: 'result', cardId: 'agent-result' }] }] })
  const built = WP.attentionRequest(scene, { taskId: 'run-1', cardId: 'agent-result' })
  j.note.ownerRequest = built ? (await w.http('POST', '/decision/work-placement/request', { clientThreadId: DM, conversationId: w.state.lastOf.get(DM)?.conversationId ?? null, dto: built.dto })).body : null
  j.note.cards = cards.map(c => ({ id: c.id, kind: c.kind, creator: c.creator, rect: c.rect }))
  await w.advance(25000); w.presenceMirror.accept(people()); await w.advance(40000); await w.idle()
}

/** The steps, in order. Each step's expectations live in the plan file under the same id. */
export const STEPS = Object.freeze([
  { id: 's1-first-turn', room: DM, title: 'first message about the A company quote', run: async (w, j) => { await j.say(SAYS.quote); await w.advance(3000); await agentSays(w, AGENT_SAYS.quote) } },
  { id: 's2-follow-up', room: DM, title: 'follow-up in the same session', run: async (w, j) => { await j.say(SAYS.tidy); await w.advance(3000); await agentSays(w, AGENT_SAYS.tidy) } },
  { id: 's3-briefing', room: DM, title: 'the briefing of that answer', run: async (w, j) => {
    const run = w.runs().at(-1), answer = w.history().filter(([role]) => role === 'assistant').at(-1)?.[1] ?? ''
    const body = run ? BriefingHost.observeRequest({ mode: 'on', report: answer, answerId: run.answerId, conversationId: run.conversationId, runId: run.runId,
      candidates: BriefingHost.canvasBriefingCandidates([]), request: SAYS.tidy, viewport: rect(0, 0, 1200, 800) }) : null
    j.note.briefing = body ? (await w.http('POST', '/decision/briefing-observe', body)).body : { status: 'not_asked' }
  } },
  { id: 's4-long-command', room: DM, title: 'a long command: ten seconds in', run: async (w, j) => {
    w.presenceMirror.accept(people())
    await j.say(SAYS.tests)
    if (!running(w)) return
    const timing = w.timing(); j.note.command = timing
    await w.advance(1000)
    await w.notify('item/started', { ...timing, item: { id: 'cmd-1', type: 'commandExecution', command: COMMAND, cwd: '/work', status: 'inProgress', commandActions: [] } })
    await w.notify('item/commandExecution/outputDelta', { ...timing, itemId: 'cmd-1', delta: `${COMMAND_OUTPUT}\n` })
    await w.advance(9000)
  } },
  { id: 's5-silence', room: DM, title: 'the command ends; forty seconds without engine events', run: async (w, j) => {
    if (!j.note.command) return
    await w.notify('item/completed', { ...j.note.command, item: { id: 'cmd-1', type: 'commandExecution', command: COMMAND, cwd: '/work', status: 'completed', exitCode: 0, commandActions: [], aggregatedOutput: 'all passed\n' } })
    await w.advance(40000)
  } },
  { id: 's6-answer', room: DM, title: 'the answer', run: async w => { await agentSays(w, AGENT_SAYS.tests) } },
  { id: 's7-pointer-advisory', room: DM, title: 'the result needs the owner elsewhere; work placement advisory', run: async (w, j) => { w.ENV.EGDESK_WORK_PLACEMENT = 'advisory'; await resultNeedsOwner(w, j) } },
  { id: 's8-pointer-on', room: DM, title: 'the same, work placement on', run: async (w, j) => { w.ENV.EGDESK_WORK_PLACEMENT = 'on'; await resultNeedsOwner(w, j) } },
  { id: 's9-status-remark', room: DM, title: 'a status remark', run: async (w, j) => { await j.say(SAYS.deployed); await w.advance(2000); await agentSays(w, AGENT_SAYS.noted); await j.pause() } },
  { id: 's10-browser-task', room: BROWSER_ROOM, title: 'a browser task in a conversation of its own', run: async (w, j) => { w.use(BROWSER_ROOM); await j.say(SAYS.portal, w.browserExtra()); await agentAnswersTask(w) } },
  { id: 's11-browser-reply', room: BROWSER_ROOM, title: 'the person answers the task question', run: async (w, j) => { w.use(BROWSER_ROOM); await j.say(SAYS.second, w.browserExtra()); await agentAnswersTask(w); await j.pause() } },
])

// ---- the plan (pre-registered expectations) ----
export class PlanError extends Error { constructor(message) { super(message); this.name = 'PlanError' } }
const bad = message => { throw new PlanError(message) }
const posInt = value => Number.isSafeInteger(value) && value > 0
export function loadJourneyPlan(file = PLAN_FILE) {
  let bytes, raw
  try { bytes = readFileSync(file); raw = JSON.parse(bytes.toString('utf8')) } catch { bad('cannot read the plan file') }
  if (typeof raw?.set !== 'string' || !raw.set || typeof raw.registered !== 'string' || !raw.registered) bad('the plan needs a set name and its registration time')
  if (!Array.isArray(raw.steps) || raw.steps.length !== STEPS.length) bad(`the plan needs exactly the ${STEPS.length} steps of the journey`)
  const steps = raw.steps.map((step, index) => {
    const def = STEPS[index]
    if (step?.id !== def.id) bad(`plan step ${index + 1} must be ${def.id}`)
    if (!posInt(step.caps?.maxRequests) || !posInt(step.caps?.maxEstTokens)) bad(`${def.id}: caps.maxRequests and caps.maxEstTokens must be positive integers`)
    if (!Array.isArray(step.expect) || !step.expect.length) bad(`${def.id}: at least one expectation`)
    const ids = new Set()
    const expect = step.expect.map(e => {
      if (typeof e?.id !== 'string' || !e.id || ids.has(e.id)) bad(`${def.id}: every expectation needs a unique id`)
      ids.add(e.id)
      if (e.severity !== 'hard' && e.severity !== 'soft') bad(`${e.id}: severity must be hard or soft`)
      if (!OWNERS.includes(e.owner)) bad(`${e.id}: owner must be one of ${OWNERS.join(', ')}`)
      if (typeof e.text !== 'string' || !e.text.trim()) bad(`${e.id}: text is required`)
      if (!Object.hasOwn(CHECKS, e.check)) bad(`${e.id}: unknown check ${e.check}`)
      return { id: e.id, severity: e.severity, owner: e.owner, text: e.text, check: e.check, args: e.args ?? {}, ...(e.predicted ? { predicted: String(e.predicted) } : {}) }
    })
    return { id: def.id, caps: { maxRequests: step.caps.maxRequests, maxEstTokens: step.caps.maxEstTokens }, expect }
  })
  return { set: raw.set, registered: raw.registered, sha256: sha256(bytes), steps }
}

// ---- checks: each judges one expectation from the step's results (and the world, for request bodies that are not written out) ----
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const newMessages = (step, room = null) => step.seen.newMessages.filter(m => room === null || m.room === room)
const CHECKS = {
  // The subjective model's packet in this step: these pages are in it; none whose id starts with an excluded prefix.
  packet: ({ step, args }) => {
    const pages = [...new Set(step.seen.packets.flatMap(p => p.pageIds))]
    const missing = (args.include ?? []).filter(id => !pages.includes(id)), unwanted = pages.filter(id => (args.excludePrefix ?? []).some(prefix => id.startsWith(prefix)))
    return { pass: step.seen.packets.length > 0 && !missing.length && !unwanted.length, observed: { pages, missing, unwanted } }
  },
  // No page body that an earlier step of this room already delivered is delivered again.
  noRepeatedPages: ({ step, results }) => {
    const earlier = new Set(results.filter(r => r.seen && r !== step && r.room === step.room && results.indexOf(r) < results.indexOf(step)).flatMap(r => r.seen.packets.flatMap(p => p.pageIds)))
    const repeated = [...new Set(step.seen.packets.flatMap(p => p.pageIds))].filter(id => earlier.has(id))
    return { pass: repeated.length === 0, observed: { repeated } }
  },
  // The Agent's answer of this step reached the conversation exactly as the subjective model wrote it.
  answerAsWritten: ({ step, args }) => {
    const agent = newMessages(step, step.room).filter(m => m.role === 'assistant' && m.by === 'agent')
    return { pass: agent.length === 1 && agent[0].text === AGENT_SAYS[args.said], observed: { agentMessages: agent.map(m => m.text) } }
  },
  // How many new messages of this kind the person sees after the step (by: agent | system_flow; role: user | assistant).
  messageCount: ({ step, args }) => {
    const list = newMessages(step, args.room ?? step.room).filter(m => (args.role === undefined || m.role === args.role) && (args.by === undefined || m.by === args.by))
    const n = list.length
    return { pass: (args.equals === undefined || n === args.equals) && (args.max === undefined || n <= args.max) && (args.min === undefined || n >= args.min), observed: { count: n, texts: list.map(m => m.text) } }
  },
  // A flow message of this kind was posted (the heartbeat's own record of what it derived and posted).
  flowPosted: ({ step, args }) => {
    const posted = step.seen.flows.filter(f => f.flow === args.kind && f.posted && f.posted !== 'none')
    const shown = newMessages(step).filter(m => m.by === 'system_flow')
    const n = posted.length
    return { pass: (args.equals === undefined || n === args.equals) && (args.max === undefined || n <= args.max) && shown.length >= Math.min(n, 1), observed: { posted: n, derived: step.seen.flows.map(f => f.flow), shown: shown.map(m => m.text) } }
  },
  // None of these words is in anything the person sees (every message of every room so far).
  notShown: ({ step, args }) => {
    const hits = Object.entries(step.seen.conversation).flatMap(([room, list]) => list.filter(m => args.needles.some(n => m.text.includes(n))).map(m => ({ room, text: m.text })))
    return { pass: hits.length === 0, observed: { hits } }
  },
  // None of these words is in any Decision request of this step (of these families, when given). Checked on the exact bodies; the bodies
  // themselves are not written to the results.
  notSent: ({ step, args, world }) => {
    const hits = world.decisionsIn(step.id).filter(d => !args.families || args.families.includes(d.feature)).filter(d => args.needles.some(n => d.raw.includes(n))).map(d => d.feature)
    return { pass: hits.length === 0, observed: { requestsWithIt: hits } }
  },
  briefingOnBoard: ({ step, args }) => {
    const b = step.seen.board
    return { pass: b.observe?.outcome === 'presented' && b.published >= 1 && b.cards.length >= (args.minCards ?? 1), observed: { outcome: b.observe?.outcome ?? b.observe?.status ?? null, reason: b.observe?.reason ?? null, cards: b.cards.length, published: b.published } }
  },
  briefingPart: ({ step, args }) => {
    const parts = step.seen.board.parts.map(p => p.shows)
    return { pass: parts.includes(args.shows), observed: { parts } }
  },
  mainTurns: ({ step, args }) => ({ pass: step.seen.engineTurns.main === args.equals, observed: step.seen.engineTurns }),
  runEnded: ({ step }) => { const run = step.seen.runs[step.room]; return { pass: run?.status === 'completed', observed: { run } } },
  readingPending: ({ step, args }) => {
    const writes = step.seen.writes
    const reading = writes.readings.find(r => r.pageId === args.pageId)
    return { pass: reading?.state === 'pending' && !writes.pages.some(p => p.id === args.pageId), observed: { reading: reading ?? null, pagesWritten: writes.pages.map(p => p.id) } }
  },
  taskAsked: ({ step }) => {
    const asked = newMessages(step, step.room).filter(m => m.role === 'assistant')
    return { pass: step.seen.browser.note?.next === 'ask_user_in_chat' && asked.length === 1 && step.seen.runs[step.room]?.replyOpen === true,
      observed: { note: step.seen.browser.note, assistantMessages: asked.length, replyOpen: step.seen.runs[step.room]?.replyOpen ?? null } }
  },
  replyInRun: ({ step }) => { const sent = step.sends[0] ?? null; return { pass: sent?.inRun === true && sent?.accepted === true, observed: { send: sent } } },
  navigated: ({ step, args }) => { const urls = step.seen.browser.acts.filter(a => a.type === 'navigate').map(a => a.url); return { pass: JSON.stringify(urls) === JSON.stringify(args.urls), observed: { urls } } },
  pageWritten: ({ step, args }) => { const pages = step.seen.writes.pages.filter(p => p.scope === args.scope && p.by === args.by); return { pass: pages.length >= 1, observed: { pages: step.seen.writes.pages } } },
  placementRecorded: ({ step }) => ({ pass: step.seen.placement.records.length >= 1, observed: { records: step.seen.placement.records, submitted: step.seen.placement.submitted } }),
}
export const CHECK_NAMES = Object.freeze(Object.keys(CHECKS))

// ---- what the person sees after a step ----
const PAGE_ID = /\[(?:page|item) id=([^\s\]]+)/g
// A room that has no conversation yet has no messages (the store refuses to list an unknown room).
const roomMessages = (w, room) => { try { return w.store.listMessages(room).messages } catch (error) { if (error?.code === 'CONVERSATION_NOT_FOUND') return []; throw error } }
function counts(w) {
  return { rooms: Object.fromEntries([DM, BROWSER_ROOM].map(room => [room, roomMessages(w, room).length])), events: w.events.length, calibration: w.calibrationLog.entries().length,
    records: w.workPlacement.records().length, acts: w.acts.length, forks: w.forkPrompts.length }
}
function readWrites(w) {
  const file = path.join(w.dir, 'settings', 'egdesk-wiki-writes.json')
  if (!existsSync(file)) return { pages: [], readings: [] }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return { pages: (data.pages ?? []).map(p => ({ id: p.id, title: p.title, scope: p.scope ?? null, by: p.provenance?.by ?? null, status: p.status ?? null })),
      readings: (data.readings ?? []).map(r => ({ pageId: r.pageId, status: r.reading?.status ?? null, state: r.reading?.state ?? null })) }
  } catch { return { pages: [], readings: [], unreadable: true } }
}
function seenAfter(w, id, before, j) {
  const conversation = {}, newOnes = []
  for (const room of [DM, BROWSER_ROOM]) {
    const list = roomMessages(w, room).map(m => ({ role: m.role, text: m.text, by: m.role === 'assistant' ? (/^egdesk-flow:/.test(m.messageId ?? '') ? 'system_flow' : 'agent') : 'person' }))
    if (list.length) conversation[room] = list
    newOnes.push(...list.slice(before.rooms[room]).map(m => ({ room, ...m })))
  }
  const stepEvents = w.events.slice(before.events)
  const guide = w.forkPrompts.slice(before.forks).map(p => /Design guide \(decided; do not change it\):\n(.*)\n\nMaterials:/s.exec(p.prompt)?.[1]).filter(Boolean).at(-1)
  let parts = []
  try { parts = guide ? JSON.parse(guide).items.map(item => ({ shows: item.shows, component: item.component, materials: item.materials })) : [] } catch { parts = [] }
  const runs = {}
  for (const room of [DM, BROWSER_ROOM]) {
    const cid = w.state.lastOf.get(room)?.conversationId
    const run = cid ? w.chat.snapshot(cid).runs.at(-1) : null
    if (run) runs[room] = { status: run.status, replyOpen: Boolean(run.replyOpen) }
  }
  const note = w.note()
  return {
    conversation, newMessages: newOnes,
    flows: w.calibrationLog.entries().slice(before.calibration).filter(e => e.feature === 'conversation_flow' && Object.hasOwn(e, 'flow')).map(e => ({ flow: e.flow, posted: e.posted ?? null })),
    activityRows: w.activityRowsIn(id),
    packets: w.native.filter(c => c.step === id && c.method === 'turn/start' && !String(c.params.threadId).startsWith('fork-')).map(c => {
      const ctx = c.params.additionalContext ?? {}
      return { keys: Object.keys(ctx), pageIds: [...new Set(Object.values(ctx).flatMap(v => [...String(v?.value ?? '').matchAll(PAGE_ID)].map(m => m[1])))] }
    }),
    engineTurns: w.subjectiveTurnsIn(id),
    runs,
    board: { observe: j.note.briefing && id === 's3-briefing' ? j.note.briefing : null, published: stepEvents.filter(e => e.event === 'briefing.published').length,
      cards: stepEvents.filter(e => e.event === 'output.published').map(e => ({ title: e.details?.output?.title ?? null, zone: 'board' })), parts },
    placement: { submitted: /^s[78]-/.test(id) ? j.note.ownerRequest ?? null : null, cards: /^s[78]-/.test(id) ? j.note.cards ?? [] : [],
      records: w.workPlacement.records().slice(before.records).map(r => ({ kind: r.kind, surface: r.surface, source: r.source, would: r.would })), facts: w.workPlacement.facts(DM) },
    browser: { note: note ? { status: note.status, next: note.next, code: note.code ?? null, candidates: note.candidates ?? [], stepsDone: note.stepsDone ?? null } : null,
      acts: w.acts.slice(before.acts).map(a => ({ type: a.type, url: a.url })) },
    writes: readWrites(w),
    calibration: w.calibrationLog.entries().slice(before.calibration).map(e => ({ feature: e.feature, mode: e.mode, ...(e.flow !== undefined ? { flow: e.flow } : {}), ...(e.fallback ? { fallback: e.fallback } : {}) })),
  }
}
const requestRow = d => ({ family: d.feature, caller: d.caller, origin: d.origin, sha256: d.sha256, bytes: d.bytes, questions: d.names, estInputTokens: d.estInputTokens ?? null,
  sent: d.sent === true, ...(d.refused ? { refused: d.refused } : {}), ...(d.abandoned ? { abandonedByProduct: true } : {}),
  status: d.status ?? null, ...(d.error ? { error: d.error } : {}), elapsedMs: d.netElapsedMs ?? d.elapsedMs ?? null, usage: d.usage ?? null, answers: d.answers ?? null })

// ---- the Decisions transport: guard, caps, then either the scripted answers (dry run) or L6's guarded sender (one request per plan) ----
const deepStack = () => { const limit = Error.stackTraceLimit; Error.stackTraceLimit = 60; try { return new Error().stack } finally { Error.stackTraceLimit = limit } }
/**
 * bodyFromProduct(stack) -> null when the body was handed over by the product's Decision client on behalf of product code, else the reason.
 * The frame below the harness provider must be the Decision client, and the first other module below the client must not be a script
 * (a script that built a body and called the client itself would be that module).
 */
export function bodyFromProduct(stack) {
  const mods = [...String(stack).matchAll(/\/(helper|overlay\/resources|overlay\/JS|scripts)\/([A-Za-z0-9._-]+\.m?js)/g)].map(m => `${m[1]}/${m[2]}`)
  const at = mods.indexOf(SUPPORT)
  if (at < 0) return 'not_from_the_harness_provider'
  const below = mods.slice(at).filter(m => m !== SUPPORT)
  if (below[0] !== CLIENT) return 'not_from_the_decision_client'
  const next = below.find(m => m !== CLIENT)
  if (next && next.startsWith('scripts/')) return 'built_by_a_script'
  return null
}
const estimateOf = (wire, body) => independentEstimate(wire.questions.filter(q => q.type === 'choice').length, wire.questions.filter(q => q.type !== 'choice').length, Buffer.byteLength(body))
export function createMeasureTransport({ send = false, key = null, fetchImpl = globalThis.fetch, caps, plan, now = null, scripted = scriptedDecisions() } = {}) {
  const ledger = { requests: 0, sent: 0, tokens: 0, reportedTokens: 0, byStep: {}, stopped: null, refusedBodies: 0, onWire: 0 }
  const stop = (reason, step) => { if (!ledger.stopped) ledger.stopped = { reason, step } }
  const transport = async ({ body, wire, row }) => {
    const refusal = bodyFromProduct(deepStack())
    if (refusal) { ledger.refusedBodies++; stop(`hand_built_body:${refusal}`, row?.step ?? null); if (row && typeof row === 'object') row.refused = refusal; throw Object.assign(new Error('not sent'), { code: 'hand_built_body' }) }
    const step = row.step, stepCaps = plan.steps.find(s => s.id === step)?.caps ?? { maxRequests: 0, maxEstTokens: 0 }
    const use = ledger.byStep[step] ??= { requests: 0, tokens: 0 }
    const est = estimateOf(wire, body)
    row.sha256 = sha256(Buffer.from(body, 'utf8')); row.estInputTokens = est
    const refuse = reason => { stop(reason, step); row.refused = reason; throw Object.assign(new Error('not sent'), { code: 'not_sent' }) }
    if (ledger.stopped) refuse(`stopped:${ledger.stopped.reason}`)
    if (ledger.requests + 1 > caps.maxRequests) refuse('request_cap')
    if (use.requests + 1 > stepCaps.maxRequests) refuse('step_request_cap')
    if (ledger.tokens + est > caps.tokenCeiling) refuse('token_ceiling')
    if (use.tokens + est > stepCaps.maxEstTokens) refuse('step_token_cap')
    ledger.requests++; use.requests++; ledger.tokens += est; use.tokens += est
    if (send !== true) {
      return { status: 200, json: { answers: await scripted.answer(wire), usage: { input_tokens: est } } }
    }
    const id = `r${ledger.requests}`
    // One request per plan, as the product asks: the runner's ceiling is what is left of the journey's ceiling.
    const one = { set: plan.set, passRule: 'one request of the all-on journey; judged by the pre-registered journey plan', tokenCeiling: caps.tokenCeiling - (ledger.tokens - est),
      totals: { requests: 1, estInputTokens: est, independentEst: est },
      requests: [{ id, bytes: Buffer.from(body, 'utf8'), sha256: row.sha256, questions: wire.questions, expect: [], estInputTokens: est }] }
    // The product sends some requests side by side. A failure is noted the moment the network answers, and no request is handed to the
    // network once one is noted (a request already on the wire then cannot be recalled; it is recorded with the rest).
    const network = async (url, init) => {
      if (ledger.stopped) throw Object.assign(new Error('not sent'), { name: 'StoppedError' })
      ledger.onWire++
      try {
        const response = await fetchImpl(url, init)
        if (response?.status !== 200) stop(`http_${response?.status}`, step)
        return response
      } catch (error) { stop(error?.name === 'AbortError' ? 'timeout' : 'network', step); throw error } finally { ledger.onWire-- }
    }
    const outcome = await runPlan({ plan: one, key, send: true, fetchImpl: network, ...(now ? { now } : {}) })
    const result = outcome.results[id] ?? null
    ledger.sent += outcome.sent; row.sent = outcome.sent > 0
    const reported = Number.isFinite(result?.usage?.input_tokens) ? result.usage.input_tokens : null
    if (reported !== null) ledger.reportedTokens += reported
    // Counted by estimate before the send; the provider's own count replaces it when it reports one.
    if (reported !== null) { ledger.tokens += reported - est; use.tokens += reported - est }
    if (result) row.netElapsedMs = result.elapsedMs
    if (outcome.stoppedBecause) stop(outcome.stoppedBecause, step)
    // Stopped by another request while this one waited for its turn on the wire: not sent (runPlan reports it as a network error).
    if (!outcome.sent && result?.error === 'network' && ledger.stopped?.reason !== 'network') row.refused = `stopped:${ledger.stopped.reason}`
    if (!result || result.status === 0) throw Object.assign(new Error('not answered'), { code: outcome.stoppedBecause ?? 'network' })
    return { status: result.status, json: { answers: result.answers, ...(result.usage ? { usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens } } : {}), ...(result.model ? { model: result.model } : {}) } }
  }
  return { transport, ledger }
}

// ---- the journey ----
export async function runJourney({ plan, send = false, key = null, fetchImpl = globalThis.fetch, caps = DEFAULT_CAPS, now = null } = {}) {
  const cleanups = [], t = { after: fn => cleanups.push(fn) }
  const { transport, ledger } = createMeasureTransport({ send, key, fetchImpl, caps, plan, now })
  const steps = []
  try {
    const w = allOnWorld(t, { transport, settleLimitMs: 60_000 })
    await w.settings.turnMemory.save('on')
    const j = { note: {}, sends: [],
      async say(text, extra) {
        try { const out = await w.send(text, extra); j.sends.push({ inRun: out.inRun === true, accepted: out.accepted !== false, runId: out.runId ?? null }) }
        catch (error) { j.sends.push({ refused: typeof error?.code === 'string' ? error.code : 'error', status: error?.httpStatus ?? null }) }
        await w.idle()
      },
      async pause() { await new Promise(resolve => setTimeout(resolve, 60)); await w.idle() } }
    for (const def of STEPS) {
      if (ledger.stopped) { steps.push({ id: def.id, room: def.room, title: def.title, state: 'not_run' }); continue }
      w.step(def.id); j.sends = []
      const before = counts(w)
      let failure = null
      try { await def.run(w, j); await w.idle() } catch (error) { failure = typeof error?.code === 'string' ? error.code : error?.name ?? 'error' }
      const result = { id: def.id, room: def.room, title: def.title, state: ledger.stopped?.step === def.id ? 'stopped' : 'done', ...(failure ? { failure } : {}),
        sends: j.sends, requests: w.decisionsIn(def.id).map(requestRow), seen: seenAfter(w, def.id, before, j) }
      steps.push(result)
    }
    // Judge every expectation of the plan from the results (and, for request bodies, the world they were built in).
    for (const step of steps) {
      const planned = plan.steps.find(s => s.id === step.id)
      step.checks = planned.expect.map(e => {
        const base = { id: e.id, severity: e.severity, owner: e.owner, text: e.text, ...(e.predicted ? { predicted: e.predicted } : {}) }
        if (step.state === 'not_run') return { ...base, pass: null, state: 'not_run' }
        try { return { ...base, ...CHECKS[e.check]({ step, args: e.args, results: steps, world: w }) } } catch { return { ...base, pass: false, state: 'check_failed' } }
      })
    }
  } finally { for (const fn of cleanups.reverse()) { try { fn() } catch { /* cleanup */ } } }
  const checks = steps.flatMap(s => s.checks ?? [])
  const scorecard = { hard: { passed: checks.filter(c => c.severity === 'hard' && c.pass === true).length, failed: checks.filter(c => c.severity === 'hard' && c.pass === false).map(c => c.id), notRun: checks.filter(c => c.severity === 'hard' && c.pass === null).length },
    soft: { passed: checks.filter(c => c.severity === 'soft' && c.pass === true).length, missed: checks.filter(c => c.severity === 'soft' && c.pass === false).map(c => c.id), notRun: checks.filter(c => c.severity === 'soft' && c.pass === null).length } }
  return { steps, ledger, scorecard }
}

// ---- output ----
const familyCounts = requests => requests.reduce((m, r) => (m[r.family] = (m[r.family] || 0) + 1, m), {})
export function stepTable(outcome) {
  return outcome.steps.map(s => ({ step: s.id, state: s.state, requests: s.requests?.length ?? 0, families: s.requests ? familyCounts(s.requests) : {},
    estInputTokens: (s.requests ?? []).reduce((n, r) => n + (r.estInputTokens ?? 0), 0), ...(s.requests?.some(r => r.refused) ? { refused: s.requests.filter(r => r.refused).map(r => r.refused) } : {}) }))
}
export function resultsPayload({ outcome, plan, send, caps, at = new Date() }) {
  return { set: plan.set, mode: send ? 'send' : 'dry_run', at: at.toISOString(), endpoint: DECISIONS_ENDPOINT, automaticRetries: 0,
    plan: { file: path.basename(PLAN_FILE), sha256: plan.sha256, registered: plan.registered }, script: { sha256: sha256(readFileSync(SCRIPT_FILE)) },
    caps: { tokenCeiling: caps.tokenCeiling, maxRequests: caps.maxRequests, perStep: Object.fromEntries(plan.steps.map(s => [s.id, s.caps])) },
    totals: { requests: outcome.ledger.requests, sent: outcome.ledger.sent, inputTokensCounted: outcome.ledger.tokens, inputTokensReported: outcome.ledger.reportedTokens, refusedBodies: outcome.ledger.refusedBodies },
    stoppedBecause: outcome.ledger.stopped?.reason ?? null, stoppedAt: outcome.ledger.stopped?.step ?? null,
    scorecard: outcome.scorecard, steps: outcome.steps }
}
export function writeJourneyResults(file, payload) {
  writeFileSync(file, JSON.stringify(payload, null, 1), { mode: 0o600 })
  chmodSync(file, 0o600)
}

const plausibleKey = key => typeof key === 'string' && key.length >= 20 && !/\s/.test(key)
export async function main(argv, { env = {}, fetchImpl = globalThis.fetch, print = line => console.log(line), printError = line => console.error(line), now = null } = {}) {
  const args = [...argv], valued = new Set(['--out', '--plan', '--token-ceiling', '--max-requests']), known = new Set([...valued, '--send'])
  const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
  const unknown = args.find((arg, i) => !known.has(arg) && !valued.has(args[i - 1]))
  const int = (name, fallback, max) => { const v = valueOf(name); if (v === null) return fallback; const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : NaN }
  const caps = { tokenCeiling: int('--token-ceiling', DEFAULT_CAPS.tokenCeiling, LIMITS.tokenCeilingMax), maxRequests: int('--max-requests', DEFAULT_CAPS.maxRequests, LIMITS.maxRequestsMax) }
  if (unknown || [...valued].some(name => args.includes(name) && !valueOf(name)) || Number.isNaN(caps.tokenCeiling) || Number.isNaN(caps.maxRequests)) {
    printError('usage: egdesk-all-on-live-measure.mjs [--send] [--out results.json] [--plan plan.json] [--token-ceiling n<=200000] [--max-requests n<=200]   (dry run unless --send; the key is read from OPENAI_API_KEY only)')
    return EXIT.usage
  }
  let plan
  try { plan = loadJourneyPlan(valueOf('--plan') ?? PLAN_FILE) } catch (error) { printError(error?.name === 'PlanError' ? `plan refused: ${error.message}` : 'plan refused'); return EXIT.usage }
  const send = args.includes('--send')
  const key = send ? env.OPENAI_API_KEY ?? null : null
  if (send && !plausibleKey(key)) { printError('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); return EXIT.noKey }
  print(JSON.stringify({ set: plan.set, mode: send ? 'send' : 'dry_run', endpoint: DECISIONS_ENDPOINT, plan: plan.sha256.slice(0, 16), registered: plan.registered, tokenCeiling: caps.tokenCeiling, maxRequests: caps.maxRequests,
    ...(send ? {} : { note: 'dry run: the scripted Decision answers drive the journey; real answers may change which requests follow' }) }))
  const outcome = await runJourney({ plan, send, key, fetchImpl, caps, now })
  for (const row of stepTable(outcome)) print(JSON.stringify(row))
  const payload = resultsPayload({ outcome, plan, send, caps })
  print(JSON.stringify({ requests: payload.totals.requests, sent: payload.totals.sent, inputTokens: payload.totals.inputTokensCounted, stoppedBecause: payload.stoppedBecause, stoppedAt: payload.stoppedAt,
    hardPassed: payload.scorecard.hard.passed, hardFailed: payload.scorecard.hard.failed, softMissed: payload.scorecard.soft.missed }))
  const out = valueOf('--out')
  if (out) writeJourneyResults(out, payload)
  return payload.stoppedBecause ? EXIT.stopped : EXIT.ok
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2), { env: process.env })
