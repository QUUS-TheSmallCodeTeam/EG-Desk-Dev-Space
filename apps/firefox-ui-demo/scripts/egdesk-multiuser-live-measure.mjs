#!/usr/bin/env node
// The collaboration scenario (lane L1, cycle 14) measured against the Decision model, through PRODUCT code.
//
//   node scripts/egdesk-multiuser-live-measure.mjs                       dry run: scripted Decision answers; sends nothing
//   node scripts/egdesk-multiuser-live-measure.mjs --out results.json    the same, and its results file (0600)
//   node scripts/egdesk-multiuser-live-measure.mjs --send --out r.json   against the real Decision model (key: OPENAI_API_KEY only)
//   node scripts/egdesk-multiuser-live-measure.mjs --rerun earlier.json  one command for a re-run: the latest plan, a diff against that file,
//                                                                        and (without --send) its recorded answers drive the scenario
//   options: --plan <file>, --token-ceiling <n> (default and max 20000), --max-requests <n> (default and max 20)
//
// The scenario: one joint Board, two synthetic Desks. The owner A works in their own area; member B is invited and looks at another part of the
// shared space. B asks A's Agent for work on A's material -> who asked (requester identity, vouched by the joint presence service) -> the work
// surface's placement (code rules) -> the content questions (same_matter, owner_action) -> the surface opens in B's zone without moving A's camera
// or focus, never inside A's view, no card of A moved, the private placement never writes the shared ledger -> the result needs A's decision ->
// one pointer message in A's own conversation; then B leaves -> the identity ends.
//
// What runs, all product code: lane L2's bridge world (scripts/egdesk-all-on.support.mjs: CodexChatRuntime with its session heartbeat and
// conversation flow, the presence mirror, the requester registry, work placement and its HTTP route, wired as codex-bridge-server.mjs); the joint
// Board store and its presence service (helper/egdesk-joint-board-store.mjs, helper/egdesk-joint-presence.mjs), called in-process; per Desk the
// joint presence client, the Desk presence and the request requesters (overlay/resources/EGDeskJointPresence.sys.mjs); on A's Desk the surface's
// OWN functions (resolveCanvasCardPlacement, noteWorkSurfacePlacement, workPresence, revealPlacedCanvasCard, read from eg-desk-surface.uc.js) over a
// synthetic canvas, with the placement runtime and SurfaceState. Scripted: the subjective model's turns and words (L2's world), the people's input.
//
// Decisions requests go through lane L2's measurement transport (scripts/egdesk-all-on-live-measure.mjs createMeasureTransport, imported): its
// product-path body check (a body not handed over by the product's Decision client is refused and stops the run), the caps, and lane L6's guarded
// sender (helper/egdesk-decision-real-runner.mjs runPlan: fixed endpoint, no redirects, no retries, the key only in the Authorization header, the
// first failure stops the run). Steps after a stop are not run. Synthetic harness only: no Firefox, no engine binary, no socket but the sender's.
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EXIT } from '../helper/egdesk-decision-real-runner.mjs'
import { DECISIONS_ENDPOINT } from '../helper/egdesk-decision-client.mjs'
import { createJointStore } from '../helper/egdesk-joint-board-store.mjs'
import { createJointPresence as createPresenceHub } from '../helper/egdesk-joint-presence.mjs'
import { createPresenceMirrorHttpHandler, createRunRequesterHttpHandler, PRESENCE_MIRROR, RUN_REQUESTER } from '../helper/egdesk-presence-mirror.mjs'
import * as JP from '../overlay/resources/EGDeskJointPresence.sys.mjs'
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'
import * as SurfaceState from '../overlay/resources/EGDeskSurfaceState.sys.mjs'
import { allOnWorld, DM, screen, scriptedDecisions } from './egdesk-all-on.support.mjs'
import * as DraftCheck from '../helper/egdesk-draft-check.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
// the draft check's fixed fallback sentences (the owner removed them; L3): read when the module still has them, else none
const DRAFT_CHECK_COPY = DraftCheck.DRAFT_CHECK_COPY ?? {}
import { sendStampPath, stampingFetch } from '../helper/egdesk-decision-send-stamp.mjs'
import { createMeasureTransport, diffJourneys, formatDiff, replayAnswers, writeJourneyResults } from './egdesk-all-on-live-measure.mjs'

// v1 (cycle 14, sent: 22/25) and v2 (cycle 15, sent: 31/32) are kept as registered; v3 (cycle 16) is the default.
export const PLAN_FILE_V1 = fileURLToPath(new URL('./egdesk-multiuser-live-measure.plan.json', import.meta.url))
export const PLAN_FILE_V2 = fileURLToPath(new URL('./egdesk-multiuser-live-measure.plan-v2.json', import.meta.url))
export const PLAN_FILE_V3 = fileURLToPath(new URL('./egdesk-multiuser-live-measure.plan-v3.json', import.meta.url))
// v4 (cycle 17) is the default: the window's own attention trigger, no runner-side attention calls
export const PLAN_FILE = fileURLToPath(new URL('./egdesk-multiuser-live-measure.plan-v4.json', import.meta.url))
export const SCRIPT_FILE = fileURLToPath(import.meta.url)
export const DEFAULT_CAPS = Object.freeze({ tokenCeiling: 20_000, maxRequests: 20 })
const LIMITS = Object.freeze({ tokenCeilingMax: 20_000, maxRequestsMax: 20 })
export const OWNERS = Object.freeze(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const r = (x, y, width, height) => ({ x, y, width, height })
const hits = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
const gapTo = (a, b) => Math.hypot(Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)), Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)))

// ---- the people and their words (synthetic) ----
export const A_VIEW = r(0, 0, 1280, 800)              // the owner, working here
export const B_SEES = r(2900, 500, 1200, 800)         // B's camera on B's own Desk
export const B_OFFSET = { x: 500, y: 300 }            // where the Board sits on B's Desk relative to A's
export const B_VIEW = r(2400, 200, 1200, 800)         // the same area on A's canvas
export const ASK = 'A사 견적서 v2를 v1과 비교해서 달라진 점을 정리해 주세요. (B님 요청)'
// The Agent's answers (the scripted subjective model). ANSWER needs A's decision: a price change A must approve before the revised quote goes out.
export const ANSWER = 'v2는 v1보다 단가가 12,000원에서 11,000원으로 낮고 납기가 1주 짧습니다. 수정 견적서를 B님께 보내기 전에 이 단가 인하를 소유자께서 승인해 주셔야 합니다.'
// The follow-up (v2): B asks something that needs nothing from A.
export const ASK2 = 'A사 견적서 v2의 납기만 다시 알려 주세요. (B님 요청)'
export const ANSWER_INFO = 'A사 견적서 v2의 납기는 2주입니다. 따로 확인하실 일은 없습니다.'
export const POINTER = '오른쪽 작업 영역에 A사 견적 비교 결과가 있습니다. 결제 조건 승인이 필요합니다.'
// A's canvas: A's own cards inside A's view, and two published result cards on B's side of the space whose words the host may send.
export const A_CARDS = Object.freeze([
  { id: 'a-memo', rect: r(100, 100, 500, 400), kind: 'memo' },
  { id: 'a-file', rect: r(650, 120, 400, 300), kind: 'file' },
  { id: 'a-quote-v1', rect: r(3700, 1150, 400, 300), kind: 'result', record: { title: 'A사 견적서 v1 단가표', text: 'A사 견적서 v1: 품목 3종, 단가 12,000원, 수량 40개, 납기 3주.', provenance: { creator: 'agent', runId: 'run-earlier' } } },
  { id: 'a-lunch', rect: r(3700, -650, 400, 300), kind: 'result', record: { title: '점심 메뉴 투표 결과', text: '이번 주 점심은 김치찌개로 정해졌습니다.', provenance: { creator: 'agent', runId: 'run-other' } } },
])
export const BOARD_REGION = r(-2600, 1200, 1400, 900) // a joint Board region on A's canvas (the shared part)

const STEP_DEFS = Object.freeze({
  join: 'A works in their area; B joins the Board and shares where they look',
  ask: 'B asks A\'s Agent for work on A\'s material; the service says who asked; A\'s Agent starts',
  surface: 'the Agent opens a viewer for B\'s task: placement by rule, the same-matter question (a bounded wait), opened quietly',
  result: 'the result needs A\'s decision: the owner question, one pointer in A\'s own conversation',
  followup: 'B asks for something that needs nothing from A: the owner question says no, the requester\'s branch, no pointer to A',
  leave: 'B leaves the Board: the identity ends',
})
const stepsOf = ids => Object.freeze(ids.map(id => Object.freeze({ id, title: STEP_DEFS[id] })))
export const STEPS_V1 = stepsOf(['join', 'ask', 'surface', 'result', 'leave'])
export const STEPS_V2 = stepsOf(['join', 'ask', 'surface', 'result', 'followup', 'leave'])
export const STEPS = STEPS_V2

// ---- the plan: pre-registered person-level expectations, with owners and caps ----
export class PlanError extends Error { constructor(message) { super(message); this.name = 'PlanError' } }
const bad = message => { throw new PlanError(message) }
const posInt = value => Number.isSafeInteger(value) && value > 0
export function loadScenarioPlan(file = PLAN_FILE) {
  let bytes, raw
  try { bytes = readFileSync(file); raw = JSON.parse(bytes.toString('utf8')) } catch { bad('cannot read the plan file') }
  if (typeof raw?.set !== 'string' || !raw.set || typeof raw.registered !== 'string' || !raw.registered) bad('the plan needs a set name and its registration time')
  // the steps of the version the plan was registered for (v1: five steps; v2: with the follow-up)
  const versions = [STEPS_V1, STEPS_V2], ids = Array.isArray(raw.steps) ? raw.steps.map(step => step?.id).join(',') : ''
  const order = versions.find(v => v.map(step => step.id).join(',') === ids)
  if (!order) bad(`the plan needs the steps of the scenario in order: ${versions.map(v => v.map(step => step.id).join(',')).join(' or ')}`)
  let requests = 0, tokens = 0
  const steps = raw.steps.map((step, index) => {
    const def = order[index]
    if (step?.id !== def.id) bad(`plan step ${index + 1} must be ${def.id}`)
    if (!posInt(step.caps?.maxRequests) || !posInt(step.caps?.maxEstTokens)) bad(`${def.id}: caps.maxRequests and caps.maxEstTokens must be positive integers`)
    requests += step.caps.maxRequests; tokens += step.caps.maxEstTokens
    if (!Array.isArray(step.expect) || !step.expect.length) bad(`${def.id}: at least one expectation`)
    const ids = new Set()
    const expect = step.expect.map(e => {
      if (typeof e?.id !== 'string' || !e.id || ids.has(e.id)) bad(`${def.id}: every expectation needs a unique id`)
      ids.add(e.id)
      if (e.severity !== 'hard' && e.severity !== 'soft') bad(`${e.id}: severity must be hard or soft`)
      if (!OWNERS.includes(e.owner)) bad(`${e.id}: owner must be one of ${OWNERS.join(', ')}`)
      if (!['A', 'B', 'ledger', 'system'].includes(e.who)) bad(`${e.id}: who must be A, B, ledger or system (whose view the expectation is about)`)
      if (typeof e.text !== 'string' || !e.text.trim()) bad(`${e.id}: text is required`)
      if (!Object.hasOwn(CHECKS, e.check)) bad(`${e.id}: unknown check ${e.check}`)
      return { id: e.id, severity: e.severity, owner: e.owner, who: e.who, text: e.text, check: e.check, args: e.args ?? {} }
    })
    return { id: def.id, title: def.title, caps: { maxRequests: step.caps.maxRequests, maxEstTokens: step.caps.maxEstTokens }, expect }
  })
  if (requests > DEFAULT_CAPS.maxRequests || tokens > DEFAULT_CAPS.tokenCeiling) bad(`the per-step caps add up to ${requests} requests / ${tokens} tokens: over the scenario's ${DEFAULT_CAPS.maxRequests} / ${DEFAULT_CAPS.tokenCeiling}`)
  return { set: raw.set, registered: raw.registered, sha256: sha256(bytes), steps }
}

// ---- checks: each judges one expectation from what the step recorded ----
const ALIAS = /m-[0-9a-f]{16}/
const famCount = (step, family) => step.requests.filter(q => q.family === family).length
const range = (n, { equals, min, max }) => (equals === undefined || n === equals) && (min === undefined || n >= min) && (max === undefined || n <= max)
export const CHECKS = {
  // how many Decision requests (of a family, or all) the step made
  requests: ({ step, args }) => { const n = args.family ? famCount(step, args.family) : step.requests.length; return { pass: range(n, args), observed: { count: n, families: step.requests.map(q => q.family) } } },
  // who is listed on a person's Desk (their presence snapshot), by role
  presence: ({ step, args }) => { const rows = step.seen[args.person].presence; const others = rows.filter(row => !row.self); const withView = others.filter(row => row.viewport).length
    return { pass: range(others.length, args.others ?? {}) && (args.withView === undefined || withView === args.withView), observed: { others: others.length, withView } } },
  // the requester as each layer holds it: the window resolved it, the bridge's audience names it, the placement hook received it
  requester: ({ step, args }) => { const id = step.seen.identity
    const pass = args.present ? id.resolved === true && id.bridgeAudience === 'member' && id.windowFor === 'member' : id.resolved === false && id.windowFor === null && id.bridgeRefusesNew === true
    return { pass, observed: id } },
  // nothing that identifies a person or a request reached the Decision model in this step
  noIdentityInBodies: ({ step }) => { const leaks = step.bodies.filter(b => ALIAS.test(b.text) || b.text.includes(step.seen.identity?.requestId ?? '\u0000') || /acct-|"x":|egask1-/.test(b.text)).map(b => b.family)
    return { pass: leaks.length === 0, observed: { leaks } } },
  // the viewer stayed where it opened (later answers are recorded only)
  notMovedAfterOpen: ({ step }) => { const s = step.seen.A.surface; return { pass: !!s && s.movedAfterOpen === false, observed: s ? { movedAfterOpen: s.movedAfterOpen, waited: s.waited } : null } },
  // the viewer opened beside the related card (the same-matter answer came within the wait)
  openedBesideRelated: ({ step }) => { const s = step.seen.A.surface; return { pass: !!s && s.besideRelated === true, observed: s ? { besideRelated: s.besideRelated, decided: s.decided } : null } },
  // where the work surface opened on A's Desk, and by which rule
  surfaceSpot: ({ step, args }) => { const s = step.seen.A.surface
    const pass = !!s && s.quiet === true && s.rule === args.rule && !s.inAView && (args.nearB ? s.nearB : true) && !s.inBView === !args.inBView
    return { pass, observed: s } },
  // A's camera, focus and own cards exactly as before the step; no reveal scheduled
  aUndisturbed: ({ step }) => { const a = step.seen.A; return { pass: a.cameraCalls === 0 && a.revealTimers === 0 && a.focusChanged === false && a.cardsMoved.length === 0, observed: { cameraCalls: a.cameraCalls, revealTimers: a.revealTimers, focusChanged: a.focusChanged, cardsMoved: a.cardsMoved } } },
  // the shared ledger: its file and its cards (members change only when somebody joins or leaves)
  ledger: ({ step, args }) => { const l = step.seen.ledger; return { pass: (args.fileUnchanged ? l.fileUnchanged === true : true) && l.cardsUnchanged === true, observed: l } },
  // B's own Desk: no new card, nothing of A's private placement
  bDeskUnchanged: ({ step }) => ({ pass: step.seen.B.cardsAdded === 0, observed: { cardsAdded: step.seen.B.cardsAdded } }),
  // a work_placement request's questions, and that each card is quoted only in its own question and the run's request is quoted
  // quotesPostedAnswer (v2): the answer quoted is exactly the answer A saw posted in this step (cycle 15: v1's R1 named a phrase of the scripted draft,
  // which the posted, revised answer no longer had). The observed part names what failed.
  placementBody: ({ step, args }) => { const all = step.bodies.filter(b => b.family === 'work_placement'), failed = []
    // v4 (select): the step has args.requests work_placement requests (a placement and an attention); the one asking exactly args.questions is checked
    const names = b => JSON.stringify(JSON.parse(b.text).questions.map(q => q.name))
    const bodies = args.select ? (all.length === (args.requests ?? 1) ? all.filter(b => names(b) === JSON.stringify(args.questions)) : []) : all
    if (bodies.length !== 1) failed.push(args.select ? `requests:${all.length}/selected:${bodies.length}` : `requests:${bodies.length}`)
    else {
      const w = JSON.parse(bodies[0].text), names = w.questions.map(q => q.name), shared = w.input.map(m => m.content).join('\n')
      if (JSON.stringify(names) !== JSON.stringify(args.questions)) failed.push('questions')
      for (const text of args.quotes ?? []) if (!shared.includes(text)) failed.push(`quote:${text.slice(0, 24)}`)
      // the product quotes the answer on one line (its whitespace collapsed); compare the same way
      const oneLine = text => String(text).replace(/\s+/g, ' ').trim()
      if (args.quotesPostedAnswer) { const posted = step.seen.newMessages.filter(m => m.by === 'agent').map(m => m.text); if (posted.length !== 1 || !oneLine(shared).includes(oneLine(posted[0]))) failed.push('posted_answer') }
      // v3: the answering model's own sentences of the answer A saw (the posted answer without the draft check's appended copy), and none of that copy
      if (args.quotesOwnAnswer) {
        const posted = step.seen.newMessages.filter(m => m.by === 'agent').map(m => m.text)
        const own = posted.length === 1 ? oneLine(posted[0] === DRAFT_CHECK_COPY.askUser ? '' : posted[0].replace(DRAFT_CHECK_COPY.partial, '')) : null
        if (own === null || (own && !oneLine(shared).includes(own))) failed.push('own_answer')
        if (Object.values(DRAFT_CHECK_COPY).some(copy => oneLine(shared).includes(oneLine(copy)))) failed.push('check_copy_quoted')
      }
      ;(args.cards ?? []).forEach((label, i) => { if (!(w.questions[i]?.instructions.includes(label) && args.cards.every((other, j) => j === i || !w.questions[i].instructions.includes(other)) && !shared.includes(label))) failed.push(`card:${i + 1}`) })
    }
    return { pass: failed.length === 0, observed: { requests: all.length, questions: all.map(b => JSON.parse(b.text).questions.map(q => q.name)), failed } } },
  // v4: A's window sent the attention scene itself (its trigger on the run's run.completed): one entry, sent as expected, with the code's outcome words
  windowAttention: ({ step, args }) => { const rows = step.seen.A.windowAttention ?? []
    return { pass: rows.length === 1 && rows[0].sent === args.sent && (args.owner === undefined || rows[0].owner === args.owner), observed: { rows } } },
  // v4: the answer A saw carries none of the registered fallback sentences (the owner removed them; the model says itself what it could not confirm)
  noCaveat: ({ step, args }) => { const agent = step.seen.newMessages.filter(m => m.by === 'agent').map(m => m.text), oneLine = t => String(t).replace(/\s+/g, ' ').trim()
    const found = (args.caveats ?? []).filter(c => agent.some(text => oneLine(text).includes(oneLine(c))))
    return { pass: agent.length === 1 && found.length === 0, observed: { found } } },
  // a request of this family answered within the product's budget for it (the turn's Decision context: 800 ms)
  answeredWithin: ({ step, args }) => { const rows = step.requests.filter(q => q.family === args.family)
    return { pass: rows.length > 0 && rows.every(q => q.status === 200 && Number.isFinite(q.elapsedMs) && q.elapsedMs <= args.maxMs), observed: { elapsedMs: rows.map(q => q.elapsedMs), budgetMs: args.maxMs } } },
  // the Agent's answer A saw is the one the subjective model wrote (the draft check did not replace it)
  answerAsWritten: ({ step, args }) => { const agent = step.seen.newMessages.filter(m => m.by === 'agent').map(m => m.text)
    return { pass: agent.length === 1 && agent[0] === { decision: ANSWER, info: ANSWER_INFO }[args.said], observed: { agent } } },
  // a predicate answer of this step's work_placement request
  answer: ({ step, args }) => { const row = step.requests.find(q => q.family === 'work_placement' && (!args.select || (q.answers ?? []).some(x => x.name === args.name))); const a = (row?.answers ?? []).find(x => x.name === args.name)
    const p = a?.type === 'predicate' ? a.probability : null
    return { pass: p !== null && (args.min === undefined || p >= args.min) && (args.max === undefined || p <= args.max), observed: { probability: p } } },
  // messages a person sees in A's own conversation after the step (by: person | agent | system_flow)
  messages: ({ step, args }) => { const list = step.seen.newMessages.filter(m => args.by === undefined || m.by === args.by)
    return { pass: range(list.length, args) && (args.text === undefined || list.every(m => m.text === args.text)), observed: { count: list.length, texts: list.map(m => `${m.by}: ${m.text}`) } } },
  // the placement record of the step (rule, branch, pointer)
  placementRecord: ({ step, args }) => { const rec = step.seen.placementRecords.at(-1) ?? null
    return { pass: !!rec && Object.entries(args).every(([k, v]) => rec[k] === v), observed: rec } },
}
export const CHECK_NAMES = Object.freeze(Object.keys(CHECKS))

// ---- the world: L2's bridge world, a joint Board with its presence service, two Desks, and A's surface ----
const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const at = surfaceSource.indexOf(`  function ${name}(`), atAsync = surfaceSource.indexOf(`  async function ${name}(`); const s = at >= 0 ? at : atAsync; if (s < 0) throw new Error(`surface function ${name} not found`); return surfaceSource.slice(s, surfaceSource.indexOf('\n  }', s) + 4) }
// A product route called the way the bridge calls it (loopback request and response objects, no socket).
async function route(handler, pathname, body) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } })
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, setHeader() {}, writeHead(status) { this.status = status }, end(raw) { this.body = raw ? JSON.parse(raw) : null; this.writableEnded = true } })
  await handler(req, res, new URL(pathname, 'http://127.0.0.1:39218'))
  return { status: res.status, body: res.body }
}

// The flags of the scenario: the conversation flow, presence and placement on (live), and the draft check on (a system message such as the pointer is
// posted only as a checked message: lane L3's rule); everything this scenario does not use off.
const SCENARIO_ENV = Object.freeze({ EGDESK_DRAFT_CHECK: 'on', EGDESK_BROWSER_ENTRY: 'off', EGDESK_COMMAND_JUDGE: 'off', EGDESK_TERMINAL_GATE: 'off', EGDESK_WORKING_MEMORY: 'off', EGDESK_BRIEFING_FLOW: 'off',
  EGDESK_CONVERSATION_FLOW: 'on', EGDESK_PRESENCE: 'on', EGDESK_WORK_PLACEMENT: 'on' })

export function scenarioWorld(t, { transport = null } = {}) {
  const w = allOnWorld(t, { transport, env: SCENARIO_ENV, settleLimitMs: 60_000 })
  w.state.wording.pointer = POINTER
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-multiuser-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ledgerFile = path.join(dir, 'joint.sqlite')
  const store = createJointStore(ledgerFile, { now: () => w.clock() }); t.after(() => { try { store.close() } catch { /* closed */ } })
  const keys = { a: store.issueAccount('a', 'synthetic owner A'), b: store.issueAccount('b', 'synthetic member B') }
  const act = (p, action, o = {}) => store.mutate(p, { action, ...o, request: randomUUID() })
  const board = act('b', 'accept', { invite: act('a', 'propose', { to: 'b', title: 'synthetic joint board' }).sent[0].id }).boards[0].id
  const hub = createPresenceHub({ access: store.presenceAccess, now: () => w.clock() })
  const sha256Hex = async text => sha256(Buffer.from(text, 'utf8'))
  function desk(who, { offset, view }) {
    const d = { who, offset, view: { ...view }, focus: null, inputAt: w.clock(), cards: [] }
    const single = WP.createSingleUserPresence({ viewport: () => ({ ...d.view }), focusCard: () => d.focus, lastInputAt: () => d.inputAt, now: () => w.clock() })
    d.joint = JP.createJointPresence({ send: async body => hub.exchange(who, body), now: () => w.clock(), self: () => single.snapshot()[0] ?? null,
      boards: () => [{ id: board, offset: { ...d.offset }, region: r(d.offset.x - 400, d.offset.y - 400, 6000, 4000) }] })
    d.presence = JP.createDeskPresence({ single, joint: () => d.joint })
    d.requests = JP.createRequestRequesters({ joint: () => d.joint, sha256Hex })
    d.touch = () => { d.inputAt = w.clock() }
    return d
  }
  const A = desk('a', { offset: { x: 0, y: 0 }, view: A_VIEW }), B = desk('b', { offset: B_OFFSET, view: B_SEES })
  const mirrorHttp = createPresenceMirrorHttpHandler({ mirror: w.presenceMirror, enabled: () => true })
  const requesterHttp = createRunRequesterHttpHandler({ requesters: w.runRequesters, enabled: () => true })
  // A's surface: the surface's own functions over a synthetic canvas (nodes with rects; Board regions; one camera; the active card).
  const canvas = { pan: { x: 0, y: 0 }, zoom: 1, active: 'a-memo', cameraCalls: 0, revealTimers: 0,
    nodes: A_CARDS.map(c => ({ id: c.id, isConnected: true, dataset: {}, _rect: { ...c.rect }, _kind: c.kind, ...(c.record ? { _resultRecord: c.record } : {}) })), regions: [{ id: 'region-1', _rect: { ...BOARD_REGION } }] }
  const hostState = { get activeEntityId() { return canvas.active }, panTarget: canvas.pan, get zoomTarget() { return canvas.zoom }, agenda: {}, surface: {}, presence: A.presence,
    setCanvasPanTarget: () => { canvas.cameraCalls++ }, setCanvasViewportTarget: () => { canvas.cameraCalls++ } }
  // A's chat screen: the bridge's chat.event stream through the product's reducer path, and what the product's loop calls next for each event
  // (state.noteWorkChatEvent: the attention trigger). This is the transport; the runner builds no scene and posts nothing itself.
  const ui = screen(w, DM, { onEvent: (event, run) => hostState.noteWorkChatEvent?.(event, run) })
  hostState.codex = { chatProtocol: ui.protocol }
  const deps = { WorkPlacement: WP, SurfaceState, ChatState, state: hostState, readSurfacePref: key => (key === WP.WORK_PLACEMENT_PREF ? 'on' : undefined),
    document: { querySelectorAll: sel => (sel === '.egd-canvas-card' ? canvas.nodes : sel.includes('.egd-board-region') ? (sel.includes('.egd-canvas-card') ? [...canvas.nodes, ...canvas.regions] : canvas.regions) : []) },
    window: { addEventListener() {}, setTimeout: () => { canvas.revealTimers++; return 1 } }, persistentEntityGeometry: n => ({ ...n._rect, zIndex: 1 }), cardKindForPersistence: n => n._kind ?? 'file',
    // placeWorkSurface's bounded wait: the product waits on wall time, which includes the provider's latency. The bridge world holds its virtual clock
    // still while a Decision request is in flight, so the window's clock here is the virtual time (the heartbeat's nudge, the polls) PLUS real elapsed time.
    workWaitNow: () => w.clock() + performance.now(), workWaitSleep: ms => w.advance(ms),
    safeViewportWorldRect: () => ({ left: A.view.x, top: A.view.y, right: A.view.x + A.view.width, bottom: A.view.y + A.view.height }), viewportToCanvasPoint: (x, y) => ({ x, y }),
    safeViewportRect: () => ({ left: 0, top: 0, right: A.view.width, bottom: A.view.height }),
    deskStoreRequest: async (method, p, body) => (p.startsWith('/decision/work-placement/') ? w.http(method, p, body) : { status: 404, body: null }) }
  const body = `let workInputAt = null, workInputWatch = false;\n${decl('workPresence')}\n${decl('workSceneInputs')}\n${decl('workRunRef')}\n${decl('noteWorkSurfacePlacement')}\nstate.noteWorkSurfacePlacement = noteWorkSurfacePlacement;\n${decl('placeWorkSurface')}\n${decl('resolveCanvasCardPlacement')}\n${decl('revealPlacedCanvasCard')}\n${decl('workSurfaceMark')}\nstate.workSurfaceMark = workSurfaceMark;\nconst workAttentionSent = new Set();\n${decl('noteWorkChatEvent')}\nstate.noteWorkChatEvent = noteWorkChatEvent;\nreturn { resolveCanvasCardPlacement, revealPlacedCanvasCard, placeWorkSurface, workSurfaceMark };`
  const surface = new Function(...Object.keys(deps), body)(...Object.values(deps))
  // installDeskPresence's wrapper: the placement hook receives the run's requester; the bridge is told through its own route.
  const runRequesters = JP.createRunRequesters({ snapshot: () => A.presence.snapshot(), seated: (b, member) => A.joint.seated(b, member), now: () => w.clock(),
    post: payload => route(requesterHttp, RUN_REQUESTER.path, payload) })
  hostState.noteWorkSurfacePlacement = runRequesters.wrap(hostState.noteWorkSurfacePlacement); hostState.runRequesters = runRequesters
  const s = { w, ui, hostState, store, board, ledgerFile, hub, A, B, canvas, surface, runRequesters, mirrorHttp, requesterHttp, keys, act }
  // A types in the room: the composer's request registration, as the screen does before the request leaves
  s.say = async text => { const n = w.state.sends + 1, out = await w.send(text); if (!out.inRun) ui.sent(text, `req-${n}`, out); return out }
  // one presence round: both Desks publish and read (3 s apart on the scenario's clock), and A's Desk mirrors its snapshot to the bridge
  s.round = async (people = [A, B]) => { await w.advance(JP.PRESENCE.publishMs); for (const p of people) { p.touch(); await p.joint.tick() } await route(mirrorHttp, PRESENCE_MIRROR.path, { rows: A.presence.snapshot() }) }
  return s
}

// ---- what each person saw after a step ----
const ledgerState = s => { const v = s.store.view('a'); const boardView = (v.boards ?? []).find(b => b.id === s.board) ?? null
  return { fileSha: sha256(readFileSync(s.ledgerFile)), cards: JSON.stringify(boardView?.cards ?? boardView?.content ?? null), members: JSON.stringify(boardView?.members ?? null) } }
const listed = w => { try { return w.store.listMessages(DM).messages } catch (error) { if (error?.code === 'CONVERSATION_NOT_FOUND') return []; throw error } } // before A's first message there is no conversation
const messagesOf = w => listed(w).map(m => ({ id: m.id ?? m.localMessageId ?? null, role: m.role, by: m.role === 'user' ? 'person' : String(m.id ?? m.localMessageId ?? '').startsWith('egdesk-flow:') ? 'system_flow' : 'agent', text: m.text }))
function snapshotBefore(s) { return { ledger: ledgerState(s), messages: messagesOf(s.w).length, decisions: s.w.decisions.length, cards: s.canvas.nodes.map(n => [n.id, { ...n._rect }]), active: s.canvas.active,
  cameraCalls: s.canvas.cameraCalls, revealTimers: s.canvas.revealTimers, windowLog: (s.hostState.workPlacementLog ?? []).length, records: s.w.workPlacement.records().length, bCards: s.B.cards.length } }
function seenAfter(s, before, extra) {
  const ledger = ledgerState(s), msgs = messagesOf(s.w).slice(before.messages)
  const moved = before.cards.filter(([id, rect]) => { const n = s.canvas.nodes.find(x => x.id === id); return !n || n._rect.x !== rect.x || n._rect.y !== rect.y || n._rect.width !== rect.width || n._rect.height !== rect.height }).map(([id]) => id)
  const rows = p => p.presence.snapshot().map(row => ({ self: row.self, active: row.active, viewport: row.viewport ? 'region' : null }))
  return { newMessages: msgs.map(m => ({ room: DM, role: m.role, by: m.by, text: m.text })),
    A: { presence: rows(s.A), cameraCalls: s.canvas.cameraCalls - before.cameraCalls, revealTimers: s.canvas.revealTimers - before.revealTimers, focusChanged: s.canvas.active !== before.active, cardsMoved: moved,
      ...(extra.surface ? { surface: extra.surface } : {}), windowAttention: (s.hostState.workPlacementLog ?? []).slice(before.windowLog).filter(e => e.attention).map(e => ({ ...e })) },
    B: { presence: rows(s.B), cardsAdded: s.B.cards.length - before.bCards, conversationMessages: 0 },
    ledger: { fileUnchanged: ledger.fileSha === before.ledger.fileSha, cardsUnchanged: ledger.cards === before.ledger.cards, membersUnchanged: ledger.members === before.ledger.members },
    identity: extra.identity ?? null, placementRecords: s.w.workPlacement.records().slice(before.records) }
}

// ---- the scenario's steps (the product calls; the people's input is scripted) ----
async function identityNow(s, ctx) {
  const who = s.A.requests.of(ctx.review), alias = s.B.joint.aliasOn(s.board)
  const audience = ctx.ref ? s.w.runRequesters.audience({ run: { clientThreadId: ctx.ref.clientThreadId, conversationId: ctx.ref.conversationId } }) : null
  const windowFor = ctx.ref ? s.runRequesters.for(ctx.ref) : null
  let bridgeRefusesNew = null
  if (ctx.left) bridgeRefusesNew = (await route(s.requesterHttp, RUN_REQUESTER.path, { clientThreadId: 'dm-next', conversationId: null, requester: { board: s.board, alias: ctx.alias } })).body?.status === 'unknown-member'
  return { resolved: !!who && who.alias === alias, bridgeAudience: audience?.requester === ctx.alias ? 'member' : audience ? 'other' : null, windowFor: windowFor === ctx.alias ? 'member' : windowFor, bridgeRefusesNew, requestId: ctx.review?.requestId ?? null }
}
// The run's file viewer, as EGDeskSurfaceFileCard opens one (openVerifiedRunFile, then spawnFileCard): the bounded wait first, then the usual path if it
// gave nothing; the card carries the run's mark as spawnFileCard sets it (state.workSurfaceMark of the run file's target; the attention trigger finds it by that).
async function openViewer(s, ref, id) {
  const work = { kind: 'file', runId: ref.runId, conversationId: ref.conversationId }
  const waited = await s.surface.placeWorkSurface('file', work)
  const placed = waited || s.surface.resolveCanvasCardPlacement('file', { workSurface: work })
  s.surface.revealPlacedCanvasCard({ isConnected: true }, placed)
  const node = { id, isConnected: true, dataset: { ...(s.surface.workSurfaceMark({ runId: ref.runId, conversationId: ref.conversationId, itemId: 'item-1' }) || {}) }, _rect: { x: placed.x, y: placed.y, width: placed.width, height: placed.height }, _kind: 'file', _resultRecord: null }
  s.canvas.nodes.push(node) // opened (not activated): the shell is told activate: false for a quiet placement
  return { placed, waited, node }
}
const RUNNERS = {
  async join(s) {
    s.B.joint.setShare(s.board, 'region'); s.A.joint.setShare(s.board, 'active'); await s.A.joint.idle(); await s.B.joint.idle()
    await s.round(); await s.round()
    return {}
  },
  async ask(s, ctx) {
    // B makes a Board question request (the file travels by hand); A opens it; the service vouches for who made it.
    ctx.review = { kind: 'request', requestId: '6f0e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4', requestDigest: sha256(Buffer.from('synthetic B request')), question: ASK, recipient: 'A', excerpt: '', expectedReply: 'short', askCode: 'egask1-synthetic-not-a-code' }
    await s.B.requests.exported(ctx.review); await s.A.requests.inspected(ctx.review)
    await s.round(); await s.round()
    ctx.alias = s.B.joint.aliasOn(s.board)
    const who = s.A.requests.of(ctx.review)
    // A's Agent starts working on it in A's own conversation (no product screen does this yet: the requester hook is called here, see report)
    const out = await s.say(ASK)
    ctx.ref = { runId: out.runId, clientThreadId: DM, conversationId: out.conversationId }
    if (who) s.runRequesters.set(ctx.ref, who)
    await s.w.idle(); s.ui.pump()
    return { identity: await identityNow(s, ctx) }
  },
  async surface(s, ctx) {
    const { placed, waited, node } = await openViewer(s, ctx.ref, 'agent-viewer')
    ctx.viewer = node
    await s.w.settle(); await s.w.advance(1000); await s.w.idle()
    const rec = s.w.workPlacement.records().at(-1)
    const rect = ctx.viewer._rect, opened = { ...rect }
    // later beats: an answer that arrives after the deadline is recorded only; the viewer stays where it opened
    await s.w.advance(3000); await s.w.idle()
    return { identity: await identityNow(s, ctx), surface: { quiet: placed.quiet === true, waited: !!waited, rule: rec?.rule ?? null, rect: { ...rect }, movedAfterOpen: rect.x !== opened.x || rect.y !== opened.y,
      inAView: hits(rect, A_VIEW), inBView: hits(rect, B_VIEW), nearB: gapTo(rect, B_VIEW) < WP.PLACEMENT_RULES.nearViews * B_VIEW.width,
      besideRelated: gapTo(rect, A_CARDS.find(c => c.id === 'a-quote-v1').rect) <= WP.PLACEMENT_RULES.gap + 1, decided: rec ? { source: rec.source, kind: rec.would.kind } : null } }
  },
  async result(s, ctx) {
    s.w.state.wording.revise = ANSWER // the scripted subjective model revises its own draft (lane L2's default revision is one fixed sentence about another matter)
    await s.w.answer(ANSWER)
    // L1 c17: the run finishes on the bridge; its run.completed reaches A's window, whose own trigger sends the attention scene (nothing here sends it)
    await s.w.idle(); s.ui.pump()
    await s.round(); await s.w.advance(10_000); await s.round(); await s.w.advance(10_000); await s.w.idle()
    return { identity: await identityNow(s, ctx) }
  },
  async followup(s, ctx) {
    const out = await s.say(ASK2)
    ctx.ref2 = { runId: out.runId, clientThreadId: DM, conversationId: out.conversationId }
    const who = s.A.requests.of(ctx.review)
    if (who) s.runRequesters.set(ctx.ref2, who)
    await s.w.idle(); s.ui.pump()
    // this run opens its own viewer (the delivery schedule), as the first run did; the attention scene for it then comes from A's window when it finishes.
    // (Before c17 the runner sent a scene for the first run's viewer as if it were this run's; the window's trigger only describes a run's own surface.)
    await openViewer(s, ctx.ref2, 'agent-viewer-2'); await s.w.settle(); await s.w.advance(1000); await s.w.idle()
    s.w.state.wording.revise = ANSWER_INFO
    await s.w.answer(ANSWER_INFO)
    await s.w.idle(); s.ui.pump()
    await s.round(); await s.w.advance(10_000); await s.round(); await s.w.advance(10_000); await s.w.idle()
    return { identity: await identityNow(s, { ...ctx, ref: ctx.ref2 }) }
  },
  async leave(s, ctx) {
    s.act('b', 'leave', { board: s.board })
    await s.round([s.A]); await s.round([s.A]); await s.round([s.A])
    ctx.left = true
    return { identity: await identityNow(s, ctx) }
  },
}

/**
 * The dry run's Decision model: lane L2's scripted model, with this scenario's own questions answered as the plan pre-registers them (a dry run then
 * walks the path the plan expects; a send may take another, and the results say so): the earlier v1 quote card is the same matter, the lunch card is
 * not; a result needs the owner only when it asks the owner to approve or decide.
 */
export function scriptedScenario() {
  const base = scriptedDecisions()
  return { async answer(wire) {
    const answers = await base.answer(wire)
    return answers.map(a => {
      const q = wire.questions.find(x => x.name === a.name)
      if (/^same_matter_R\d$/.test(a.name)) return { name: a.name, type: 'predicate', probability: /A사 견적서 v1/.test(q?.instructions ?? '') ? 0.95 : 0.03 }
      // the owner question, from the quoted result: yes only when it asks the owner to approve or decide something
      // (v3) and, as the real model read it in the v2 send (.95), a request to the reader for material ("자료를 알려 주세요") counts as asking the owner too
      if (a.name === 'owner_action') { const text = (Array.isArray(wire.input) ? wire.input.map(m => m.content) : [String(wire.input)]).join('\n'); return { name: a.name, type: 'predicate', probability: /승인해 주셔야|정해 주세요|자료를 알려 주세요/.test(text) ? 0.95 : 0.03 } }
      return a
    })
  } }
}

const requestRow = d => ({ ...(d.replay ? { replay: d.replay } : {}), family: d.feature, caller: d.caller, origin: d.origin, sha256: d.sha256, bytes: d.bytes, questions: d.names, estInputTokens: d.estInputTokens ?? null,
  sent: d.sent === true, ...(d.refused ? { refused: d.refused } : {}), status: d.status ?? null, ...(d.error ? { error: d.error } : {}), elapsedMs: d.netElapsedMs ?? d.elapsedMs ?? null, usage: d.usage ?? null, answers: d.answers ?? null })

export async function runScenario({ plan, send = false, key = null, fetchImpl = globalThis.fetch, caps = DEFAULT_CAPS, now = null, replay = null } = {}) {
  const cleanups = [], t = { after: fn => cleanups.push(fn) }
  const { transport, ledger } = createMeasureTransport({ send, key, fetchImpl, caps, plan, now, scripted: scriptedScenario(), replay: send === true ? null : replay })
  const steps = []
  try {
    const s = scenarioWorld(t, { transport }), ctx = {}
    for (const def of plan.steps) {
      if (ledger.stopped) { steps.push({ id: def.id, title: def.title, state: 'not_run' }); continue }
      s.w.step(def.id)
      const before = snapshotBefore(s)
      let failure = null, extra = {}
      try { extra = (await RUNNERS[def.id](s, ctx)) ?? {}; await s.w.idle() } catch (error) { failure = typeof error?.code === 'string' ? error.code : error?.name ?? 'error' }
      const rows = s.w.decisions.slice(before.decisions)
      steps.push({ id: def.id, title: def.title, state: ledger.stopped?.step === def.id ? 'stopped' : 'done', ...(failure ? { failure } : {}),
        requests: rows.map(requestRow), seen: seenAfter(s, before, extra), bodies: rows.map(d => ({ family: d.feature, text: d.raw })) })
    }
    for (const step of steps) {
      const planned = plan.steps.find(p => p.id === step.id)
      step.checks = planned.expect.map(e => {
        const base = { id: e.id, severity: e.severity, owner: e.owner, who: e.who, text: e.text }
        if (step.state === 'not_run') return { ...base, pass: null, state: 'not_run' }
        try { return { ...base, ...CHECKS[e.check]({ step, args: e.args }) } } catch { return { ...base, pass: false, state: 'check_failed' } }
      })
      delete step.bodies // request bodies stay in memory: the results carry their sha256 and size, not their text
    }
  } finally { for (const fn of cleanups.reverse()) { try { fn() } catch { /* cleanup */ } } }
  const checks = steps.flatMap(st => st.checks ?? [])
  const scorecard = { hard: { passed: checks.filter(c => c.severity === 'hard' && c.pass === true).length, failed: checks.filter(c => c.severity === 'hard' && c.pass === false).map(c => c.id), notRun: checks.filter(c => c.severity === 'hard' && c.pass === null).length },
    soft: { passed: checks.filter(c => c.severity === 'soft' && c.pass === true).length, missed: checks.filter(c => c.severity === 'soft' && c.pass === false).map(c => c.id), notRun: checks.filter(c => c.severity === 'soft' && c.pass === null).length } }
  return { steps, ledger, scorecard }
}

// ---- output: the step table, the results file, the re-run diff ----
const familyCounts = requests => requests.reduce((m, q) => (m[q.family] = (m[q.family] || 0) + 1, m), {})
export function stepTable(outcome) {
  return outcome.steps.map(st => ({ step: st.id, state: st.state, requests: st.requests?.length ?? 0, families: st.requests ? familyCounts(st.requests) : {},
    estInputTokens: (st.requests ?? []).reduce((n, q) => n + (q.estInputTokens ?? 0), 0),
    hard: st.checks ? `${st.checks.filter(c => c.severity === 'hard' && c.pass === true).length}/${st.checks.filter(c => c.severity === 'hard').length}` : '-',
    soft: st.checks ? `${st.checks.filter(c => c.severity === 'soft' && c.pass === true).length}/${st.checks.filter(c => c.severity === 'soft').length}` : '-',
    ...(st.requests?.some(q => q.refused) ? { refused: st.requests.filter(q => q.refused).map(q => q.refused) } : {}) }))
}
export function resultsPayload({ outcome, plan, send, caps, replayOf = null, at = new Date() }) {
  return { set: plan.set, mode: send ? 'send' : replayOf ? 'replay' : 'dry_run', at: at.toISOString(), endpoint: DECISIONS_ENDPOINT, automaticRetries: 0, ...(replayOf ? { replayOf } : {}),
    plan: { file: path.basename(PLAN_FILE), sha256: plan.sha256, registered: plan.registered }, script: { sha256: sha256(readFileSync(SCRIPT_FILE)) },
    caps: { tokenCeiling: caps.tokenCeiling, maxRequests: caps.maxRequests, perStep: Object.fromEntries(plan.steps.map(st => [st.id, st.caps])) },
    totals: { requests: outcome.ledger.requests, sent: outcome.ledger.sent, inputTokensCounted: outcome.ledger.tokens, inputTokensReported: outcome.ledger.reportedTokens, refusedBodies: outcome.ledger.refusedBodies,
      ...(replayOf ? { replayUnmatched: outcome.ledger.replayUnmatched, replayChangedBody: outcome.ledger.replayChangedBody } : {}) },
    stoppedBecause: outcome.ledger.stopped?.reason ?? null, stoppedAt: outcome.ledger.stopped?.step ?? null, scorecard: outcome.scorecard, steps: outcome.steps }
}
/** L2's journey diff (requests, answers, messages, expectations) plus what A, B and the shared ledger saw. */
export function diffScenarios(previous, current) {
  const diff = diffJourneys(previous, current)
  const view = step => step?.seen ? { A: { cameraCalls: step.seen.A.cameraCalls, focusChanged: step.seen.A.focusChanged, cardsMoved: step.seen.A.cardsMoved, surface: step.seen.A.surface ? `${step.seen.A.surface.rule}:${step.seen.A.surface.decided?.kind ?? '-'}` : null },
    B: { cardsAdded: step.seen.B.cardsAdded, others: step.seen.B.presence.filter(p => !p.self).length }, ledger: step.seen.ledger, identity: step.seen.identity ? { resolved: step.seen.identity.resolved, audience: step.seen.identity.bridgeAudience, window: step.seen.identity.windowFor } : null } : null
  for (const st of diff.steps) {
    const prev = (previous?.steps ?? []).find(x => x.id === st.step), cur = current.steps.find(x => x.id === st.step)
    for (const part of ['A', 'B', 'ledger', 'identity']) { const a = JSON.stringify(view(prev)?.[part] ?? null), b = JSON.stringify(view(cur)?.[part] ?? null); if (a !== b) st.changes.push({ kind: `seen_${part}`, prev: view(prev)?.[part] ?? null, cur: view(cur)?.[part] ?? null }) }
  }
  return diff
}

const plausibleKey = key => typeof key === 'string' && key.length >= 20 && !/\s/.test(key)
export async function main(argv, { env = {}, fetchImpl = globalThis.fetch, print = line => console.log(line), printError = line => console.error(line), now = null } = {}) {
  const args = [...argv], valued = new Set(['--out', '--plan', '--token-ceiling', '--max-requests', '--rerun']), known = new Set([...valued, '--send'])
  const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
  const unknown = args.find((arg, i) => !known.has(arg) && !valued.has(args[i - 1]))
  const int = (name, fallback, max) => { const v = valueOf(name); if (v === null) return fallback; const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : NaN }
  const caps = { tokenCeiling: int('--token-ceiling', DEFAULT_CAPS.tokenCeiling, LIMITS.tokenCeilingMax), maxRequests: int('--max-requests', DEFAULT_CAPS.maxRequests, LIMITS.maxRequestsMax) }
  if (unknown || [...valued].some(name => args.includes(name) && !valueOf(name)) || Number.isNaN(caps.tokenCeiling) || Number.isNaN(caps.maxRequests)) {
    printError('usage: egdesk-multiuser-live-measure.mjs [--send] [--out results.json] [--plan plan.json] [--token-ceiling n<=20000] [--max-requests n<=20] [--rerun earlier.json]   (dry run unless --send; the key is read from OPENAI_API_KEY only)')
    return EXIT.usage
  }
  const rerun = valueOf('--rerun'), send = args.includes('--send')
  let earlier = null
  if (rerun) { try { const bytes = readFileSync(rerun); const run = JSON.parse(bytes.toString('utf8')); if (Array.isArray(run?.steps)) earlier = { run, sha256: sha256(bytes), file: path.basename(rerun) } } catch { earlier = null } if (!earlier) { printError('the earlier results file cannot be read'); return EXIT.usage } }
  let plan
  try { plan = loadScenarioPlan(valueOf('--plan') ?? PLAN_FILE) } catch (error) { printError(error?.name === 'PlanError' ? `plan refused: ${error.message}` : 'plan refused'); return EXIT.usage }
  const key = send ? env.OPENAI_API_KEY ?? null : null
  if (send && !plausibleKey(key)) { printError('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); return EXIT.noKey }
  const replaying = !!earlier && !send
  print(JSON.stringify({ set: plan.set, mode: send ? 'send' : replaying ? 'replay' : 'dry_run', endpoint: DECISIONS_ENDPOINT, plan: plan.sha256.slice(0, 16), registered: plan.registered, tokenCeiling: caps.tokenCeiling, maxRequests: caps.maxRequests,
    note: send ? 'sending: one request at a time as the product asks' : replaying ? `replay: the answers recorded in ${earlier.file} drive the scenario; nothing is sent` : 'dry run: the pre-registered answers (and lane L2\'s scripted model for everything else) drive the scenario; nothing is sent' }))
  const outcome = await runScenario({ plan, send, key, fetchImpl: send ? stampingFetch(fetchImpl, { file: sendStampPath(env), runner: `multiuser-live-measure ${plan.set}` }) : fetchImpl, caps, now, replay: replaying ? replayAnswers(earlier.run) : null })
  for (const row of stepTable(outcome)) print(JSON.stringify(row))
  const payload = resultsPayload({ outcome, plan, send, caps, replayOf: replaying ? { file: earlier.file, sha256: earlier.sha256, at: earlier.run.at ?? null } : null })
  if (earlier) { payload.diffAgainst = { file: earlier.file, sha256: earlier.sha256, at: earlier.run.at ?? null }; payload.diff = diffScenarios(earlier.run, payload) }
  print(JSON.stringify({ requests: payload.totals.requests, sent: payload.totals.sent, inputTokens: payload.totals.inputTokensCounted, stoppedBecause: payload.stoppedBecause, stoppedAt: payload.stoppedAt,
    hardPassed: payload.scorecard.hard.passed, hardFailed: payload.scorecard.hard.failed, softMissed: payload.scorecard.soft.missed }))
  if (payload.diff) for (const line of formatDiff(payload.diff)) print(line)
  const out = valueOf('--out')
  if (out) writeJourneyResults(out, payload)
  return payload.stoppedBecause ? EXIT.stopped : EXIT.ok
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2), { env: process.env })
