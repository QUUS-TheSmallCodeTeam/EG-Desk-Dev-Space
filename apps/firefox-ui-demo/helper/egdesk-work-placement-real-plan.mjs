import { createHash } from 'node:crypto'
import { createDecisionClient, DECISION_MODEL } from './egdesk-decision-client.mjs'
import { createEgressGate, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { createHeartbeat } from './egdesk-heartbeat.mjs'
import { PLACEMENT_PREDICATE_YES, createWorkPlacement } from './egdesk-work-placement.mjs'
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'

// REAL-MEASUREMENT PLAN for work placement v2 (L1 cycle 12), in the declarative format of the generic runner (helper/egdesk-decision-real-runner.mjs).
// v1 (lane L4, sent 2026-11-24): one choice among option aliases described by closed words: 3/6, picks flat at 0.2-0.5 and the code's default was
// already the right answer. v2 asks only what code cannot know, as yes/no predicates on real content, each item quoted on its own:
//   same_matter_R#  "is the work for the quoted request about the same matter as this card?"  (to place the surface beside a related card)
//   owner_action    "does this finished result need the owner to do something?"              (whom the pointer is for)
// Nothing here sends anything. The PRODUCT CODE builds every body: the canvas runtime enumerates the scene and builds the request, the bridge's judge
// half queues it on a real heartbeat (virtual clock) and builds the Decision request, the real Decisions client serializes it; its fetch is a recorder
// that keeps the exact bytes and answers with the pre-registered expectation. Data: synthetic Korean work requests and card texts.
// v3 (L1 cycle 13): v2 measured every card of a request alike (1/1/1, .03/.03/.03): the questions were identical and the cards lived only in the shared
// input. v3 bodies carry each card inside its own question (isolation 'question'); isolation 'request' (one card per request) is built for comparison.
export const PLACEMENT_SET = 'work-placement-predicates-v3'
export const PLACEMENT_TOKEN_CEILING = 5000
export const PLACEMENT_PLAN_DIR = 'proofs/decision-real-measure/work-placement'
export const BELOW_YES = Math.round((PLACEMENT_PREDICATE_YES - 0.001) * 1000) / 1000 // "max" is inclusive in the runner: just under the bar

const r = (x, y, width, height) => ({ x, y, width, height })
const OWNER_VIEW = r(0, 0, 1200, 800), MEMBER_VIEW = r(4000, 0, 1200, 800)
// Cards near the member's side whose words the host may send (published result cards); the order is the runtime's (nearest first).
const card = (id, x, y, label, excerpt) => ({ id, rect: r(x, y, 400, 300), kind: 'result', creator: 'agent', maySend: true, label, excerpt })

// kind: yes | no | near_miss. yes and no are hard; near_miss (same company or same kind of document, another matter) is soft.
export const SCENES = Object.freeze([
  { id: 'pl-same-matter-quote', request: 'A사 견적서 v2를 검토하고 v1과 달라진 점을 정리해 주세요', cards: [
    ['yes', card('c-quote-v1', 5400, 950, 'A사 견적서 v1 단가표', 'A사 견적서 v1: 품목 3종, 단가 12,000원, 수량 40개, 납기 3주.'), 'the earlier version of the same quote'],
    ['no', card('c-lunch', 5400, -700, '점심 메뉴 투표 결과', '이번 주 점심은 김치찌개로 정해졌습니다. 다음 투표는 금요일입니다.'), 'another matter altogether'],
    ['near_miss', card('c-contract-b', 3300, 950, 'B사 계약 조항 메모', 'B사 공급 계약 제7조 지체상금 조항 검토 메모입니다.'), 'another client\'s document'],
  ] },
  { id: 'pl-same-matter-report', request: 'C사 4분기 매출 보고서 초안을 작성해 주세요', cards: [
    ['near_miss', card('c-hiring-c', 5400, 950, 'C사 채용 공고 초안', 'C사 영업팀 경력직 채용 공고 초안입니다. 마감은 12월 15일입니다.'), 'same company, another matter'],
    ['yes', card('c-sales-c', 5400, -700, 'C사 4분기 매출 집계표', 'C사 4분기 월별 매출: 10월 3.2억, 11월 2.9억, 12월 추정 3.5억.'), 'the figures for that report'],
    ['near_miss', card('c-report-d', 3300, 950, 'D사 4분기 매출 보고서', 'D사 4분기 매출 보고서 최종본입니다. 전년 대비 8% 성장.'), 'the same kind of report, another company'],
  ] },
])
export const RESULTS = Object.freeze([
  { id: 'pl-owner-approval', kind: 'yes', request: '배포 스크립트를 점검하고 문제가 있으면 알려 주세요', answer: '점검을 마쳤습니다. 스크립트에 운영 DB 마이그레이션이 포함되어 있어, 실행 전에 승인해 주셔야 진행할 수 있습니다.', note: 'needs an approval' },
  { id: 'pl-owner-choice', kind: 'yes', request: '새 로고 시안 두 가지를 만들어 주세요', answer: '시안 A(파란 계열)와 시안 B(녹색 계열)를 만들었습니다. 어느 쪽으로 진행할지 정해 주시면 세부 작업을 이어 가겠습니다.', note: 'needs a choice' },
  { id: 'pl-owner-info', kind: 'no', request: '어제 회의록을 요약해 주세요', answer: '회의록을 세 문단으로 요약했습니다. 결정 사항은 예산 동결이고, 다음 회의는 12월 3일입니다.', note: 'information only' },
  { id: 'pl-owner-done', kind: 'no', request: '제안서의 오타를 고쳐 주세요', answer: '제안서의 오타 네 군데를 고쳤습니다. 수정본은 같은 파일에 저장되어 있고 추가로 하실 일은 없습니다.', note: 'done, nothing to do' },
])

export const estimatePlacementTokens = (predicates, bytes) => Math.round(134.8 * predicates + 0.1983 * bytes) // the runner's typed model (2026-11-24)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function beating() {
  let clock = 0; const timers = []
  const hb = createHeartbeat({ key: 'plan', monotonicNow: () => clock, setTimer: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t }, clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) } })
  hb.start()
  return { hb, now: () => clock, beat() { timers.sort((a, b) => a.at - b.at); const t = timers.shift(); if (t) { clock = Math.max(clock, t.at); t.fn() } } }
}

/**
 * placementPlanRequests({ isolation, scenes, results }) -> [{ id, file, bytes, body, url, outcome, expect }] as the product builds and sends them.
 * isolation 'request': one request per card, ids <scene>-R#.
 */
export async function placementPlanRequests({ isolation = 'question', scenes = SCENES, results = RESULTS } = {}) {
  const wire = []
  let forced = null
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0001', fetchImpl: async (url, init) => {
    wire.push({ url: String(url), bytes: Buffer.from(init.body, 'utf8') })
    const body = JSON.parse(init.body)
    return Response.json({ model: DECISION_MODEL, answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: forced(q.name) === 'yes' ? 0.95 : 0.05 })) })
  } })
  const gate = createEgressGate(modelDataPermissions({ runActive: true, canvasMaySend: true }))
  const requests = []
  const run = async (id, dto, context, expect) => {
    const b = beating()
    const placement = createWorkPlacement({ client, mode: () => 'advisory', enabled: () => true, isolation, contextFor: () => ({ ...context, egress: gate }), now: b.now, setTimer: () => null })
    const before = wire.length
    const s = placement.submit('plan', dto, b.hb)
    if (s.status !== 'queued') throw new Error(`${id}: the product did not queue the scene (${s.status})`)
    b.beat(); await placement.idle()
    const sent = wire.slice(before)
    if (!sent.length) throw new Error(`${id}: the product built no Decision request`)
    const outcome = placement.result('plan', s.id)
    for (const w of sent) {
      const body = JSON.parse(w.bytes.toString('utf8')), names = body.questions.map(q => q.name)
      const rid = sent.length === 1 ? id : `${id}-${names[0].replace('same_matter_', '')}`
      requests.push({ id: rid, file: `requests/${rid}.json`, bytes: w.bytes, body, url: w.url, outcome, expect: expect.filter(e => names.includes(e.name)) })
    }
  }
  for (const scene of scenes) {
    // the owner at A; the member who asked waits and is working at B; the cards are on the member's side
    const presence = [{ member: 'acct-owner', self: true, active: true, viewport: OWNER_VIEW, focusCard: null, lastInputAgeMs: 400 }, { member: 'acct-member', self: false, active: true, viewport: MEMBER_VIEW, focusCard: null, lastInputAgeMs: 900 }]
    const ws = WP.enumerateWorkScene({ presence, cards: scene.cards.map(row => row[1]), tasks: [{ id: 'task', state: 'running', requester: 'acct-member', waiting: ['acct-member'], ownerMustAct: false, surfaces: [] }] })
    const req = WP.placementRequest(ws, { taskId: 'task', surface: { kind: 'file', size: { width: 720, height: 520 } } })
    if (!req || req.dto.related.length !== scene.cards.length) throw new Error(`${scene.id}: every card should be a related candidate`)
    const kindOf = alias => scene.cards.find(row => row[1].id === req.plan.related.find(x => x.alias === alias).cardId)
    forced = name => kindOf(name.replace('same_matter_', ''))[0]
    await run(scene.id, req.dto, { request: scene.request, answer: '' },
      req.plan.related.map(x => { const [kind, , note] = kindOf(x.alias); return { name: `same_matter_${x.alias}`, kind: 'predicate', ...(kind === 'yes' ? { min: PLACEMENT_PREDICATE_YES } : { max: BELOW_YES }), severity: kind === 'near_miss' ? 'soft' : 'hard', note: `${kind}: ${note}` } }))
  }
  for (const result of results) {
    const presence = [{ member: 'acct-owner', self: true, active: true, viewport: OWNER_VIEW, focusCard: null, lastInputAgeMs: 400 }, { member: 'acct-member', self: false, active: true, viewport: MEMBER_VIEW, focusCard: null, lastInputAgeMs: 900 }]
    const ws = WP.enumerateWorkScene({ presence, cards: [{ id: 'agent-result', rect: r(5300, 24, 720, 520), kind: 'result', creator: 'agent', taskId: 'task' }],
      tasks: [{ id: 'task', state: 'finished', requester: 'acct-member', waiting: ['acct-member'], ownerMustAct: false, surfaces: [{ kind: 'result', cardId: 'agent-result' }] }] })
    const att = WP.attentionRequest(ws, { taskId: 'task', cardId: 'agent-result' })
    forced = () => result.kind
    await run(result.id, att.dto, { request: result.request, answer: result.answer },
      [{ name: 'owner_action', kind: 'predicate', ...(result.kind === 'yes' ? { min: PLACEMENT_PREDICATE_YES } : { max: BELOW_YES }), severity: 'hard', note: `${result.kind}: ${result.note}` }])
  }
  return requests
}
export const PLACEMENT_PASS_RULE = n => `A request passes when every hard check holds: an expected yes has probability >= ${PLACEMENT_PREDICATE_YES} (the product's bar for acting on a yes) and an expected no has probability <= ${BELOW_YES}. ` +
  `The set passes when all ${n} requests pass. Near misses (same company or same kind of document, another matter) are soft: a miss is reported, never a failure. The note of every check starts with its kind.`
export const planEntry = r => ({ id: r.id, file: r.file, sha256: sha256(r.bytes), estInputTokens: estimatePlacementTokens(r.body.questions.length, r.bytes.length), expect: r.expect })

/** buildPlacementPlan() -> { plan, planBytes, requests } — the full plan (isolation 'question'). */
export async function buildPlacementPlan() {
  const requests = await placementPlanRequests()
  const plan = { set: PLACEMENT_SET, tokenCeiling: PLACEMENT_TOKEN_CEILING, passRule: PLACEMENT_PASS_RULE(requests.length), requests: requests.map(planEntry) }
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n', 'utf8'), requests }
}
