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
import { sendStampPath, stampingFetch } from '../helper/egdesk-decision-send-stamp.mjs'
import { allOnWorld, callerOf, scriptedDecisions, DM } from './egdesk-all-on.support.mjs'

export const PLAN_FILE = fileURLToPath(new URL('./egdesk-all-on-live-measure.plan.json', import.meta.url))
// Plan v2 (cycle 12): every v1 expectation plus the misleading outputs found in the first real run. v1 stays as registered.
export const PLAN_FILE_V2 = fileURLToPath(new URL('./egdesk-all-on-live-measure.plan-v2.json', import.meta.url))
// Plan v3 (cycle 13): every v2 expectation, a genuine recall step, and the person-level checks of what changed since c16. The latest plan.
export const PLAN_FILE_V3 = fileURLToPath(new URL('./egdesk-all-on-live-measure.plan-v3.json', import.meta.url))
// Plan v4 (cycle 15): v3 counted in page bodies, L7's two new turn-memory flags on in the world, the owner question step. The latest plan.
export const PLAN_FILE_V4 = fileURLToPath(new URL('./egdesk-all-on-live-measure.plan-v4.json', import.meta.url))
// Plan v5 (cycle 16): v4, plus switches a run may turn on (--switch <name>, all off by default) and expectations judged only under them.
export const PLAN_FILE_V5 = fileURLToPath(new URL('./egdesk-all-on-live-measure.plan-v5.json', import.meta.url))
export const LATEST_PLAN_FILE = PLAN_FILE_V5
export const SCRIPT_FILE = fileURLToPath(import.meta.url)
export const DEFAULT_CAPS = Object.freeze({ tokenCeiling: 80_000, maxRequests: 80 })
const LIMITS = Object.freeze({ tokenCeilingMax: 200_000, maxRequestsMax: 200 })
export const OWNERS = Object.freeze(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'])
export const BROWSER_ROOM = 'dm-browser'
const CLIENT = 'helper/egdesk-decision-client.mjs', SUPPORT = 'scripts/egdesk-all-on.support.mjs'

// ---- the journey: what the person says, and the scripted subjective model ----
export const SAYS = Object.freeze({ quote: '지난주 A사 견적 건 어디까지 됐지?', tidy: '방금 그 내용 정리해줘', tests: '전체 테스트 돌리고 결과 알려줘',
  recall: 'PostgreSQL 전환은 설계에서 어떻게 하기로 정했었지?', deployed: 'PostgreSQL 마이그레이션 배포 끝났어', portal: '거래처 포털에서 이번 달 세금계산서 내려받아줘', second: '두 번째 사업자로' })
const AGENT_SAYS = Object.freeze({ quote: 'A사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.', tidy: 'A사 견적은 11월 3일 요청, 11월 6일 v1 발송, v2는 팀장 승인 후 발송 예정입니다.',
  recall: 'PostgreSQL 전환 설계에서 스키마 변환, 데이터 이관, 롤백 순서를 정하기로 확정했습니다.', tests: '테스트가 모두 통과했습니다.', noted: '네, 기록해 두겠습니다.', heard: '네, 알겠습니다.', ask: '사업자가 둘입니다. 어느 쪽으로 받을까요?', got: '세금계산서를 내려받았습니다.', stuck: '포털 작업을 마치지 못했습니다.',
  stuckAsk: '포털에서 다음 단계를 정하지 못했습니다. 어느 사업자의 세금계산서를 받을지 알려 주세요.' })
export const COMMAND = 'npm test -- --suite=payroll-secret', COMMAND_OUTPUT = 'running 40 tests'
// (cycle 16) The run's summary line. A real Codex completion's aggregatedOutput is the whole output, the streamed lines and this one; the
// product keeps the longer of the streamed and the completed text (codex-run-outputs.mjs completeCommand), so a shorter completion was ignored.
export const COMMAND_SUMMARY = '40 passed, 0 failed'
const rect = (x, y, width, height) => ({ x, y, width, height })
const people = () => [{ member: 'self', self: true, active: true, viewport: rect(0, 0, 1200, 800), focusCard: null, lastInputAgeMs: 500 },
  { member: 'm-jin', self: false, active: true, viewport: rect(4000, 0, 1200, 800), focusCard: null, lastInputAgeMs: 900 }]
const RESULT_CARDS = () => [{ id: 'own-doc', rect: rect(100, 100, 500, 400), kind: 'file', creator: 'user' }, { id: 'agent-result', rect: rect(-2600, 100, 720, 520), kind: 'result', creator: 'agent', taskId: 'run-1' }]

const running = w => w.state.last && w.runs().at(-1)?.status === 'inProgress'
// The scripted subjective model answers the turn it is in (nothing when no turn of this room is working). What it wrote is kept, so that
// a posted message can be told apart from a system substitution.
async function agentSays(w, text, j) { if (running(w)) { j.said.push(text); await w.answer(text) } }
// The browser turn follows the task note the runtime handed it: the choices when it lists them, a question when it says to tell the person
// and ask (cycle 12: the first real run's note said so and the scripted turn ignored it), a report when the task is done.
// (cycle 13) A question names the choices the note lists, as a model handed them would.
async function agentAnswersTask(w, j) {
  const note = w.note(), choices = Array.isArray(note?.candidates) && note.candidates.length ? ` ${note.candidates.join(' / ')}` : ''
  const text = note?.next === 'ask_user_in_chat' ? AGENT_SAYS.ask + choices : note?.next === 'tell_user_and_ask_in_chat' ? AGENT_SAYS.stuckAsk + choices : note?.status === 'done' ? AGENT_SAYS.got : AGENT_SAYS.stuck
  await agentSays(w, text, j)
}
// (cycle 13) The answering model follows the recording rule when its turn carries it (do not say you recorded or will record anything).
const RECORDING_CONTEXT = 'egdesk_recording'
const carriesRecordingRule = w => Object.hasOwn(w.turnStarts().at(-1)?.params?.additionalContext ?? {}, RECORDING_CONTEXT)
// (cycle 13) The scripted note writer words its note from the waited-on fact the prompt gives, and claims nothing else.
// (cycle 15) The pointer note says what the prompt says the person is pointed at for: a decision, or a result that is ready to look at.
const pointerNote = prompt => (/is ready for them to look at/.test(prompt) ? '결과는 지금 보고 계신 곳 왼쪽 작업 영역에 있습니다.' : null)
const waitNote = prompt => (/a command is still running/.test(prompt) ? '명령이 아직 실행 중이라 조금 더 걸리고 있어요.' : null)
// The result card needs its owner, who looks elsewhere; a second member is on the desk. The request body is the chrome builder's (attentionRequest),
// posted the way the surface posts its placement requests ({ clientThreadId, conversationId, dto }). No surface code sends this request yet.
async function resultNeedsOwner(w, j, task = { state: 'waiting_owner', ownerMustAct: true }) {
  w.presenceMirror.accept(people())
  const cards = RESULT_CARDS()
  const scene = WP.enumerateWorkScene({ presence: w.presenceMirror.snapshot(), cards,
    tasks: [{ id: 'run-1', state: task.state, requester: 'self', waiting: task.state === 'finished' ? [] : ['self'], ownerMustAct: task.ownerMustAct, surfaces: [{ kind: 'result', cardId: 'agent-result' }] }] })
  const built = WP.attentionRequest(scene, { taskId: 'run-1', cardId: 'agent-result' })
  j.note.ownerRequest = built ? (await w.http('POST', '/decision/work-placement/request', { clientThreadId: DM, conversationId: w.state.lastOf.get(DM)?.conversationId ?? null, dto: built.dto })).body : null
  j.note.cards = cards.map(c => ({ id: c.id, kind: c.kind, creator: c.creator, rect: c.rect }))
  await w.advance(25000); w.presenceMirror.accept(people()); await w.advance(40000); await w.idle()
}

/** The steps, in order. Each step's expectations live in the plan file under the same id. */
export const STEPS = Object.freeze([
  { id: 's1-first-turn', room: DM, title: 'first message about the A company quote', run: async (w, j) => { await j.say(SAYS.quote); await w.advance(3000); await agentSays(w, AGENT_SAYS.quote, j) } },
  { id: 's2-follow-up', room: DM, title: 'follow-up in the same session', run: async (w, j) => { await j.say(SAYS.tidy); await w.advance(3000); await agentSays(w, AGENT_SAYS.tidy, j) } },
  { id: 's3-briefing', room: DM, title: 'the briefing of that answer', run: async (w, j) => {
    const run = w.runs().at(-1), answer = w.history().filter(([role]) => role === 'assistant').at(-1)?.[1] ?? ''
    const body = run ? BriefingHost.observeRequest({ mode: 'on', report: answer, answerId: run.answerId, conversationId: run.conversationId, runId: run.runId,
      candidates: BriefingHost.canvasBriefingCandidates([]), request: SAYS.tidy, viewport: rect(0, 0, 1200, 800) }) : null
    j.note.briefing = body ? (await w.http('POST', '/decision/briefing-observe', body)).body : { status: 'not_asked' }
  } },
  { id: 's3b-recall', room: DM, since: 3, title: 'a genuine recall: stored material the conversation does not hold', run: async (w, j) => { await j.say(SAYS.recall); await w.advance(3000); await agentSays(w, AGENT_SAYS.recall, j) } },
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
    await w.notify('item/commandExecution/outputDelta', { ...j.note.command, itemId: 'cmd-1', delta: `${COMMAND_SUMMARY}\n` })
    await w.notify('item/completed', { ...j.note.command, item: { id: 'cmd-1', type: 'commandExecution', command: COMMAND, cwd: '/work', status: 'completed', exitCode: 0, commandActions: [], aggregatedOutput: `${COMMAND_OUTPUT}\n${COMMAND_SUMMARY}\n` } })
    await w.advance(40000)
  } },
  { id: 's6-answer', room: DM, title: 'the answer', run: async (w, j) => { await agentSays(w, AGENT_SAYS.tests, j) } },
  { id: 's7-pointer-advisory', room: DM, title: 'the result needs the owner elsewhere; work placement advisory', run: async (w, j) => { w.ENV.EGDESK_WORK_PLACEMENT = 'advisory'; await resultNeedsOwner(w, j) } },
  { id: 's8-pointer-on', room: DM, title: 'the same, work placement on', run: async (w, j) => { w.ENV.EGDESK_WORK_PLACEMENT = 'on'; await resultNeedsOwner(w, j) } },
  // (cycle 15) A finished result whose need for the owner code cannot tell: placement asks the owner question, quoting the answer.
  { id: 's8b-finished-result', room: DM, since: 4, title: 'a finished result: does it need the owner?', run: async (w, j) => { w.ENV.EGDESK_WORK_PLACEMENT = 'on'; await resultNeedsOwner(w, j, { state: 'finished', ownerMustAct: false }) } },
  { id: 's9-status-remark', room: DM, title: 'a status remark', run: async (w, j) => { await j.say(SAYS.deployed); await w.advance(2000); await agentSays(w, carriesRecordingRule(w) ? AGENT_SAYS.heard : AGENT_SAYS.noted, j); await j.pause() } },
  { id: 's10-browser-task', room: BROWSER_ROOM, title: 'a browser task in a conversation of its own', run: async (w, j) => { w.use(BROWSER_ROOM); await j.say(SAYS.portal, w.browserExtra()); await agentAnswersTask(w, j) } },
  { id: 's11-browser-reply', room: BROWSER_ROOM, title: 'the person answers the task question', run: async (w, j) => { w.use(BROWSER_ROOM); await j.say(SAYS.second, w.browserExtra()); await agentAnswersTask(w, j); await j.pause() } },
])

// ---- the plan (pre-registered expectations) ----
export class PlanError extends Error { constructor(message) { super(message); this.name = 'PlanError' } }
const bad = message => { throw new PlanError(message) }
const posInt = value => Number.isSafeInteger(value) && value > 0
export function loadJourneyPlan(file = PLAN_FILE) {
  let bytes, raw
  try { bytes = readFileSync(file); raw = JSON.parse(bytes.toString('utf8')) } catch { bad('cannot read the plan file') }
  if (typeof raw?.set !== 'string' || !raw.set || typeof raw.registered !== 'string' || !raw.registered) bad('the plan needs a set name and its registration time')
  // A plan lists every step of the journey that has no `since` (the core of v1), plus any later-added step it judges, in journey order.
  if (!Array.isArray(raw.steps)) bad('the plan needs its steps')
  const listed = raw.steps.map(step => step?.id), positions = listed.map(id => STEPS.findIndex(def => def.id === id))
  if (positions.some(p => p < 0)) bad(`unknown plan step ${listed[positions.indexOf(-1)]}`)
  if (positions.some((p, i) => i > 0 && p <= positions[i - 1])) bad('plan steps must follow the journey order')
  const missing = STEPS.filter(def => def.since === undefined && !listed.includes(def.id))
  if (missing.length) bad(`the plan needs the journey step ${missing[0].id}`)
  const steps = raw.steps.map((step, index) => {
    const def = STEPS[positions[index]]
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
      if (e.when !== undefined && (typeof e.when?.switch !== 'string' || !Object.hasOwn(raw.world?.switches ?? {}, e.when.switch))) bad(`${e.id}: when.switch must name a switch of world.switches`)
      return { id: e.id, severity: e.severity, owner: e.owner, text: e.text, check: e.check, args: e.args ?? {}, ...(e.predicted ? { predicted: String(e.predicted) } : {}), ...(e.when ? { when: { switch: e.when.switch } } : {}) }
    })
    return { id: def.id, caps: { maxRequests: step.caps.maxRequests, maxEstTokens: step.caps.maxEstTokens }, expect }
  })
  // (cycle 15) A plan may set developer flags of the all-on world (never the product's defaults): EGDESK_* names with string values.
  const env = raw.world?.env ?? {}
  if (typeof env !== 'object' || Array.isArray(env) || Object.entries(env).some(([k, v]) => !/^EGDESK_[A-Z_]+$/.test(k) || typeof v !== 'string')) bad('world.env must map EGDESK_* flags to strings')
  // world.budgets 'bridge': the bridge's warm/cold turn_context budgets; absent: the single 800 ms budget of the earlier plans.
  if (raw.world?.budgets !== undefined && raw.world.budgets !== 'bridge') bad('world.budgets must be "bridge" when given')
  // (cycle 16) world.switches: { <name>: { env: { EGDESK_*: value }, default: 'off', owner } }: flags a run turns on with --switch <name>.
  const switches = {}
  for (const [name, sw] of Object.entries(raw.world?.switches ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(name) || sw?.default !== 'off' || !OWNERS.includes(sw.owner) || typeof sw.env !== 'object' || !Object.keys(sw.env).length ||
        Object.entries(sw.env).some(([k, v]) => !/^EGDESK_[A-Z_]+$/.test(k) || typeof v !== 'string')) bad(`world.switches.${name}: needs default "off", an owner and EGDESK_* flags`)
    switches[name] = { env: { ...sw.env }, owner: sw.owner }
  }
  return { set: raw.set, registered: raw.registered, sha256: sha256(bytes), version: Number.isSafeInteger(raw.version) ? raw.version : 1, world: { env: { ...env }, budgets: raw.world?.budgets ?? 'single', switches }, steps }
}

// ---- checks: each judges one expectation from the step's results (and the world, for request bodies that are not written out) ----
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const newMessages = (step, room = null) => step.seen.newMessages.filter(m => room === null || m.room === room)
// args.count 'bodies' (plan v4): only pages whose content was sent; otherwise every page header, as in v1-v3.
const idsOf = (packet, args) => (args?.count === 'bodies' ? packet.bodyIds ?? [] : packet.pageIds)
const sentencesOf = text => String(text ?? '').split(/(?<=[.?!])\s+/).map(x => x.trim()).filter(Boolean)
const CHECKS = {
  // The subjective model's packet in this step: these pages are in it; none whose id starts with an excluded prefix.
  packet: ({ step, args }) => {
    const pages = [...new Set(step.seen.packets.flatMap(p => idsOf(p, args)))]
    const missing = (args.include ?? []).filter(id => !pages.includes(id)), unwanted = pages.filter(id => (args.excludePrefix ?? []).some(prefix => id.startsWith(prefix)))
    return { pass: step.seen.packets.length > 0 && !missing.length && !unwanted.length, observed: { pages, missing, unwanted } }
  },
  // No page body that an earlier step of this room already delivered is delivered again.
  noRepeatedPages: ({ step, results, args }) => {
    const earlier = new Set(results.filter(r => r.seen && r !== step && r.room === step.room && results.indexOf(r) < results.indexOf(step)).flatMap(r => r.seen.packets.flatMap(p => idsOf(p, args))))
    const repeated = [...new Set(step.seen.packets.flatMap(p => idsOf(p, args)))].filter(id => earlier.has(id))
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
  // Every Agent message of the step is the subjective model's own text or its revision, never a fixed system text.
  ownWords: ({ step, args }) => {
    const agent = newMessages(step, step.room).filter(m => m.role === 'assistant' && m.by === 'agent')
    const system = agent.filter(m => m.authored === 'system')
    const packetPages = step.seen.packets.flatMap(p => p.pageIds).length
    return { pass: agent.length > 0 && system.length === 0, observed: { messages: agent.map(m => ({ authored: m.authored, text: m.text })), packetPages, ...(args.note ? { note: args.note } : {}) } }
  },
  // When the previous step's answer in this room was not posted as the Agent wrote it, this step's turn gives the Agent the text the person saw.
  toldWhatWasPosted: ({ step, results, world }) => {
    const index = results.indexOf(step), earlier = results.slice(0, index).filter(r => r.room === step.room && r.seen).at(-1)
    const replaced = earlier ? earlier.seen.newMessages.filter(m => m.role === 'assistant' && m.by === 'agent' && m.authored !== 'own') : []
    if (!replaced.length) return { pass: true, observed: { replacedBefore: [] } }
    const turns = world.native.filter(c => c.step === step.id && c.method === 'turn/start' && !String(c.params.threadId).startsWith('fork-')).map(c => JSON.stringify(c.params))
    const told = replaced.filter(m => turns.some(text => text.includes(JSON.stringify(m.text).slice(1, -1))))
    return { pass: turns.length > 0 && told.length === replaced.length, observed: { replacedBefore: replaced.map(m => m.text), turns: turns.length, told: told.length } }
  },
  // An Agent message that says it will record (or recorded) something is only posted when a reading or a page was written in that step.
  recordClaimBacked: ({ step, results, args }) => {
    const claims = newMessages(step, step.room).filter(m => m.role === 'assistant' && new RegExp(args.claimPattern).test(m.text))
    const index = results.indexOf(step), prior = results.slice(0, index).filter(r => r.seen).at(-1)?.seen.writes ?? { pages: [], readings: [] }
    const added = { pages: step.seen.writes.pages.length - prior.pages.length, readings: step.seen.writes.readings.length - prior.readings.length }
    return { pass: claims.length === 0 || added.pages > 0 || added.readings > 0, observed: { claims: claims.map(m => m.text), added } }
  },
  // When the task needs the person, the note gives the Agent the choices the page offered.
  taskChoices: ({ step, args }) => {
    const note = step.seen.browser.note
    const needs = note && ['ask_user_in_chat', 'tell_user_and_ask_in_chat'].includes(note.next)
    return { pass: Boolean(needs) && (note.candidates?.length ?? 0) >= args.min, observed: { note } }
  },
  // (cycle 15) The needed page reaches the model: its content in this step's packet, or delivered in an earlier step of this conversation
  // (the user's rule: nothing already in the conversation is sent again). Excluded pages are counted by their content in this step.
  packetOrHeld: ({ step, results, args }) => {
    const now = new Set(step.seen.packets.flatMap(p => idsOf(p, args)))
    const earlier = new Set(results.filter(r => r.seen && r.room === step.room && results.indexOf(r) < results.indexOf(step)).flatMap(r => r.seen.packets.flatMap(p => idsOf(p, args))))
    const missing = (args.include ?? []).filter(id => !now.has(id) && !earlier.has(id)), unwanted = [...now].filter(id => (args.excludePrefix ?? []).some(prefix => id.startsWith(prefix)))
    return { pass: step.seen.packets.length > 0 && !missing.length && !unwanted.length, observed: { now: [...now], held: (args.include ?? []).filter(id => !now.has(id) && earlier.has(id)), missing, unwanted } }
  },
  // (cycle 15) Every Agent message of the step ends in words the subjective model wrote (its answer, revision or note): never with a text
  // the system appended, such as a fixed caveat asking the person to supply materials. Sentences of the last paragraph are checked.
  endsInOwnWords: ({ step }) => {
    const agent = newMessages(step, step.room).filter(m => m.role === 'assistant' && m.by === 'agent'), written = step.seen.written ?? []
    const bad = agent.filter(m => !sentencesOf(String(m.text).split(/\n\s*\n/).at(-1)).every(x => written.some(w => w.includes(x))))
    return { pass: bad.length === 0, observed: { messages: agent.length, notTheModels: bad.map(m => m.text) } }
  },
  // (cycle 15) The owner question quotes the answer as the answering model wrote it: its sentences are in the request, and no sentence the
  // draft check appended to the posted answer is.
  quotesOwnAnswer: ({ step, results, args, world }) => {
    const answered = results.find(r => r.id === args.answerStep)
    const posted = (answered?.seen?.newMessages ?? []).filter(m => m.role === 'assistant' && m.by === 'agent').map(m => m.text), written = answered?.seen?.written ?? []
    const own = posted.flatMap(sentencesOf).filter(x => written.some(w => w.includes(x))), appended = posted.flatMap(sentencesOf).filter(x => !written.some(w => w.includes(x)))
    const rows = world.decisionsIn(step.id).filter(d => args.families.includes(d.feature))
    const quoting = rows.filter(d => own.length && own.every(x => d.raw.includes(x)))
    return { pass: quoting.length > 0 && rows.every(d => appended.every(x => !d.raw.includes(x))), observed: { requests: rows.length, quotingOwn: quoting.length, appendedSentences: appended } }
  },
  // (cycle 13) A logged judgment of this step (calibration word, not a question name): measured, and within bounds when bounds are given.
  calibrationValue: ({ step, args }) => {
    const found = step.seen.calibration.filter(e => e.feature === args.feature).flatMap(e => e.judgments ?? []).find(x => x.q === args.q)
    const p = found?.p ?? null
    return { pass: p !== null && (args.min === undefined || p >= args.min) && (args.max === undefined || p <= args.max), observed: { [args.q]: p } }
  },
  // (cycle 13) One Agent message of the step names every one of these words.
  messageMentions: ({ step, args }) => {
    const agent = newMessages(step, step.room).filter(m => m.role === 'assistant' && m.by === 'agent')
    return { pass: agent.some(m => args.needles.every(n => m.text.includes(n))), observed: { messages: agent.map(m => m.text) } }
  },
  // (cycle 13) The board's cards: at least min of them, and (only) cards whose title has this word.
  boardCards: ({ step, args }) => {
    const cards = step.seen.board.cards.map(c => c.title ?? ''), matching = cards.filter(title => title.includes(args.titleIncludes))
    return { pass: matching.length >= args.min && (args.onlyMatching !== true || matching.length === cards.length), observed: { cards } }
  },
  // (cycle 13) The system's flow message of the step: how many, and that it says what it must and nothing it must not.
  flowText: ({ step, args }) => {
    const shown = newMessages(step).filter(m => m.by === 'system_flow')
    const ok = shown.length === (args.equals ?? 1) && shown.every(m => (args.mustInclude ?? []).every(n => m.text.includes(n)) && !(args.mustNot ?? []).some(n => m.text.includes(n)))
    return { pass: ok, observed: { shown: shown.map(m => m.text) } }
  },
  // (cycle 13) Some Decision request of this step (of these families) carries every one of these words (checked on the exact bodies).
  sentIn: ({ step, args, world }) => {
    const rows = world.decisionsIn(step.id).filter(d => !args.families || args.families.includes(d.feature))
    return { pass: rows.some(d => args.needles.every(n => d.raw.includes(n))), observed: { requests: rows.length, withIt: rows.filter(d => args.needles.every(n => d.raw.includes(n))).length } }
  },
  // (cycle 13) The answering turn of this step carried this context block (by its key).
  contextKey: ({ step, args }) => ({ pass: step.seen.packets.some(p => p.keys.includes(args.key)), observed: { keys: step.seen.packets.map(p => p.keys) } }),
  placementRecorded: ({ step }) => ({ pass: step.seen.placement.records.length >= 1, observed: { records: step.seen.placement.records, submitted: step.seen.placement.submitted } }),
}
export const CHECK_NAMES = Object.freeze(Object.keys(CHECKS))
// The check functions themselves (read-only), for tests that judge hand-made results.
export const CHECK_FUNCTIONS = Object.freeze({ ...CHECKS })

// ---- what the person sees after a step ----
const PAGE_ID = /\[(?:page|item) id=([^\s\]]+)/g
// (cycle 15) A page header followed by its content is a BODY; a header that says the content is not re-sent (or is followed by another
// header, or by the "content not repeated here" line) is a REFERENCE to a page the model already holds. pageIds counts both, as before.
const HEADER = /^\[(?:page|item) id=([^\s\]]+)([^\]]*)\]/
export function packetPages(value) {
  const lines = String(value ?? '').split('\n'), bodies = [], refs = []
  lines.forEach((line, i) => {
    const m = HEADER.exec(line.trim())
    if (!m) return
    const next = lines.slice(i + 1).find(x => x.trim())?.trim() ?? ''
    const ref = /content not re-sent|already delivered/.test(m[2]) || !next || HEADER.test(next) || next.startsWith('[content not repeated here')
    ;(ref ? refs : bodies).push(m[1])
  })
  return { bodies, refs }
}
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
  const conversation = {}, newOnes = [], forkTexts = w.forkPrompts.slice(before.forks).map(p => p.text).filter(text => typeof text === 'string')
  for (const room of [DM, BROWSER_ROOM]) {
    const list = roomMessages(w, room).map(m => ({ role: m.role, text: m.text, by: m.role === 'assistant' ? (/^egdesk-flow:/.test(m.messageId ?? '') ? 'system_flow' : 'agent') : 'person' }))
    if (list.length) conversation[room] = list
    // Who wrote a new assistant message: the subjective model's own answer ('own'), its revision or short note on a fork ('model'), or
    // neither: a fixed text of the system ('system').
    newOnes.push(...list.slice(before.rooms[room]).map(m => ({ room, ...m, ...(m.role === 'assistant' ? { authored: j.said.includes(m.text) ? 'own' : forkTexts.includes(m.text) ? 'model' : 'system' } : {}) })))
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
    conversation, newMessages: newOnes, written: [...j.said, ...forkTexts],
    flows: w.calibrationLog.entries().slice(before.calibration).filter(e => e.feature === 'conversation_flow' && Object.hasOwn(e, 'flow')).map(e => ({ flow: e.flow, posted: e.posted ?? null })),
    activityRows: w.activityRowsIn(id),
    packets: w.native.filter(c => c.step === id && c.method === 'turn/start' && !String(c.params.threadId).startsWith('fork-')).map(c => {
      const ctx = c.params.additionalContext ?? {}
      const parsed = Object.values(ctx).map(v => packetPages(v?.value))
      return { keys: Object.keys(ctx), pageIds: [...new Set(Object.values(ctx).flatMap(v => [...String(v?.value ?? '').matchAll(PAGE_ID)].map(m => m[1])))],
        bodyIds: [...new Set(parsed.flatMap(p => p.bodies))], refIds: [...new Set(parsed.flatMap(p => p.refs))] }
    }),
    engineTurns: w.subjectiveTurnsIn(id),
    runs,
    board: { observe: j.note.briefing && id === 's3-briefing' ? j.note.briefing : null, published: stepEvents.filter(e => e.event === 'briefing.published').length,
      cards: stepEvents.filter(e => e.event === 'output.published').map(e => ({ title: e.details?.output?.title ?? null, zone: 'board' })), parts },
    placement: { submitted: /^s[78]b?-/.test(id) ? j.note.ownerRequest ?? null : null, cards: /^s[78]b?-/.test(id) ? j.note.cards ?? [] : [],
      records: w.workPlacement.records().slice(before.records).map(r => ({ kind: r.kind, surface: r.surface, source: r.source, would: r.would })), facts: w.workPlacement.facts(DM) },
    browser: { note: note ? { status: note.status, next: note.next, code: note.code ?? null, candidates: note.candidates ?? [], stepsDone: note.stepsDone ?? null } : null,
      acts: w.acts.slice(before.acts).map(a => ({ type: a.type, url: a.url })) },
    writes: readWrites(w),
    calibration: w.calibrationLog.entries().slice(before.calibration).map(e => ({ feature: e.feature, mode: e.mode, ...(e.flow !== undefined ? { flow: e.flow } : {}), ...(e.fallback ? { fallback: e.fallback } : {}),
      // (cycle 13) the entry's judgments by their logged word and probability, so values such as the memory triage are measured per step
      judgments: (Array.isArray(e.judgments) ? e.judgments : []).filter(x => typeof x?.q === 'string' && Number.isFinite(x.p)).map(x => ({ q: x.q, p: x.p })) })),
  }
}
const requestRow = d => ({ ...(d.replay ? { replay: d.replay } : {}), family: d.feature, caller: d.caller, origin: d.origin, sha256: d.sha256, bytes: d.bytes, questions: d.names, estInputTokens: d.estInputTokens ?? null,
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
export function createMeasureTransport({ send = false, key = null, fetchImpl = globalThis.fetch, caps, plan, now = null, scripted = scriptedDecisions(), replay = null } = {}) {
  const ledger = { requests: 0, sent: 0, tokens: 0, reportedTokens: 0, byStep: {}, stopped: null, refusedBodies: 0, onWire: 0, replayUnmatched: 0, replayChangedBody: 0 }
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
      // Replay: the answer the provider gave to the same request (same step, family and question names, in order) in an earlier run.
      // A request that run did not make is answered by the script and marked, so a replay shows where the code now asks something else.
      const recorded = replay ? replay.take(step, row.feature, wire.questions.map(q => q.name)) : null
      // The same request in name only: when the body differs (other evidence, other wording) the recorded answer was given to another body.
      if (replay) { row.replay = !recorded ? 'unmatched' : recorded.sha256 === row.sha256 ? 'recorded' : 'recorded_changed_body'; if (!recorded) ledger.replayUnmatched++; else if (row.replay !== 'recorded') ledger.replayChangedBody++ }
      return { status: 200, json: { answers: recorded?.answers ?? await scripted.answer(wire), usage: { input_tokens: recorded?.usage?.input_tokens ?? est } } }
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
// env: developer flags that differ from the journey's (tests and offline replays only; the CLI passes none).
export async function runJourney({ plan, send = false, key = null, fetchImpl = globalThis.fetch, caps = DEFAULT_CAPS, now = null, replay = null, env = {}, switches = [] } = {}) {
  const unknownSwitch = switches.find(name => !Object.hasOwn(plan.world?.switches ?? {}, name))
  if (unknownSwitch) throw new PlanError(`the plan has no switch ${unknownSwitch}`)
  const switchEnv = Object.assign({}, ...switches.map(name => plan.world.switches[name].env))
  const cleanups = [], t = { after: fn => cleanups.push(fn) }
  const { transport, ledger } = createMeasureTransport({ send, key, fetchImpl, caps, plan, now, replay: send === true ? null : replay })
  const steps = []
  try {
    // The plan's world flags, then any the caller adds.
    const w = allOnWorld(t, { transport, settleLimitMs: 60_000, env: { ...(plan.world?.env ?? {}), ...switchEnv, ...env }, budgets: plan.world?.budgets ?? 'single' })
    w.state.wording.wait = waitNote; w.state.wording.pointer = pointerNote
    await w.settings.turnMemory.save('on')
    const j = { note: {}, sends: [], said: [],
      async say(text, extra) {
        try { const out = await w.send(text, extra); j.sends.push({ inRun: out.inRun === true, accepted: out.accepted !== false, runId: out.runId ?? null }) }
        catch (error) { j.sends.push({ refused: typeof error?.code === 'string' ? error.code : 'error', status: error?.httpStatus ?? null }) }
        await w.idle()
      },
      async pause() { await new Promise(resolve => setTimeout(resolve, 60)); await w.idle() } }
    for (const def of STEPS.filter(def => plan.steps.some(step => step.id === def.id))) {
      if (ledger.stopped) { steps.push({ id: def.id, room: def.room, title: def.title, state: 'not_run' }); continue }
      w.step(def.id); j.sends = []; j.said = []
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
        if (e.when && !switches.includes(e.when.switch)) return { ...base, when: e.when, pass: null, state: 'switch_off' }
        try { return { ...base, ...CHECKS[e.check]({ step, args: e.args, results: steps, world: w }) } } catch { return { ...base, pass: false, state: 'check_failed' } }
      })
    }
  } finally { for (const fn of cleanups.reverse()) { try { fn() } catch { /* cleanup */ } } }
  const checks = steps.flatMap(s => s.checks ?? [])
  const scorecard = { hard: { passed: checks.filter(c => c.severity === 'hard' && c.pass === true).length, failed: checks.filter(c => c.severity === 'hard' && c.pass === false).map(c => c.id), notRun: checks.filter(c => c.severity === 'hard' && c.pass === null).length },
    soft: { passed: checks.filter(c => c.severity === 'soft' && c.pass === true).length, missed: checks.filter(c => c.severity === 'soft' && c.pass === false).map(c => c.id), notRun: checks.filter(c => c.severity === 'soft' && c.pass === null).length } }
  return { steps, ledger, scorecard, switches: [...switches] }
}

// ---- replay and diff against an earlier results file ----
/** replayAnswers(results) -> { take(step, family, names) -> { answers, usage } | null }: the recorded answers of a results file, consumed in order. */
export function replayAnswers(results) {
  const queues = new Map(), keyOf = (step, family, names) => [step, family, names.join(',')].join('\u0000')
  for (const step of Array.isArray(results?.steps) ? results.steps : []) for (const row of Array.isArray(step.requests) ? step.requests : []) {
    if (row.status !== 200 || !Array.isArray(row.answers) || !Array.isArray(row.questions)) continue
    const key = keyOf(step.id, row.family, row.questions)
    if (!queues.has(key)) queues.set(key, [])
    queues.get(key).push({ answers: row.answers, usage: row.usage ?? null, sha256: row.sha256 ?? null })
  }
  return { take: (step, family, names) => queues.get(keyOf(step, family, names))?.shift() ?? null }
}
const round = n => Math.round(n * 100) / 100
const answerMap = answers => Object.fromEntries((Array.isArray(answers) ? answers : []).filter(a => a && typeof a.name === 'string').map(a =>
  [a.name, a.type === 'predicate' ? { p: a.probability } : a.type === 'choice' ? { v: a.choice, c: a.confidence } : { other: a.type ?? 'missing' }]))
const sameAnswer = (a, b) => (a && b && a.p !== undefined && b.p !== undefined ? Math.abs(a.p - b.p) < 0.05
  : a && b && a.v !== undefined && b.v !== undefined ? a.v === b.v && Math.abs((a.c ?? 0) - (b.c ?? 0)) < 0.05 : JSON.stringify(a ?? null) === JSON.stringify(b ?? null))
const answerWord = a => (!a ? '-' : a.p !== undefined ? String(round(a.p)) : a.v !== undefined ? `${a.v}@${round(a.c ?? 0)}` : a.other)
const sawList = step => (step?.seen?.newMessages ?? []).map(m => `${m.by}${m.authored ? `(${m.authored})` : ''}: ${m.text}`)
/**
 * diffJourneys(previous, current) -> { previous, current, scorecard, steps: [{ step, state, changes: [...] }] }
 * changes: requests per family, answers (paired by family and order in the step; a predicate moves by 0.05 or more, a choice changes value
 * or confidence by 0.05 or more), what the person saw (new messages, flow messages, board, browser task, writes), expectations (pass ->
 * fail, fail -> pass, new in this plan).
 */
export function diffJourneys(previous, current) {
  const head = run => ({ at: run?.at ?? null, mode: run?.mode ?? null, plan: run?.plan?.sha256 ?? null })
  const fam = list => (list ?? []).reduce((m, row) => (m[row.family] = (m[row.family] || 0) + 1, m), {})
  const group = list => { const m = new Map(); for (const row of list ?? []) { if (!m.has(row.family)) m.set(row.family, []); m.get(row.family).push(row) } return m }
  const steps = current.steps.map(cur => {
    const prev = (previous?.steps ?? []).find(step => step.id === cur.id) ?? null, changes = []
    // In a replay, a request the earlier run did not make was answered by the script, and one whose body changed got an answer given to
    // another body: both are named, and a scripted answer is not compared with a real one.
    const scripted = (cur.requests ?? []).filter(row => row.replay === 'unmatched'), reused = (cur.requests ?? []).filter(row => row.replay === 'recorded_changed_body')
    const replayed = scripted.length || reused.length ? [{ kind: 'replay', scripted: scripted.map(row => row.family), changedBody: reused.map(row => row.family) }] : []
    // A step the earlier run did not have (added by a later plan): its requests and expectations are new, nothing in it is a change.
    if (!prev) return { step: cur.id, state: cur.state, added: true, changes: [{ kind: 'new_step', requests: fam(cur.requests) }, ...replayed,
      ...(cur.checks ?? []).map(c => ({ kind: 'expectation', id: c.id, severity: c.severity, owner: c.owner, prev: 'new', cur: c.pass }))] }
    changes.push(...replayed)
    const pf = fam(prev?.requests), cf = fam(cur.requests)
    for (const family of [...new Set([...Object.keys(pf), ...Object.keys(cf)])]) if ((pf[family] ?? 0) !== (cf[family] ?? 0)) changes.push({ kind: 'requests', family, prev: pf[family] ?? 0, cur: cf[family] ?? 0 })
    const pm = group(prev?.requests)
    for (const [family, list] of group(cur.requests)) list.forEach((row, i) => {
      const before = pm.get(family)?.[i]
      if (!before || row.replay === 'unmatched') return
      const a = answerMap(before.answers), b = answerMap(row.answers)
      for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])]) if (!sameAnswer(a[name], b[name])) changes.push({ kind: 'answer', family, index: i + 1, name, prev: answerWord(a[name]), cur: answerWord(b[name]) })
    })
    const ps = sawList(prev), cs = sawList(cur)
    const strip = list => list.map(line => line.replace(/^(\w+)\(\w+\): /, '$1: '))
    if (JSON.stringify(strip(ps)) !== JSON.stringify(strip(cs))) changes.push({ kind: 'saw', prev: ps, cur: cs })
    const flows = step => (step?.seen?.flows ?? []).map(f => `${f.flow}:${f.posted}`)
    if (JSON.stringify(flows(prev)) !== JSON.stringify(flows(cur))) changes.push({ kind: 'flows', prev: flows(prev), cur: flows(cur) })
    const board = step => (step?.seen?.board?.observe ? `${step.seen.board.observe.outcome ?? step.seen.board.observe.status} cards=${step.seen.board.cards.length} parts=${step.seen.board.parts.map(p => p.shows).join('+') || '-'}` : null)
    if (board(prev) !== board(cur)) changes.push({ kind: 'board', prev: board(prev), cur: board(cur) })
    const task = step => (step?.seen?.browser?.note ? `${step.seen.browser.note.status}/${step.seen.browser.note.next} candidates=${step.seen.browser.note.candidates?.length ?? 0} opened=${step.seen.browser.acts.map(a => a.url).join(' ') || '-'}` : null)
    if (task(prev) !== task(cur)) changes.push({ kind: 'browser', prev: task(prev), cur: task(cur) })
    const writes = step => (step?.seen?.writes ? `pages=${step.seen.writes.pages.length} readings=${step.seen.writes.readings.length}` : null)
    if (writes(prev) !== writes(cur)) changes.push({ kind: 'writes', prev: writes(prev), cur: writes(cur) })
    const was = new Map((prev?.checks ?? []).map(c => [c.id, c.pass]))
    for (const c of cur.checks ?? []) {
      const before = was.has(c.id) ? was.get(c.id) : 'new'
      if (before !== c.pass) changes.push({ kind: 'expectation', id: c.id, severity: c.severity, owner: c.owner, prev: before, cur: c.pass })
    }
    return { step: cur.id, state: prev?.state === cur.state ? cur.state : `${prev?.state ?? 'absent'} -> ${cur.state}`, changes }
  })
  const card = run => (run?.scorecard ? { hard: `${run.scorecard.hard.passed}/${run.scorecard.hard.passed + run.scorecard.hard.failed.length + run.scorecard.hard.notRun}`,
    soft: `${run.scorecard.soft.passed}/${run.scorecard.soft.passed + run.scorecard.soft.missed.length + run.scorecard.soft.notRun}` } : null)
  return { previous: head(previous), current: head(current), scorecard: { prev: card(previous), cur: card(current) }, steps }
}
const passWord = value => (value === true ? 'pass' : value === false ? 'fail' : value === null ? 'not run' : value)
export function formatDiff(diff) {
  const lines = [`journey diff: ${diff.previous.at} (${diff.previous.mode}, plan ${String(diff.previous.plan).slice(0, 12)}) -> ${diff.current.at} (${diff.current.mode}, plan ${String(diff.current.plan).slice(0, 12)})`,
    `hard ${diff.scorecard.prev?.hard ?? '-'} -> ${diff.scorecard.cur?.hard ?? '-'}, soft ${diff.scorecard.prev?.soft ?? '-'} -> ${diff.scorecard.cur?.soft ?? '-'}`]
  const marked = diff.steps.filter(step => step.changes.some(c => c.kind === 'replay')).map(step => step.step)
  if (marked.length) lines.push(`replay: steps with scripted answers or answers reused for a changed body (their outcomes are not model results; re-run with --send): ${marked.join(', ')}`)
  for (const step of diff.steps) {
    lines.push(`== ${step.step} [${step.added ? `new in this plan, ${step.state}` : step.state}]${step.changes.length ? '' : ' no change'}`)
    const replayNote = step.changes.some(c => c.kind === 'replay')
    for (const c of step.changes) {
      if (c.kind === 'requests') lines.push(`  requests     ${c.family} ${c.prev} -> ${c.cur}`)
      else if (c.kind === 'answer') lines.push(`  answer       ${c.family}#${c.index} ${c.name}: ${c.prev} -> ${c.cur}`)
      else if (c.kind === 'saw') { lines.push('  person saw   before:'); for (const line of c.prev) lines.push(`                 ${line}`); lines.push('               now:'); for (const line of c.cur) lines.push(`                 ${line}`) }
      else if (c.kind === 'expectation') lines.push(`  expectation  ${c.id} (${c.severity}, ${c.owner}): ${passWord(c.prev)} -> ${passWord(c.cur)}${replayNote ? ' [not a model result: see replay above]' : ''}`)
      else if (c.kind === 'new_step') lines.push(`  new step     not in the earlier run; requests ${Object.entries(c.requests).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
      else if (c.kind === 'replay') lines.push(`  replay       ${c.scripted.length ? `no recorded answer, scripted: ${c.scripted.join(', ')}` : ''}${c.scripted.length && c.changedBody.length ? '; ' : ''}${c.changedBody.length ? `recorded answer reused for a changed body: ${c.changedBody.join(', ')}` : ''}`)
      else lines.push(`  ${c.kind.padEnd(12)} ${JSON.stringify(c.prev)} -> ${JSON.stringify(c.cur)}`)
    }
  }
  return lines
}

// ---- output ----
const familyCounts = requests => requests.reduce((m, r) => (m[r.family] = (m[r.family] || 0) + 1, m), {})
export function stepTable(outcome) {
  return outcome.steps.map(s => ({ step: s.id, state: s.state, requests: s.requests?.length ?? 0, families: s.requests ? familyCounts(s.requests) : {},
    estInputTokens: (s.requests ?? []).reduce((n, r) => n + (r.estInputTokens ?? 0), 0), ...(s.requests?.some(r => r.refused) ? { refused: s.requests.filter(r => r.refused).map(r => r.refused) } : {}) }))
}
export function resultsPayload({ outcome, plan, send, caps, replayOf = null, at = new Date() }) {
  return { set: plan.set, mode: send ? 'send' : replayOf ? 'replay' : 'dry_run', at: at.toISOString(), endpoint: DECISIONS_ENDPOINT, automaticRetries: 0,
    ...(replayOf ? { replayOf } : {}),
    plan: { file: path.basename(PLAN_FILE), sha256: plan.sha256, registered: plan.registered },
    world: { env: plan.world?.env ?? {}, budgets: plan.world?.budgets ?? 'single', switchesOn: outcome.switches ?? [] }, script: { sha256: sha256(readFileSync(SCRIPT_FILE)) },
    caps: { tokenCeiling: caps.tokenCeiling, maxRequests: caps.maxRequests, perStep: Object.fromEntries(plan.steps.map(s => [s.id, s.caps])) },
    totals: { requests: outcome.ledger.requests, sent: outcome.ledger.sent, inputTokensCounted: outcome.ledger.tokens, inputTokensReported: outcome.ledger.reportedTokens, refusedBodies: outcome.ledger.refusedBodies, ...(replayOf ? { replayUnmatched: outcome.ledger.replayUnmatched, replayChangedBody: outcome.ledger.replayChangedBody } : {}) },
    stoppedBecause: outcome.ledger.stopped?.reason ?? null, stoppedAt: outcome.ledger.stopped?.step ?? null,
    scorecard: outcome.scorecard, steps: outcome.steps }
}
export function writeJourneyResults(file, payload) {
  writeFileSync(file, JSON.stringify(payload, null, 1), { mode: 0o600 })
  chmodSync(file, 0o600)
}

const plausibleKey = key => typeof key === 'string' && key.length >= 20 && !/\s/.test(key)
export async function main(argv, { env = {}, fetchImpl = globalThis.fetch, print = line => console.log(line), printError = line => console.error(line), now = null } = {}) {
  const args = [...argv], valued = new Set(['--out', '--plan', '--token-ceiling', '--max-requests', '--replay', '--diff', '--rerun', '--switch']), known = new Set([...valued, '--send'])
  const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
  const unknown = args.find((arg, i) => !known.has(arg) && !valued.has(args[i - 1]))
  const int = (name, fallback, max) => { const v = valueOf(name); if (v === null) return fallback; const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n <= max ? n : NaN }
  const caps = { tokenCeiling: int('--token-ceiling', DEFAULT_CAPS.tokenCeiling, LIMITS.tokenCeilingMax), maxRequests: int('--max-requests', DEFAULT_CAPS.maxRequests, LIMITS.maxRequestsMax) }
  if (unknown || [...valued].some(name => args.includes(name) && !valueOf(name)) || Number.isNaN(caps.tokenCeiling) || Number.isNaN(caps.maxRequests)) {
    printError('usage: egdesk-all-on-live-measure.mjs [--send] [--out results.json] [--plan plan.json] [--token-ceiling n<=200000] [--max-requests n<=200] [--replay earlier.json] [--diff earlier.json] [--rerun earlier.json]   (dry run unless --send; the key is read from OPENAI_API_KEY only)')
    return EXIT.usage
  }
  // --rerun <earlier>: the latest plan, a diff against that file, and (without --send) its recorded answers. One command for a re-run.
  const rerun = valueOf('--rerun')
  const replayFile = valueOf('--replay') ?? (rerun && !args.includes('--send') ? rerun : null), diffFile = valueOf('--diff') ?? rerun
  if (replayFile && args.includes('--send')) { printError('--replay and --send exclude each other (a replay sends nothing)'); return EXIT.usage }
  const readRun = file => { try { const bytes = readFileSync(file); const run = JSON.parse(bytes.toString('utf8')); return Array.isArray(run?.steps) ? { run, sha256: sha256(bytes), file: path.basename(file) } : null } catch { return null } }
  const replayRun = replayFile ? readRun(replayFile) : null, diffRun = diffFile ? readRun(diffFile) : null
  if ((replayFile && !replayRun) || (diffFile && !diffRun)) { printError('the earlier results file cannot be read'); return EXIT.usage }
  let plan
  try { plan = loadJourneyPlan(valueOf('--plan') ?? (rerun ? LATEST_PLAN_FILE : PLAN_FILE)) } catch (error) { printError(error?.name === 'PlanError' ? `plan refused: ${error.message}` : 'plan refused'); return EXIT.usage }
  const send = args.includes('--send')
  const key = send ? env.OPENAI_API_KEY ?? null : null
  if (send && !plausibleKey(key)) { printError('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); return EXIT.noKey }
  print(JSON.stringify({ set: plan.set, mode: send ? 'send' : replayRun ? 'replay' : 'dry_run', endpoint: DECISIONS_ENDPOINT, plan: plan.sha256.slice(0, 16), registered: plan.registered, tokenCeiling: caps.tokenCeiling, maxRequests: caps.maxRequests,
    ...(send ? {} : replayRun ? { note: `replay: the answers recorded in ${replayRun.file} drive the journey; nothing is sent` } : { note: 'dry run: the scripted Decision answers drive the journey; real answers may change which requests follow' }) }))
  const switches = args.flatMap((arg, i) => (arg === '--switch' ? [args[i + 1]] : []))
  const unknownSwitch = switches.find(name => !Object.hasOwn(plan.world?.switches ?? {}, name))
  if (unknownSwitch) { printError(`the plan has no switch ${unknownSwitch} (it has: ${Object.keys(plan.world?.switches ?? {}).join(', ') || 'none'})`); return EXIT.usage }
  const outcome = await runJourney({ plan, send, key, fetchImpl: send ? stampingFetch(fetchImpl, { file: sendStampPath(env), runner: `all-on-live-measure ${plan.set}` }) : fetchImpl, caps, now, replay: replayRun ? replayAnswers(replayRun.run) : null, switches })
  for (const row of stepTable(outcome)) print(JSON.stringify(row))
  const payload = resultsPayload({ outcome, plan, send, caps, replayOf: replayRun ? { file: replayRun.file, sha256: replayRun.sha256, at: replayRun.run.at ?? null } : null })
  if (diffRun) { payload.diffAgainst = { file: diffRun.file, sha256: diffRun.sha256, at: diffRun.run.at ?? null }; payload.diff = diffJourneys(diffRun.run, payload) }
  print(JSON.stringify({ requests: payload.totals.requests, sent: payload.totals.sent, inputTokens: payload.totals.inputTokensCounted, stoppedBecause: payload.stoppedBecause, stoppedAt: payload.stoppedAt,
    hardPassed: payload.scorecard.hard.passed, hardFailed: payload.scorecard.hard.failed, softMissed: payload.scorecard.soft.missed }))
  if (payload.diff) for (const line of formatDiff(payload.diff)) print(line)
  const out = valueOf('--out')
  if (out) writeJourneyResults(out, payload)
  return payload.stoppedBecause ? EXIT.stopped : EXIT.ok
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2), { env: process.env })
