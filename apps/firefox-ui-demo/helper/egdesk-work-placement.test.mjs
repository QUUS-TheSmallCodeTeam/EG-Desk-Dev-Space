// Work-surface placement (lane L4 cycles 12-14; rebuilt by lane L1 in cycle 12 on the real measurement of 2026-11-24):
// WHERE a surface goes is a code rule of the canvas runtime (EGDeskWorkPlacement.sys.mjs) from presence and viewports; the Decision model is asked only
// what code cannot know, as yes/no predicates on real content quoted one item at a time (egdesk-work-placement.mjs), at a beat of the REAL heartbeat,
// through the run's own egress gate. A finished task's attention is the same: code computes both outcomes, one predicate picks between them.
// Synthetic: the canvas is a plain model (cards, one camera, one focus), presence is a mock of the multi-user provider interface, the Decision model is a
// mock client that reads the quoted content. No network, no DOM.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { HEARTBEAT_LIMITS, createHeartbeat } from './egdesk-heartbeat.mjs'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'
import { createEgressGate, EGRESS_KINDS, EGRESS_SITES, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { normalizeEntry } from './egdesk-decision-calibration-log.mjs'
import { PLACEMENT_ISOLATION, PLACEMENT_PREDICATE_YES, WORK_PLACEMENT_LIMITS, codeOutcome, placementRequests, createWorkPlacement, createWorkPlacementHttpHandler, normalizePlacementDto, placementQuestions, pointerWriterPrompt, readPlacement } from './egdesk-work-placement.mjs'
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'
import * as SurfaceState from '../overlay/resources/EGDeskSurfaceState.sys.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'

const r = (x, y, width, height) => ({ x, y, width, height })
const A = r(0, 0, 1200, 800), B = r(4000, 0, 1200, 800)   // region A: the owner's view; region B: the invited member's view
const FILE = { kind: 'file', size: { width: 720, height: 520 } }
const hits = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const gapTo = (a, b) => Math.hypot(Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)), Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)))
const REQUEST = 'A사 견적서 v2 검토해 주세요'

// ---- a synthetic canvas host: cards, the owner's camera and focus, a presence mock of the multi-user interface ----
function desk({ ownerView = A, memberView = B, single = false } = {}) {
  const d = { camera: { ...ownerView }, focus: 'own-doc', cameraMoves: 0, focusMoves: 0, seq: 0,
    cards: [{ id: 'own-doc', rect: r(100, 100, 500, 400), kind: 'file', creator: 'user' }, { id: 'own-note', rect: r(650, 120, 300, 220), kind: 'memo', creator: 'user' },
      ...(single ? [] : [{ id: 'b-board', rect: r(4040, 40, 300, 240), kind: 'other', creator: 'shared' }])],
    people: [{ member: 'acct-owner-7f', self: true, active: true, viewport: ownerView, focusCard: 'own-doc', lastInputAgeMs: 400 },
      ...(single ? [] : [{ member: 'acct-b-19', self: false, active: true, viewport: memberView, focusCard: null, lastInputAgeMs: 900 }])],
    tasks: [{ id: 'run-1', state: 'running', requester: single ? 'acct-owner-7f' : 'acct-b-19', waiting: [single ? 'acct-owner-7f' : 'acct-b-19'], ownerMustAct: false, surfaces: [] }] }
  d.presence = { snapshot: () => d.people.map(p => ({ ...p, viewport: { ...p.viewport } })) }
  d.inputs = () => ({ presence: d.presence.snapshot(), cards: d.cards.map(c => ({ ...c, rect: { ...c.rect } })), tasks: d.tasks.map(t => ({ ...t, surfaces: [...t.surfaces] })) })
  d.scene = () => WP.enumerateWorkScene(d.inputs())
  // The only thing a placement may do: a new card at a rectangle, not activated. The host has no camera or focus call to offer.
  d.open = (rect, kind = 'file') => { const id = `agent-${++d.seq}`; d.cards.push({ id, rect: { ...rect }, kind, creator: 'agent', taskId: 'run-1' }); d.tasks[0].surfaces.push({ kind, cardId: id }); return id }
  d.snapshot = () => JSON.stringify({ camera: d.camera, focus: d.focus, cards: d.cards.map(c => [c.id, c.rect]) })
  return d
}
// Two result cards near the member's side whose words the host may send, one about the same matter, one not; and a private memo that may not go.
const RELATED = [
  { id: 'res-quote-v1', rect: r(5400, 950, 400, 300), kind: 'result', creator: 'agent', maySend: true, label: 'A사 견적서 v1 단가표', excerpt: 'A사 견적서 v1: 단가 12,000원, 수량 40개, 납기 3주.' },
  { id: 'res-lunch', rect: r(5400, -700, 400, 300), kind: 'result', creator: 'agent', maySend: true, label: '점심 메뉴 투표 결과', excerpt: '이번 주 점심은 김치찌개로 정해졌습니다.' },
  { id: 'memo-private', rect: r(5900, 950, 300, 200), kind: 'memo', creator: 'user', label: 'A사 협상 전략 (비공개)', excerpt: '최저 단가 10,000원까지 가능' },
]
// ---- the real heartbeat on a virtual clock ----
function beating(key = 'dm') {
  let clock = 0; const timers = []
  const hb = createHeartbeat({ key, monotonicNow: () => clock, setTimer: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t }, clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) } })
  hb.start()
  const beat = () => { timers.sort((a, b) => a.at - b.at); const t = timers.shift(); if (!t) return false; clock = Math.max(clock, t.at); t.fn(); return true }
  return { hb, beat, now: () => clock, advance: ms => { clock += ms } }
}
// ---- a Decisions client that answers yes/no from the CONTENT it was sent: each same-matter question from the card quoted IN that question (L1 c13:
// nothing in the shared input may tell one card's question from another's), the owner question from the quoted result ----
function judgeClient({ sameMatter = card => /A사 견적서/.test(card), ownerAction = result => /승인|정해 주세요|골라 주세요/.test(result), fail = null } = {}) {
  const calls = []
  return { calls, model: 'mock', async decide(request) {
    calls.push(request)
    if (fail) throw Object.assign(new Error(fail), { code: fail })
    const answers = {}
    for (const q of request.questions) {
      const yes = q.name === 'owner_action' ? ownerAction(request.input.map(row => row.content).join('\n')) : sameMatter(q.instructions)
      answers[q.name] = { type: 'predicate', probability: yes ? 0.97 : 0.03 }
    }
    return { answers, usage: { inputTokens: 9 } }
  } }
}
const ALLOW = createEgressGate(modelDataPermissions({ runActive: true, canvasMaySend: true }))
function bridge(client, { context = { request: REQUEST, answer: '' }, egress = ALLOW, ...extra } = {}) {
  const b = beating(); const log = []
  const placement = createWorkPlacement({ client, mode: () => 'advisory', enabled: () => true, live: () => true, calibrationLog: { record: e => log.push(e) }, now: b.now, setTimer: () => null,
    contextFor: () => (context ? { ...context, egress } : null), ...extra })
  // the chrome's judge: queue the request, let the heartbeat beat once, read the outcome
  const judge = async dto => { const s = placement.submit('dm', dto, b.hb); if (s.status !== 'queued') return null; b.beat(); await placement.idle(); const res = placement.result('dm', s.id); return res.status === 'decided' ? res : null }
  return { ...b, placement, judge, log }
}

// ================= 1. the runtime enumerates, by code =================
test('scene: active users and their views, tasks with requester and waiters, occupied and free regions; ids stay behind aliases; an unknown requester is never the local person', () => {
  const d = desk(); d.open(r(5300, 24, 720, 520))
  const s = d.scene()
  assert.deepEqual(s.members.map(m => [m.alias, m.self, m.active, m.idle]), [['M1', true, true, false], ['M2', false, true, false]])
  assert.deepEqual(s.tasks.map(t => [t.alias, t.state, t.requester, t.waiting, t.surfaces.length]), [['K1', 'running', 'M2', ['M2'], 1]])
  assert.equal(s.occupied.length, 4); assert.ok(s.freeFrames.length > 0 && s.freeFrames.every(f => !s.occupied.some(o => hits(o, f.rect)) && !hits(f.rect, A) && !hits(f.rect, B)), 'free frames are empty and outside every active view')
  assert.equal(s.cards.find(c => c.id === 'agent-1').taskId, 'run-1', 'a task\'s surface card is tied to its task')
  // a requester the presence feed does not list (sharing off, gone): unknown, NOT the local person
  const unknown = WP.enumerateWorkScene({ ...d.inputs(), tasks: [{ id: 'x', state: 'running', requester: 'm-0123456789abcdef', waiting: ['m-0123456789abcdef'] }] })
  assert.deepEqual(unknown.tasks.map(t => [t.requester, t.waiting]), [[null, []]])
  assert.deepEqual(WP.enumerateWorkScene({ ...d.inputs(), tasks: [{ id: 'own', state: 'running', requester: null, waiting: [] }] }).tasks[0].requester, 'M1', 'no requester named: the local person')
  // a card's words exist in the scene only when the host marked it maySend
  const quoted = WP.enumerateWorkScene({ ...d.inputs(), cards: RELATED }).cards
  assert.deepEqual(quoted.map(c => [c.id, c.quote?.label ?? null]), [['res-quote-v1', 'A사 견적서 v1 단가표'], ['res-lunch', '점심 메뉴 투표 결과'], ['memo-private', null]])
  // presence rows that do not fit the interface are dropped; a second "self" is not believed
  const odd = WP.normalizePresence([{ member: 'a', self: true, active: true, viewport: A, lastInputAgeMs: 1 }, { member: 'b', self: true, active: true, viewport: B, lastInputAgeMs: 1 }, { member: 'c', viewport: { x: 0 } }, { member: 'a', viewport: A }, null])
  assert.deepEqual(odd.map(m => [m.member, m.self]), [['a', true], ['b', false]])
  const single = WP.createSingleUserPresence({ viewport: () => A, focusCard: () => 'own-doc', lastInputAt: () => 1000, now: () => 26_000 }).snapshot()
  assert.deepEqual(single, [{ member: 'self', self: true, active: true, viewport: A, focusCard: 'own-doc', lastInputAgeMs: 25_000 }], 'the single-user provider has the same shape')
  assert.deepEqual(WP.createSingleUserPresence({ viewport: () => null }).snapshot(), [])
})

// ================= 2. where it goes is a code rule =================
test('rules (R3): same resource -> reuse; same task -> beside its surface; waiting+working -> beside the requester\'s view; waiting+idle -> in it; nobody waiting -> quiet; unknown -> the conservative zone', () => {
  const plan = (d, surface = FILE, taskId = 'run-1') => WP.placementPlan(d.scene(), { taskId, surface })
  // waiting and working: just outside B's view, never in A or B
  const d = desk(); const working = plan(d)
  assert.deepEqual([working.rule, working.option.kind], ['requester_working', 'near_requester'])
  assert.ok(!hits(working.option.rect, A) && !hits(working.option.rect, B) && gapTo(working.option.rect, B) < WP.PLACEMENT_RULES.nearViews * 1200)
  for (const o of working.options) assert.ok(WP.placementAllowed(d.scene(), o.rect, 'M2') && !hits(o.rect, A), `${o.kind} passed the hard rules`)
  // waiting and idle: a free spot inside B's own view, covering nothing
  d.people[1].lastInputAgeMs = 25_000
  const idle = plan(d); assert.deepEqual([idle.rule, idle.option.kind], ['requester_idle', 'in_requester_view'])
  assert.ok(hits(idle.option.rect, B) && !hits(idle.option.rect, A) && !d.cards.some(c => hits(c.rect, idle.option.rect)))
  // nobody waiting: away from every active view
  d.people[1].lastInputAgeMs = 900; d.tasks[0].waiting = []
  const quiet = plan(d); assert.deepEqual([quiet.rule, quiet.option.kind], ['nobody_waiting', 'quiet'])
  for (const v of [A, B]) assert.ok(gapTo(quiet.option.rect, v) >= WP.PLACEMENT_RULES.quietMinViews * 1200, 'quiet is away from every active view')
  // the task already has a surface: the next one goes beside it (code knows the task's cards)
  d.tasks[0].waiting = ['acct-b-19']; const first = d.open(working.option.rect)
  const second = plan(d, { kind: 'terminal', size: { width: 600, height: 380 } })
  assert.deepEqual([second.rule, second.option.kind, second.related.length], ['same_task', 'beside_related', 0]); assert.ok(gapTo(second.option.rect, working.option.rect) <= 25)
  // the same resource is already open: it is reused where it is, and nothing is asked
  const reuse = plan(d, { ...FILE, cardId: first }); assert.deepEqual([reuse.rule, reuse.option.kind, reuse.option.rect, reuse.related], ['same_resource', 'reuse', working.option.rect, []])
  d.cards.push({ id: 'open-viewer', rect: r(-3000, 0, 720, 520), kind: 'file', creator: 'agent', resource: 'file:/work/quote.xlsx' })
  const same = plan(d, { ...FILE, resource: 'file:/work/quote.xlsx' }); assert.deepEqual([same.rule, same.option.kind, same.option.cardId], ['same_resource', 'reuse', 'open-viewer'])
  // the requester is not in the presence feed: the owner's adjacent work area, outside EVERY view (the owner's included), nothing near anyone's gaze
  const lost = desk(); lost.tasks[0].requester = 'm-0123456789abcdef'; lost.tasks[0].waiting = ['m-0123456789abcdef']
  const unknown = plan(lost); assert.deepEqual([unknown.rule, unknown.option.kind], ['unknown_presence', 'adjacent_area'])
  assert.ok(!hits(unknown.option.rect, A) && !hits(unknown.option.rect, B)); for (const o of unknown.options) assert.ok(!hits(o.rect, A), `${o.kind}: an unknown requester has no view of its own, the owner's is protected`)
  assert.ok(!unknown.options.some(o => o.kind === 'in_requester_view'))
})
test('single user: beside my view while I type; into my view when I am waiting and idle; crowded canvas -> the adjacent work area; walled in -> nothing', () => {
  const d = desk({ single: true })
  const typing = WP.placementPlan(d.scene(), { taskId: 'run-1', surface: FILE })
  assert.deepEqual([typing.rule, typing.option.kind, typing.option.descriptor.direction], ['requester_working', 'near_requester', 'right']); assert.ok(!hits(typing.option.rect, A) && gapTo(typing.option.rect, A) < 900)
  d.people[0].lastInputAgeMs = 60_000
  assert.equal(WP.placementPlan(d.scene(), { taskId: 'run-1', surface: FILE }).option.kind, 'near_requester', 'my view has no free room for a surface this large')
  const idle = WP.placementPlan(d.scene(), { taskId: 'run-1', surface: { kind: 'result', size: { width: 400, height: 300 } } })
  assert.deepEqual([idle.rule, idle.option.kind], ['requester_idle', 'in_requester_view']); assert.ok(hits(idle.option.rect, A) && !d.cards.some(c => hits(c.rect, idle.option.rect)), 'a free spot in my own view, covering nothing')
  // everything around my view is taken (Board regions and cards) out to several views, except one whole frame four steps to the right
  d.people[0].lastInputAgeMs = 400
  const free = r(A.x + 4 * (A.width + 48), A.y, A.width, A.height), far = 40_000
  const obstacles = [r(-far, -far, 2 * far, far - 24), r(-far, 824, 2 * far, far), r(-far, -24, far - 24, 848), r(1224, -24, free.x - 24 - 1224, 848), r(free.x + free.width + 24, -24, far, 848)]
  const crowded = WP.placementPlan(WP.enumerateWorkScene({ ...d.inputs(), obstacles }), { taskId: 'run-1', surface: FILE })
  assert.deepEqual([crowded.rule, crowded.option.kind, crowded.options.map(o => o.kind)], ['requester_working', 'adjacent_area', ['adjacent_area']])
  assert.ok(hits(crowded.option.rect, free) && crowded.option.rect.x === free.x + 24 && !obstacles.some(o => hits(o, crowded.option.rect)))
  assert.equal(WP.placementRequest(WP.enumerateWorkScene({ presence: d.presence.snapshot(), tasks: d.tasks, cards: [], obstacles: [r(-far, -far, 2 * far, 2 * far)] }), { taskId: 'run-1', surface: FILE }), null, 'nowhere at all: the caller keeps today\'s placement')
})

// ================= 3. hard rules are code, here and again on the bridge =================
test('hard rules: never inside another active user\'s view; no camera or focus API exists; user-made cards never move; the bridge re-checks the rule from the descriptors', () => {
  const d = desk(); const s = d.scene()
  assert.equal(WP.placementAllowed(s, r(200, 600, 100, 100), 'M2'), false, 'inside the owner\'s view'); assert.equal(WP.placementAllowed(s, r(4700, 550, 300, 200), 'M2'), true, 'the requester\'s own view is not "another"')
  assert.equal(WP.placementAllowed(s, r(4700, 550, 300, 200), 'M1'), false, 'the same spot is forbidden for a task the owner asked for')
  assert.equal(WP.placementAllowed(s, r(200, 600, 100, 100), null), false, 'an unknown requester protects every view, the owner\'s too')
  const source = readFileSync(new URL('../overlay/resources/EGDeskWorkPlacement.sys.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const forbidden of ['setCamera', 'setCanvasViewportTarget', 'setCanvasPanTarget', '.focus(', 'setActiveEntity', 'fetch(', 'document.', 'boardLedger', 'saveBoard']) assert.ok(!source.includes(forbidden), `the placement runtime cannot ${forbidden}`)
  const dto = WP.placementRequest(WP.enumerateWorkScene({ ...d.inputs(), cards: [...d.cards, ...RELATED] }), { taskId: 'run-1', surface: FILE }).dto
  assert.ok(normalizePlacementDto(dto))
  const forged = fn => { const copy = structuredClone(dto); fn(copy); return normalizePlacementDto(copy) }
  assert.equal(forged(c => { c.pick.insideView = ['M1'] }), null, 'a pick inside the owner\'s view is refused whole')
  assert.equal(forged(c => { c.pick.kind = 'in_requester_view'; c.pick.insideView = ['M2'] }), null, 'into the requester\'s view without the idle rule')
  assert.equal(forged(c => { c.rule = 'requester_idle'; c.pick.kind = 'in_requester_view'; c.pick.insideView = ['M2'] }), null, 'the rule says idle, the member is not')
  assert.equal(forged(c => { c.pick.kind = 'reuse' }), null, 'reuse only under the same-resource rule')
  assert.equal(forged(c => { c.related[0].insideView = ['M1'] }), null, 'a spot beside a related card inside the owner\'s view')
  assert.equal(forged(c => { c.related[0].alias = 'R7' }), null); assert.equal(forged(c => { c.related[0].rect = { x: 1 } }), null); assert.equal(forged(c => { c.related[0].label = 'x'.repeat(121) }), null)
  assert.equal(forged(c => { c.related.push(...structuredClone(c.related), ...structuredClone(c.related)) }), null, 'at most three related cards')
  assert.equal(forged(c => { c.rule = 'same_resource'; c.pick.kind = 'reuse' }), null, 'nothing is asked when the resource is already open')
  assert.equal(forged(c => { c.members.push({ alias: 'M3', self: true, active: true, idle: false }) }), null, 'two selves')
  assert.equal(forged(c => { c.requester = 'M5' }), null); assert.equal(forged(c => { c.title = 'Secret plan' }), null)
  assert.ok(forged(c => { c.members[0].active = false; c.pick.insideView = ['M1'] }), 'an inactive member\'s old view is not protected')
  // attention: a user-made or shared card is never offered a move, whatever the DTO claims; the owner is never offered one
  d.people[1].lastInputAgeMs = 30_000; d.tasks[0].state = 'finished'
  for (const id of ['own-doc', 'b-board']) assert.notEqual(WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: id }).outcomes.requester.kind, 'surface_near_requester', id)
  const agentCard = d.open(r(5300, 24, 720, 520)); const att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: agentCard })
  assert.equal(att.outcomes.requester.kind, 'surface_near_requester'); assert.equal(att.outcomes.owner.kind, 'point')
  const bad = structuredClone(att.dto); bad.card.creator = 'user'; assert.equal(normalizePlacementDto(bad), null, 'the bridge refuses a move of a card nobody\'s Agent made')
  const bad2 = structuredClone(att.dto); bad2.forRequester.insideView = ['M1', 'M2']; assert.equal(normalizePlacementDto(bad2), null)
  const bad3 = structuredClone(att.dto); bad3.forOwner = { ...bad3.forRequester, forMember: 'M1' }; assert.equal(normalizePlacementDto(bad3), null, 'never a move for the owner')
})

// ================= 4. the content questions =================
test('same matter (R1/R2/R4): one predicate per nearby card the host may send, each quoted on its own with the run\'s request; yes -> beside that card, no -> the rule\'s spot', async () => {
  const d = desk(); d.cards.push(...RELATED)
  const req = WP.placementRequest(d.scene(), { taskId: 'run-1', surface: FILE }, { landed: r(24, 24, 720, 520) })
  assert.deepEqual(Object.keys(req.dto), ['kind', 'surface', 'members', 'requester', 'rule', 'pick', 'related', 'landed'])
  assert.deepEqual(req.dto.related.map(x => [x.alias, x.label]), [['R1', 'A사 견적서 v1 단가표'], ['R2', '점심 메뉴 투표 결과']], 'nearest first; the private memo is not a candidate')
  assert.deepEqual(req.dto.landed, { distance: 'far', direction: 'left', insideView: ['M1'] }, 'today it would open in the OWNER\'s view, far from the member who asked')
  const wire = JSON.stringify(req.dto); for (const bad of ['acct-', 'own-doc', 'res-quote', 'memo-private', '협상', 'run-1', '"x"', '"rect"', '5400']) assert.ok(!wire.includes(bad), bad)
  const client = judgeClient(); const br = bridge(client)
  const placed = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: FILE }, judge: br.judge })
  assert.deepEqual([placed.option.kind, placed.option.cardId, placed.source], ['beside_related', 'res-quote-v1', 'decision'])
  assert.ok(gapTo(placed.rect, RELATED[0].rect) <= 25 && !hits(placed.rect, A) && WP.placementAllowed(d.scene(), placed.rect, 'M2'), 'beside the v1 quote, under the hard rules')
  // exactly what was asked: the request quoted once, each card quoted alone under its own question, yes/no only
  assert.equal(client.calls.length, 1); const sent = client.calls[0]
  assert.deepEqual(sent.questions.map(q => [q.name, q.type]), [['same_matter_R1', 'predicate'], ['same_matter_R2', 'predicate']])
  // L1 c13 isolation: the shared input is the request only; each question carries its own card and no other
  assert.deepEqual(sent.input.map(row => row.role), ['developer', 'user'])
  assert.match(sent.input[1].content, new RegExp(`The person's request:\\n"""\\n${REQUEST}\\n"""`)); assert.match(sent.input[1].content, /opening a file surface/)
  for (const card of RELATED) assert.ok(!sent.input.some(row => row.content.includes(card.label)), `no card in the shared input: ${card.label}`)
  assert.match(sent.questions[0].instructions, /The card:\n"""\nA사 견적서 v1 단가표\nA사 견적서 v1: 단가/); assert.doesNotMatch(sent.questions[0].instructions, /점심/)
  assert.match(sent.questions[1].instructions, /The card:\n"""\n점심 메뉴/); assert.doesNotMatch(sent.questions[1].instructions, /견적/)
  assert.notEqual(sent.questions[0].instructions, sent.questions[1].instructions, 'no two questions are the same question')
  const text = JSON.stringify(sent); for (const bad of ['acct-', 'own-doc', 'res-quote', '협상', '10,000', '"x"', '5400', 'M2']) assert.ok(!text.includes(bad), bad)
  assert.equal(sent.promptCacheKey, 'work-placement'); assert.equal(sent.timeoutMs, 2000)
  // the calibration log's own family (finding A4): content-free predicates against their bar
  assert.deepEqual(br.log, [{ feature: 'work_placement', mode: 'advisory', candidates: 2, judgedTotal: 2, attached: false,
    judgments: [{ q: 'same_matter', p: 0.97, threshold: PLACEMENT_PREDICATE_YES, would: 'act' }, { q: 'same_matter', p: 0.03, threshold: PLACEMENT_PREDICATE_YES, would: 'hold' }] }])
  const kept = normalizeEntry(br.log[0], Date.UTC(2026, 10, 24)); assert.deepEqual([kept.feature, kept.judgments.map(j => [j.q, j.p, j.would])], ['work_placement', [['same_matter', 0.97, 'act'], ['same_matter', 0.03, 'hold']]])
  assert.deepEqual(br.placement.records().map(x => [x.kind, x.rule, x.source, x.would.kind]), [['placement', 'requester_working', 'decision', 'beside_related']])
  // no card is about the same matter: the rule's own spot, as decided by code
  const no = bridge(judgeClient({ sameMatter: () => false }))
  const ruled = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: FILE }, judge: no.judge })
  assert.deepEqual([ruled.option.kind, ruled.source, ruled.rule], ['near_requester', 'rule', 'requester_working'])
  // nothing to ask (no card the host may send): no request at all
  const plainDesk = desk(); const silent = judgeClient(); const quiet = bridge(silent)
  const own = await WP.placeSurface({ scene: plainDesk.inputs, request: { taskId: 'run-1', surface: FILE }, judge: quiet.judge })
  assert.deepEqual([own.option.kind, own.source, silent.calls.length], ['near_requester', 'rule', 0])
})
test('owner action: running -> nothing; waiting_owner -> the owner, not asked; finished -> ONE predicate on the run\'s own request and answer picks the owner\'s or the requester\'s outcome', async () => {
  const d = desk(); const viewer = d.open(r(5300, 24, 720, 520))
  const ask = async (state, answer, { ownerMustAct = false, idle = false } = {}) => {
    d.tasks[0].state = state; d.tasks[0].ownerMustAct = ownerMustAct; d.people[1].lastInputAgeMs = idle ? 45_000 : 900
    const att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer }); const client = judgeClient(); const br = bridge(client, { context: { request: REQUEST, answer } })
    const res = await br.judge(att.dto); return { att, res, client, br }
  }
  const running = await ask('running', '')
  assert.deepEqual([running.res.kind, running.res.source, running.client.calls.length], ['leave', 'rule', 0], 'still running: nothing to tell anyone, nothing asked')
  const approval = await ask('waiting_owner', '', { ownerMustAct: true })
  assert.deepEqual([approval.res.branch, approval.res.kind, approval.res.forMember, approval.res.source, approval.client.calls.length], ['owner', 'point', 'M1', 'rule', 0], 'the code knows the owner must act')
  assert.deepEqual(approval.att.dto.forOwner, { kind: 'point', distance: 'very_far', direction: 'right', insideView: [], forMember: 'M1' })
  const needs = await ask('finished', '견적서 v2 검토를 마쳤습니다. 단가 변경은 계약 조건이라 소유자 승인이 필요합니다.')
  assert.deepEqual([needs.res.branch, needs.res.kind, needs.res.forMember, needs.res.source], ['owner', 'point', 'M1', 'decision'])
  const sent = needs.client.calls[0]; assert.deepEqual(sent.questions.map(q => [q.name, q.type]), [['owner_action', 'predicate']])
  assert.match(sent.input[1].content, /The person's request:\n"""\nA사 견적서 v2 검토해 주세요\n"""/); assert.match(sent.input[2].content, /The result of the work \(the assistant's answer\):\n"""\n견적서 v2 검토를 마쳤습니다/)
  assert.ok(!/M[12]|acct-|5300|"x"/.test(JSON.stringify(sent)), 'no member alias, id or coordinate: only the run\'s own words')
  assert.deepEqual(needs.br.log.map(e => [e.feature, e.candidates, e.judgments.map(j => [j.q, j.would])]), [['work_placement', 1, [['owner_action', 'act']]]])
  const info = await ask('finished', '견적서 v2를 v1과 비교해 차이 세 가지를 정리했습니다.')
  assert.deepEqual([info.res.branch, info.res.kind, info.res.forMember, info.res.source], ['requester', 'point', 'M2', 'decision'], 'nothing for the owner: the requester is told where the result is')
  // the requester waits and is idle: their outcome is surfacing the Agent's card near THEIR view; never into the owner's
  const idle = await ask('finished', '정리를 마쳤습니다.', { idle: true })
  assert.deepEqual([idle.res.branch, idle.res.kind], ['requester', 'surface_near_requester'])
  const pick = idle.att.outcomes.requester; assert.ok(hits(pick.rect, B) && !hits(pick.rect, A) && !d.cards.some(c => c.id !== viewer && hits(c.rect, pick.rect)))
  // the owner walks over before it is applied: the fresh outcome of the same branch, re-checked; covered completely -> told instead of moved
  d.people[0].viewport = r(3900, -50, 1500, 950)
  const settled = WP.settle(() => WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer }), { branch: 'requester', kind: pick.kind, rect: pick.rect })
  assert.deepEqual([settled.source, settled.option.kind], ['revalidated', 'surface_near_requester']); assert.ok(!hits(settled.option.rect, d.people[0].viewport) && !hits(settled.option.rect, B))
  d.people[0].viewport = r(1500, -3000, 7000, 7000)
  const none = WP.settle(() => WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer }), { branch: 'requester', kind: pick.kind, rect: pick.rect })
  assert.deepEqual([none.option.kind, none.source], ['point', 'revalidated'])
  // no answer text (or not allowed): the code's outcome without asking
  d.people[0].viewport = A
  assert.deepEqual((await ask('finished', '')).res.source, 'no_material')
  const denied = judgeClient(); const deniedBr = bridge(denied, { context: { request: REQUEST, answer: '승인이 필요합니다' }, egress: createEgressGate(modelDataPermissions({ runActive: false })) })
  d.tasks[0].state = 'finished'; d.people[1].lastInputAgeMs = 900
  const deniedRes = await deniedBr.judge(WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer }).dto)
  assert.deepEqual([deniedRes.branch, deniedRes.source, denied.calls.length], ['requester', 'not_allowed', 0], 'the run\'s gate does not allow its text: nothing is sent')
})

// ================= 5. the journey: owner at A, invited member at B =================
test('journey: B asks the owner\'s Agent to inspect a file -> the viewer opens beside B by rule; nothing changes in A (camera, focus, cards); a pan moves nothing and later surfaces stay out of the owner\'s new view', async () => {
  const d = desk(); const before = d.snapshot()
  const placed = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: FILE }, judge: bridge(judgeClient()).judge })
  assert.deepEqual([placed.option.kind, placed.source, placed.rule], ['near_requester', 'rule', 'requester_working'])
  const id = d.open(placed.rect)
  assert.ok(!hits(placed.rect, A) && !hits(placed.rect, B) && gapTo(placed.rect, B) < 900, 'next to the member\'s view, outside it, nowhere near the owner\'s')
  const after = JSON.parse(d.snapshot()), was = JSON.parse(before)
  assert.deepEqual(after.camera, was.camera); assert.equal(after.focus, was.focus); assert.deepEqual(after.cards.slice(0, 3), was.cards, 'the owner\'s cards and the member\'s board did not move')
  assert.equal(d.cards.filter(c => hits(c.rect, A)).length, 2, 'nothing new in region A'); assert.equal(d.cards.find(c => c.id === id).creator, 'agent')
  // the owner pans: their view now covers B's side, including the viewer
  const cardsBefore = JSON.stringify(d.cards)
  d.people[0].viewport = r(4600, -100, 1400, 900); d.camera = { ...d.people[0].viewport }
  assert.ok(hits(placed.rect, d.people[0].viewport)); assert.equal(JSON.stringify(d.cards), cardsBefore, 'a pan moves no card: the viewer stays where it was opened')
  const next = WP.placementPlan(d.scene(), { taskId: 'run-1', surface: { kind: 'terminal', size: { width: 600, height: 380 } } })
  assert.ok(next.options.length > 0); for (const o of next.options) assert.ok(!hits(o.rect, d.people[0].viewport), `${o.kind} would open under the owner`)
  assert.ok(!next.options.some(o => o.kind === 'beside_related'), 'next to the viewer is now inside the owner\'s view, so that spot does not exist')
  // a decision made BEFORE a pan is re-checked against the scene as it is when it would be applied
  const d2 = desk(); d2.cards.push(...RELATED)
  const slow = async dto => { const res = await bridge(judgeClient()).judge(dto); d2.people[0].viewport = r(5300, 700, 1400, 900); return res }
  const late = await WP.placeSurface({ scene: d2.inputs, request: { taskId: 'run-1', surface: FILE }, judge: slow })
  assert.ok(late && !hits(late.rect, d2.people[0].viewport), 'the stale spot was dropped'); assert.equal(late.source, 'revalidated')
})

// ================= 6. heartbeat, mode, budget of judgments, egress =================
test('heartbeat: one judgment per beat, stale scenes are dropped, off / no heartbeat / denied egress / failures ask nothing more; the per-heartbeat cap holds', async () => {
  const d = desk(); d.cards.push(...RELATED); const dto = WP.placementRequest(d.scene(), { taskId: 'run-1', surface: FILE }).dto
  const client = judgeClient(); const br = bridge(client)
  const a = br.placement.submit('dm', dto, br.hb), b = br.placement.submit('dm', dto, br.hb)
  assert.equal(client.calls.length, 0, 'queuing asks nothing'); assert.deepEqual(br.placement.result('dm', a.id), { status: 'pending' })
  assert.deepEqual(br.hb.snapshot().providers, ['work_placement']); assert.equal(br.hb.facts().sources.work_placement.placementsPending, 2)
  br.beat(); await br.placement.idle(); assert.equal(client.calls.length, 1); assert.deepEqual([br.placement.result('dm', a.id).kind, br.placement.result('dm', a.id).related], ['beside_related', 'R1'])
  br.advance(31_000); br.beat(); await br.placement.idle(); assert.equal(client.calls.length, 1, 'the second scene went stale: it is not judged'); assert.deepEqual(br.placement.result('dm', b.id), { status: 'expired' })
  const off = createWorkPlacement({ client, mode: () => 'advisory', enabled: () => false }); assert.deepEqual(off.submit('dm', dto, br.hb), { status: 'off' })
  const modeOff = createWorkPlacement({ client, mode: () => 'off', enabled: () => true }); assert.deepEqual(modeOff.submit('dm', dto, br.hb), { status: 'off' })
  assert.deepEqual(br.placement.submit('dm', dto, null), { status: 'no-heartbeat' }); assert.deepEqual(br.placement.submit('dm', { ...dto, extra: 1 }, br.hb), { status: 'invalid' })
  const stopped = beating(); stopped.hb.stop('run_end'); assert.deepEqual(br.placement.submit('other', dto, stopped.hb), { status: 'no-heartbeat' })
  // the shared egress gate: the run's own text and the cards the host may send, under the run's permissions
  assert.deepEqual(EGRESS_SITES['egdesk-work-placement.mjs'], ['run_text', 'canvas_text']); assert.equal(EGRESS_KINDS.placement_facts, undefined, 'the closed-label kind is gone: nothing sends it')
  for (const egress of [createEgressGate(modelDataPermissions({ runActive: false, canvasMaySend: true })), createEgressGate(modelDataPermissions({ runActive: true, canvasMaySend: false }))]) {
    const deniedClient = judgeClient(); const denied = bridge(deniedClient, { egress }); const s = denied.placement.submit('dm', dto, denied.hb); denied.beat(); await denied.placement.idle()
    assert.deepEqual([denied.placement.result('dm', s.id).source, denied.placement.result('dm', s.id).kind, deniedClient.calls.length], ['not_allowed', 'near_requester', 0], 'the rule\'s spot stands, nothing sent')
  }
  const noRun = bridge(judgeClient(), { context: null }); const n = noRun.placement.submit('dm', dto, noRun.hb); noRun.beat(); await noRun.placement.idle()
  assert.equal(noRun.placement.result('dm', n.id).source, 'no_material')
  const failing = bridge(judgeClient({ fail: 'timeout' })); const f = failing.placement.submit('dm', dto, failing.hb); failing.beat(); await failing.placement.idle()
  assert.deepEqual([failing.placement.result('dm', f.id).source, failing.placement.result('dm', f.id).kind], ['failed', 'near_requester']); assert.deepEqual(failing.log.map(e => [e.feature, e.fallback, e.judgments.length]), [['work_placement', 'timeout', 0]])
  const capped = bridge(judgeClient(), { limits: { maxEvals: 1 } })
  for (let i = 0; i < 3; i++) { capped.placement.submit('dm', dto, capped.hb); capped.beat(); await capped.placement.idle() }
  assert.deepEqual(capped.placement.records().map(x => x.source), ['decision', 'limit', 'limit'])
})
test('questions and reading: bounded, one item per question, the code combines; an unsure or missing answer is the code\'s outcome', () => {
  const d = desk(); d.cards.push(...RELATED); const dto = normalizePlacementDto(WP.placementRequest(d.scene(), { taskId: 'run-1', surface: FILE }).dto)
  assert.equal(placementQuestions(dto, { request: '' }), null, 'no request text: nothing to ask')
  const long = placementQuestions(dto, { request: 'x'.repeat(5000) }); assert.ok(long.input[1].content.length < WORK_PLACEMENT_LIMITS.requestChars + 200, 'the quoted request is bounded')
  const ans = (r1, r2) => ({ same_matter_R1: { type: 'predicate', probability: r1 }, same_matter_R2: { type: 'predicate', probability: r2 } })
  assert.deepEqual(readPlacement(dto, ans(0.9, 0.95)).outcome.related, 'R1', 'both yes: the code\'s order (nearest first)')
  assert.deepEqual(readPlacement(dto, ans(0.1, 0.95)).outcome.related, 'R2')
  assert.deepEqual(readPlacement(dto, ans(0.79, 0.2)).outcome, { kind: 'near_requester', distance: dto.pick.distance, direction: dto.pick.direction }, 'below the bar is not a yes')
  assert.equal(readPlacement(dto, {}).accepted, false); assert.equal(readPlacement(dto, { same_matter_R1: { type: 'refusal' } }).outcome.kind, 'near_requester')
  assert.deepEqual(codeOutcome(dto), { kind: 'near_requester', distance: dto.pick.distance, direction: dto.pick.direction })
})
test('bridge route: loopback JSON POST only; the request finds the conversation\'s heartbeat by local chat id or thread id', async () => {
  const d = desk(); d.cards.push(...RELATED); const dto = WP.placementRequest(d.scene(), { taskId: 'run-1', surface: FILE }).dto
  const br = bridge(judgeClient())
  const handler = createWorkPlacementHttpHandler({ placement: br.placement, heartbeatFor: key => (key === 'thread-9' ? br.hb : null) })
  const call = async (method, path, body, headers = {}) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: path, method, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json', ...headers } })
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(c) { this.status = c }, end(j) { this.body = JSON.parse(j); this.writableEnded = true } })
    const handled = await handler(req, res, new URL(path, 'http://127.0.0.1:39218')); return { handled, status: res.status, body: res.body }
  }
  assert.equal((await call('POST', '/decision/other', {})).handled, false)
  assert.equal((await call('GET', '/decision/work-placement/request')).status, 405); assert.equal((await call('POST', '/decision/work-placement/request', { dto }, { origin: 'https://evil.example' })).status, 403)
  const queued = await call('POST', '/decision/work-placement/request', { clientThreadId: 'local-dm', conversationId: 'thread-9', dto }); assert.equal(queued.body.status, 'queued')
  assert.deepEqual((await call('POST', '/decision/work-placement/request', { clientThreadId: 'nobody', dto })).body, { status: 'no-heartbeat' })
  br.beat(); await br.placement.idle()
  const res = await call('POST', '/decision/work-placement/result', { conversationId: 'thread-9', id: queued.body.id }); assert.deepEqual([res.body.status, res.body.kind, res.body.related, res.body.source], ['decided', 'beside_related', 'R1', 'decision'])
  const records = await call('POST', '/decision/work-placement/records', {}); assert.equal(records.body.records.length, 1); assert.ok(!/acct-|own-doc|견적|"x"/.test(JSON.stringify(records.body)), 'records stay closed words')
})

// ================= 7. the first real consumer: default off; "advisory" and "on" are the bridge's words =================
const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const at = surface.indexOf(`  function ${name}(`), s = at >= 0 ? at : surface.indexOf(`  async function ${name}(`); assert.ok(s >= 0, name); return surface.slice(s, surface.indexOf('\n  }', s) + 4) }
function consumer({ pref } = {}) {
  const log = { prefs: [], posts: [], queries: 0, listeners: 0 }
  const nodes = [{ id: 'c1', isConnected: true, dataset: {}, _rect: r(100, 100, 500, 400) },
    { id: 'c2', isConnected: true, dataset: {}, _rect: r(1500, 120, 300, 220), _resultRecord: { title: 'A사 견적서 v1', text: '단가 12,000원', provenance: { creator: 'agent', runId: 'run-6' } } }]
  const state = { activeEntityId: 'c1' }
  const deps = { WorkPlacement: WP, state, readSurfacePref: key => { log.prefs.push(key); return pref }, document: { querySelectorAll: sel => { log.queries++; return sel === '.egd-canvas-card' ? nodes : [] } },
    window: { addEventListener: () => { log.listeners++ } }, persistentEntityGeometry: n => ({ ...n._rect, zIndex: 1 }), cardKindForPersistence: () => 'file', safeViewportWorldRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800 }),
    deskStoreRequest: async (method, path, body) => { log.posts.push([method, path, body]); return { status: 200, body: { status: 'queued' } } } }
  const body = `let workInputAt = null, workInputWatch = false;\n${decl('workPresence')}\n${decl('workSceneInputs')}\n${decl('noteWorkSurfacePlacement')}\nreturn noteWorkSurfacePlacement;`
  return { note: new Function(...Object.keys(deps), body)(...Object.values(deps)), log, state }
}
test('consumer, default path: unless the pref is "advisory" or "on" the hook reads the pref and does nothing else; the placement that is returned is never touched', () => {
  for (const pref of [undefined, null, 'off', 'ON', 'ADVISORY', 'live', '', { unreadable: true }]) {
    const c = consumer({ pref }); const placement = Object.freeze({ x: 24, y: 24, width: 720, height: 520, inView: true })
    c.note('file', placement, { runId: 'run-7', conversationId: 'thread-9' })
    assert.deepEqual(c.log, { prefs: ['egdesk.workPlacement'], posts: [], queries: 0, listeners: 0 }, String(pref)); assert.deepEqual(Object.keys(c.state), ['activeEntityId'])
  }
  // the pref has the bridge's vocabulary: advisory | on, anything else off (lane L2's finding: "on" used to read as off)
  assert.deepEqual(['advisory', 'on', 'off', 'ON', undefined, 'yes'].map(WP.workPlacementMode), ['advisory', 'on', 'off', 'off', 'off', 'off'])
  const fn = decl('resolveCanvasCardPlacement')
  // L1 c13: the hook may hand back the rule's spot ("on"); anything falsy keeps today's placement
  assert.match(fn, /const placed = SurfaceState\.placeCanvasView\(\{ size, safe, occupied, anchor, gap: 24 \}\);\n[^\n]*\n[^\n]*\n    if \(options\.workSurface\) return state\.noteWorkSurfacePlacement\?\.\(kind, placed, options\.workSurface\) \|\| placed;\n    return placed;/)
  assert.match(surface, /resolveCanvasCardPlacement\('result', options\.restore \? \{\} : \{ workSurface: \{ kind: 'result'/)
  const zone = readFileSync(new URL('../overlay/resources/surface/EGDeskSurfaceFileCard.mjs', import.meta.url), 'utf8')
  assert.match(zone, /resolveCanvasCardPlacement\('file', runFile \? \{ workSurface: \{ kind: 'file', runId: runFile\.target\?\.runId, conversationId: runFile\.target\?\.conversationId \} \} : \{\}\)/)
  const server = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(server, /enabled: \(\) => \['advisory', 'on'\]\.includes\(process\.env\.EGDESK_WORK_PLACEMENT\),/); assert.match(server, /live: \(\) => process\.env\.EGDESK_WORK_PLACEMENT === 'on'/); assert.match(server, /if \(await handleWorkPlacementHttp\(req, res, url\)\) return/)
  assert.match(server, /contextFor: \(key, options\) => chat\.placementContextFor\(key, options\)/)
})
test('consumer, advisory and on: the rule\'s spot against where it lands today, the request with a result card\'s words (maySend); "on" hands the spot back, quiet', () => {
  for (const pref of ['advisory', 'on']) {
    const c = consumer({ pref }); const placement = Object.freeze({ x: 24, y: 440, width: 720, height: 340, inView: true })
    const returned = c.note('file', placement, { runId: 'run-7', conversationId: 'thread-9' })
    if (pref === 'advisory') assert.equal(returned, null, 'advisory returns nothing: the surface lands where it lands today')
    else {
      assert.deepEqual([returned.width, returned.height, returned.inView, returned.quiet], [720, 340, false, true], 'on (L1 c13): the rule\'s spot, same size, quiet')
      const own = r(0, 0, 1200, 800); assert.ok(!hits(returned, own) && gapTo(returned, own) < WP.PLACEMENT_RULES.nearViews * 1200, 'just beside my view (I am typing), not in it')
    }
    assert.equal(c.log.posts.length, 1); const [method, path, body] = c.log.posts[0]
    assert.deepEqual([method, path, Object.keys(body)], ['POST', '/decision/work-placement/request', ['clientThreadId', 'conversationId', 'dto']]); assert.ok(normalizePlacementDto(body.dto), 'exactly the shape the bridge accepts')
    assert.deepEqual([body.dto.rule, body.dto.pick.kind, body.dto.landed], ['requester_working', 'near_requester', { distance: 'in_view', direction: 'in_view', insideView: ['M1'] }], 'I am waiting for my own run and typing: beside my view; today: inside it')
    assert.deepEqual(body.dto.related.map(x => [x.label, x.excerpt]), [['A사 견적서 v1', '단가 12,000원']], 'a published result card may be asked about; the other card has no words to send')
    assert.deepEqual(c.state.workPlacementLog, [{ surface: 'file', would: { rule: 'requester_working', alias: 'P1', kind: 'near_requester', distance: 'near', direction: 'right', insideView: [], related: 'none' }, landed: body.dto.landed, differs: true, ...(pref === 'on' ? { applied: true } : {}) }])
    assert.ok(!/c1|c2|run-7|run-6|thread-9/.test(JSON.stringify(body.dto)) && !/"x"|"rect"/.test(JSON.stringify(c.state.workPlacementLog)))
    assert.equal(c.log.listeners, 3, 'input is watched only once the flag is on'); c.note('result', placement, { runId: 'run-8' }); assert.equal(c.log.listeners, 3); assert.equal(c.log.posts.length, 1, 'without a conversation nothing is sent')
  }
})

// ================= 8. nudges, live vs advisory, and the pointer round trip on lane L3's REAL session heartbeat, after the run =================
test('nudge: a queued scene and a raised pointer ask the heartbeat for a beat now; advisory decides "point" but raises nothing', async () => {
  const d = desk(); const viewer = d.open(r(5300, 24, 720, 520)); d.tasks[0].state = 'finished'
  const att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer })
  const context = { request: REQUEST, answer: '검토했습니다. 단가 변경은 소유자 승인이 필요합니다.', egress: ALLOW }
  const b = beating(); const nudges = []; const real = b.hb.nudge.bind(b.hb); const hb = Object.create(b.hb, { nudge: { value: () => { const ok = real(); nudges.push(ok); return ok } } })
  const timers = []
  const live = createWorkPlacement({ client: judgeClient(), mode: () => 'on', enabled: () => true, live: () => true, contextFor: () => context, now: b.now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.at(-1) } })
  assert.equal(live.submit('dm', att.dto, hb).status, 'queued'); assert.deepEqual(nudges, [true], 'queued: the judgment does not wait for the grid')
  b.beat(); await live.idle()
  assert.deepEqual(live.facts('dm'), { placementsPending: 0, placementsDecided: 1, pointerPending: true, pointerWhere: 'right', pointerDistance: 'very_far', pointerFor: 'owner', pointerNeeds: 'owner_action' })
  assert.deepEqual(nudges, [true, false], 'the pointer\'s own nudge falls inside the same beat interval and is refused')
  assert.deepEqual(timers.map(x => x.ms), [5000], 'so it is tried once more, one beat interval later'); b.advance(5000); timers[0].fn(); assert.deepEqual(nudges, [true, false, true])
  assert.deepEqual(live.records().map(x => [x.kind, x.state, x.branch, x.would.kind, x.pointer]), [['attention', 'finished', 'owner', 'point', 'raised']])
  assert.equal(b.hb.acknowledge('work_placement', 'attention'), true); assert.equal(live.facts('dm').pointerPending, false)
  const prompt = pointerWriterPrompt({ pointerWhere: 'right', pointerDistance: 'very_far', pointerNeeds: 'owner_action' }); for (const piece of ['to the right of', 'far away', 'needs their decision', 'Nothing was moved into their view']) assert.ok(prompt.includes(piece), piece)
  // advisory (the default): the same decision is recorded as what it WOULD do; no fact, so no message can follow
  const a = beating(); const advisory = createWorkPlacement({ client: judgeClient(), mode: () => 'advisory', enabled: () => true, contextFor: () => context, now: a.now })
  advisory.submit('dm', att.dto, a.hb); a.beat(); await advisory.idle()
  assert.equal(advisory.facts('dm').pointerPending, false); assert.deepEqual(advisory.records().map(x => [x.would.kind, x.branch, x.pointer]), [['point', 'owner', 'advisory']])
})
const POINTER = '오른쪽 작업 구역에 결과가 있어요. 확인이 필요합니다.'
test('pointer round trip, post-run, on the real session heartbeat: finished task -> "needs the owner?" on its own request and answer -> pointer fact -> ONE message to the owner -> acknowledged', async t => {
  // Real CodexChatRuntime with lane L3's session heartbeat and conversation flow (their fixture: mock engine, mock decision model, virtual clock); the run's
  // request and answer come from the runtime's own placementContextFor. The placement runtime is this lane's real module.
  const people = [{ member: 'self', self: true, active: true, lastInputAgeMs: 2000 }, { member: 'm-jin', active: false }]
  const audience = { 'dm-task': { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, 'dm-owner': { requester: 'self', owner: 'self', participants: ['self'] } }
  const acks = []; let placement
  const w = world(t, { presence: { snapshot: () => people }, audience: ({ run }) => audience[run.clientThreadId] ?? null, policy: { message: values => (values.includes('pointer') ? 'pointer' : 'none') },
    writer: prompt => (/on the desk/.test(prompt) ? POINTER : null), attentionPosted: e => { acks.push(e); if (e.provider === 'work_placement') placement.acknowledgePointer(e.key) } }) // the bridge's own wiring (codex-bridge-server.mjs)
  const client = judgeClient()
  placement = createWorkPlacement({ client, mode: () => 'on', enabled: () => true, live: () => true, contextFor: (key, o) => w.chat.placementContextFor(key, o), now: () => w.at(), setTimer: (fn, ms) => w.chat.setTimer(fn, ms) })
  const o = await w.dm('dm-owner', '예산표 정리해 주세요'); await w.advance(3000); await o.final('예산표를 정리했습니다.')
  const m = await w.dm('dm-task', '분기 보고서 초안을 만들어 주세요'); await w.advance(4000); await m.final('보고서 초안을 만들었습니다. 외부에 보내기 전에 소유자 승인이 필요합니다.')
  const hb = w.chat.heartbeatFor('dm-task')
  assert.deepEqual([hb.state, hb.tempo], ['running', 'idle'], 'the run is over and the session heartbeat is still there')
  const ctx = w.chat.placementContextFor('dm-task')
  assert.deepEqual([ctx.request, ctx.answer], ['분기 보고서 초안을 만들어 주세요', '보고서 초안을 만들었습니다. 외부에 보내기 전에 소유자 승인이 필요합니다.'], 'the run\'s own request and posted answer')
  assert.deepEqual([ctx.egress.allows('run_text'), ctx.egress.allows('canvas_text'), w.chat.placementContextFor('dm-task', { canvasMaySend: true }).egress.allows('canvas_text')], [true, false, true], 'the run\'s own gate: card words only when the host marked a card maySend')
  assert.equal(w.chat.placementContextFor('nobody'), null)
  const d = desk(); const viewer = d.open(r(5300, 24, 720, 520)); d.tasks[0].state = 'finished'
  const canvas = d.snapshot(), att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer })
  const eventsBefore = w.events.length, beatsBefore = w.beatRequests.length
  assert.equal(placement.submit('dm-task', att.dto, hb).status, 'queued')
  await w.advance(HEARTBEAT_LIMITS.nudgeMs)
  assert.equal(client.calls.length, 1, 'judged within half a second of the submit, not at the 20 s idle grid')
  assert.deepEqual(hb.facts().sources.work_placement, { placementsPending: 0, placementsDecided: 1, pointerPending: true, pointerWhere: 'right', pointerDistance: 'very_far', pointerFor: 'owner', pointerNeeds: 'owner_action' })
  assert.deepEqual(o.assistant(), ['예산표를 정리했습니다.'], 'not yet: the second nudge was refused')
  await w.advance(WORK_PLACEMENT_LIMITS.renudgeMs + HEARTBEAT_LIMITS.nudgeMs)
  assert.deepEqual(o.assistant(), ['예산표를 정리했습니다.', POINTER], 'ONE completed message, in the owner\'s own conversation, about 6 s after the submit')
  assert.deepEqual(m.assistant(), ['보고서 초안을 만들었습니다. 외부에 보내기 전에 소유자 승인이 필요합니다.'], 'nothing in the member\'s conversation')
  assert.deepEqual(acks, [{ key: 'dm-task', provider: 'work_placement' }]); assert.equal(placement.facts('dm-task').pointerPending, false, 'acknowledged: the fact is withdrawn')
  assert.equal(hb.facts().sources.work_placement.pointerPending, false)
  // what each model saw. The placement judgment (L1 c12) read THIS task's own request and answer (its run's text, through its run's gate) and nothing of the
  // owner's other conversation. L3 c16: a decision the owner must make needs them by definition, the owner is present, it is not in view, and nothing was
  // posted to them since the task began: every precondition is code, so the pointer is posted with no heartbeat request at all. The writer was told where
  // in fixed words and saw no task text. No member id, card id or coordinate anywhere.
  const judged = JSON.stringify(client.calls[0]), prompt = w.forkPrompts.at(-1)
  assert.match(judged, /분기 보고서 초안을 만들어 주세요/); assert.match(judged, /소유자 승인이 필요합니다/)
  assert.equal(w.beatRequests.length, beatsBefore, 'no heartbeat request for this pointer')
  assert.match(prompt, /to the right of what they are looking at on the desk/)
  assert.doesNotMatch(judged, /m-jin|acct-|예산표|own-doc|5300|"x"/)
  for (const text of [prompt, ...w.beatRequests.map(r => r.input.join('\n'))]) assert.doesNotMatch(text, /m-jin|acct-|보고서|예산표|own-doc|5300|"x"/)
  // nothing moved: the canvas is as it was, and the only events are the message's own
  assert.equal(d.snapshot(), canvas); assert.deepEqual([...new Set(w.events.slice(eventsBefore).map(e => `${e.clientThreadId}:${e.event}`))], ['dm-owner:message.started', 'dm-owner:message.delta', 'dm-owner:message.completed'])
  await w.advance(60_000)
  assert.deepEqual([client.calls.length, w.requests.flow, o.assistant().length, m.assistant().length], [1, 0, 2, 1], 'L3 c16: the pointer took no heartbeat request (all its preconditions are code)')
})

// ================= 9. window "on" (L1 c13, U7): the new surface opens at the rule's spot; no camera move, no focus, no one's view, no card moved, no Board =================
// The surface's own functions (resolveCanvasCardPlacement, the hook, workPresence, revealPlacedCanvasCard) run over a synthetic canvas: real
// SurfaceState placement, real placement runtime, plain objects for cards, regions and the camera, spies for every camera and focus call.
function windowRig({ pref, people, cards = [], regions = [] }) {
  const calls = { camera: [], timers: 0, posts: [], prefs: 0 }
  const node = (id, rect, extra = {}) => ({ id, isConnected: true, dataset: {}, _rect: rect, ...extra })
  const cardNodes = cards.map(c => node(c.id, c.rect)), regionNodes = regions.map((rect, i) => node(`region-${i}`, rect))
  const view = people.find(p => p.self).viewport
  const state = { activeEntityId: 'own-doc', panTarget: { x: 0, y: 0 }, zoomTarget: 1, agenda: {}, surface: {}, presence: { snapshot: () => people.map(p => ({ ...p, viewport: { ...p.viewport } })) },
    setCanvasPanTarget: t => calls.camera.push(['pan', t]), setCanvasViewportTarget: t => calls.camera.push(['viewport', t]) }
  const deps = { WorkPlacement: WP, SurfaceState, state, readSurfacePref: () => { calls.prefs++; return pref },
    document: { querySelectorAll: sel => (sel === '.egd-canvas-card' ? cardNodes : sel.includes('.egd-board-region') ? (sel.includes('.egd-canvas-card') ? [...cardNodes, ...regionNodes] : regionNodes) : []) },
    window: { addEventListener() {}, setTimeout: () => { calls.timers++; return 1 } }, persistentEntityGeometry: n => ({ ...n._rect, zIndex: 1 }), cardKindForPersistence: () => 'file',
    safeViewportWorldRect: () => ({ left: view.x, top: view.y, right: view.x + view.width, bottom: view.y + view.height }), viewportToCanvasPoint: (x, y) => ({ x, y }),
    safeViewportRect: () => ({ left: 0, top: 0, right: view.width, bottom: view.height }), deskStoreRequest: async (m, p, body) => { calls.posts.push(body); return { status: 200, body: {} } } }
  const body = `let workInputAt = null, workInputWatch = false;\n${decl('workPresence')}\n${decl('workSceneInputs')}\n${decl('noteWorkSurfacePlacement')}\nstate.noteWorkSurfacePlacement = noteWorkSurfacePlacement;\n${decl('resolveCanvasCardPlacement')}\n${decl('revealPlacedCanvasCard')}\nreturn { resolveCanvasCardPlacement, revealPlacedCanvasCard };`
  return { ...new Function(...Object.keys(deps), body)(...Object.values(deps)), calls, state }
}
const OWNER = { member: 'self', self: true, active: true, viewport: r(0, 0, 1200, 800), focusCard: 'own-doc', lastInputAgeMs: 400 }
test('window on: a run\'s file viewer opens at the rule\'s spot, quiet: no camera call, no timer for a reveal, no activation; today\'s placement otherwise', () => {
  const ownCards = [{ id: 'own-doc', rect: r(100, 100, 500, 400) }, { id: 'own-note', rect: r(650, 120, 300, 220) }]
  const work = { workSurface: { kind: 'file', runId: 'run-7', conversationId: 'thread-9' } }
  const off = windowRig({ pref: undefined, people: [OWNER], cards: ownCards }); const today = off.resolveCanvasCardPlacement('file', work)
  const adv = windowRig({ pref: 'advisory', people: [OWNER], cards: ownCards }); assert.deepEqual(adv.resolveCanvasCardPlacement('file', work), today, 'advisory: exactly today\'s placement')
  const on = windowRig({ pref: 'on', people: [OWNER], cards: ownCards }); const spot = on.resolveCanvasCardPlacement('file', work)
  assert.deepEqual([spot.quiet, spot.inView, spot.width, spot.height], [true, false, today.width, today.height]); assert.notDeepEqual([spot.x, spot.y], [today.x, today.y])
  assert.ok(!hits(spot, OWNER.viewport) && !ownCards.some(c => hits(c.rect, spot)), 'beside my view (I am typing), covering none of my cards')
  // the surface's reveal would pan the camera to an off-view card; a quiet placement is never revealed
  on.revealPlacedCanvasCard({ isConnected: true }, spot); assert.deepEqual([on.calls.camera, on.calls.timers], [[], 0], 'no camera move scheduled or made')
  off.revealPlacedCanvasCard({ isConnected: true }, { ...spot, quiet: undefined }); assert.equal(off.calls.timers, 1, 'the same off-view spot without "quiet" WOULD be revealed: the check is real')
  assert.deepEqual(on.state.activeEntityId, 'own-doc', 'the hook takes no focus')
  // the callers open it without activating it: result cards and run file viewers pass activate: false for a quiet placement
  assert.match(surface, /spawnDeskWindowShell\(\{ id: `egd-result-card-\$\{\+\+cardSeq\}`, kind: 'result', className: 'egd-result-card', sourceRef, \.\.\.\(placement\.quiet \? \{ activate: false \} : \{\}\),/)
  const fileCard = readFileSync(new URL('../overlay/resources/surface/EGDeskSurfaceFileCard.mjs', import.meta.url), 'utf8')
  assert.match(fileCard, /activate: !options\.restore && !options\.deferPresentation && !placement\.quiet,/)
  assert.match(decl('revealPlacedCanvasCard'), /if \(!card \|\| !placement \|\| placement\.inView \|\| placement\.quiet\) return;/)
  assert.match(surface, /if \(options\.activate !== false\) setActiveEntity\(root\);/, 'the shell activates only when not told otherwise')
})
test('window on: never inside another active person\'s view; an unknown requester\'s surface protects every view; no Board region, no shared ledger; a failure keeps today\'s placement', () => {
  const member = { member: 'm-0123456789abcdef', self: false, active: true, viewport: r(1260, 0, 1200, 800), focusCard: null, lastInputAgeMs: 900 }
  const regions = [r(1250, 900, 1400, 900)]
  const on = windowRig({ pref: 'on', people: [OWNER, member], regions })
  for (const requester of [undefined, member.member, 'm-ffffffffffffffff']) {
    const spot = on.resolveCanvasCardPlacement('file', { workSurface: { kind: 'file', runId: 'run-7', conversationId: 'thread-9', ...(requester ? { requester } : {}) } })
    assert.equal(spot.quiet, true, String(requester))
    if (requester !== member.member) assert.ok(!hits(spot, member.viewport), `${requester}: not where the other member is looking`)
    if (requester !== undefined) assert.ok(!hits(spot, OWNER.viewport), `${requester}: a member's or an unknown requester's surface never opens in the owner's view`)
    for (const region of regions) assert.ok(!hits(spot, { x: region.x - 24, y: region.y - 24, width: region.width + 48, height: region.height + 48 }), 'never in or against a Board region: a private placement does not join a shared Board')
  }
  // nothing in the hook or the placement runtime can write a Board or move a card
  const hook = decl('noteWorkSurfacePlacement') + decl('workSceneInputs') + decl('placeWorkSurface') // L1 c15: the shared scene reader and the bounded wait too
  for (const forbidden of ['jointDesk', 'saveBoard', 'boardLedger', 'persistBoard', 'setCanvasPanTarget', 'setCanvasViewportTarget', 'setActiveEntity', '.focus(', 'style.left', 'style.top']) assert.ok(!hook.includes(forbidden), forbidden)
  // the runtime cannot answer: today's placement stands, the surface still opens
  const broken = windowRig({ pref: 'on', people: [OWNER] }); broken.state.presence = { snapshot: () => { throw new Error('presence down') } }
  const kept = broken.resolveCanvasCardPlacement('file', { workSurface: { kind: 'file', runId: 'run-7' } }), today = windowRig({ pref: undefined, people: [OWNER] }).resolveCanvasCardPlacement('file', { workSurface: { kind: 'file', runId: 'run-7' } })
  assert.deepEqual(kept, today)
  assert.equal(WP.onRuleSpot({ spot: null }, today, OWNER.viewport), null, 'reuse: nothing new to place'); assert.equal(WP.onRuleSpot({ spot: { x: 0, y: 0, width: 10, height: 10 } }, today, OWNER.viewport), null, 'a spot of another size is not used')
})

test('isolation (L1 c13, measured v2: one answer for every card of a request): one card per question by default; one card per request when chosen; both bounded', async () => {
  const d = desk(); d.cards.push(...RELATED); const dto = normalizePlacementDto(WP.placementRequest(d.scene(), { taskId: 'run-1', surface: FILE }).dto)
  assert.deepEqual(PLACEMENT_ISOLATION, ['question', 'request'])
  const [byQuestion] = placementRequests(dto, { request: REQUEST }), byRequest = placementRequests(dto, { request: REQUEST }, { isolation: 'request' })
  assert.equal(byRequest.length, 2); for (const [i, one] of byRequest.entries()) { assert.deepEqual(one.questions, [byQuestion.questions[i]]); assert.deepEqual(one.input, byQuestion.input, 'the same shared input: the request only') }
  // sent together, answers combined by code, every request counted against the heartbeat's cap
  const client = judgeClient(); const split = bridge(client, { isolation: 'request' })
  const placed = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: FILE }, judge: split.judge })
  assert.deepEqual([placed.option.kind, placed.option.cardId, client.calls.length, client.calls.map(c => c.questions.length)], ['beside_related', 'res-quote-v1', 2, [1, 1]])
  const capped = bridge(judgeClient(), { isolation: 'request', limits: { maxEvals: 3 } })
  for (let i = 0; i < 2; i++) { capped.placement.submit('dm', dto, capped.hb); capped.beat(); await capped.placement.idle() }
  assert.deepEqual(capped.placement.records().map(x => x.source), ['decision', 'limit'], 'two requests fit the cap of three, the next two would not: the code\'s outcome stands')
  // one failing request fails the judgment whole: the rule's spot stands
  let n = 0; const flaky = { model: 'mock', async decide(req) { if (++n === 2) throw Object.assign(new Error('x'), { code: 'timeout' }); return judgeClient().decide(req) } }
  const half = bridge(flaky, { isolation: 'request' }); const s1 = half.placement.submit('dm', dto, half.hb); half.beat(); await half.placement.idle()
  assert.deepEqual([half.placement.result('dm', s1.id).source, half.placement.result('dm', s1.id).kind], ['failed', 'near_requester'])
  // the token cost of each, from the bytes the product builds (the runner's typed model)
  const est = rs => rs.reduce((sum, q) => sum + Math.round(134.8 * q.questions.length + 0.1983 * Buffer.byteLength(JSON.stringify({ model: 'm', input: q.input, questions: q.questions }))), 0)
  assert.ok(est(byRequest) > est([byQuestion]), `one card per request costs more: ${est(byRequest)} vs ${est([byQuestion])}`)
})

// ================= 10. window "on", a surface that can wait (L1 c15): a bounded wait for the content answer before it opens =================
function waitRig({ pref = 'on', people = [OWNER], cards = [], regions = [], bridge = {}, extraDeps = {}, extraBody = '' } = {}) {
  const calls = { posts: [], polls: 0, camera: 0 }, clock = { now: 0 }
  const node = (id, rect, extra = {}) => ({ id, isConnected: true, dataset: {}, _rect: rect, ...extra })
  const cardNodes = cards.map(c => node(c.id, c.rect, c.record ? { _resultRecord: c.record } : {})), regionNodes = regions.map((rect, i) => node(`region-${i}`, rect))
  const view = people.find(p => p.self).viewport
  const state = { activeEntityId: 'own-doc', panTarget: { x: 0, y: 0 }, zoomTarget: 1, agenda: {}, surface: {}, presence: { snapshot: () => people.map(p => ({ ...p, viewport: { ...p.viewport } })) },
    setCanvasPanTarget: () => { calls.camera++ }, setCanvasViewportTarget: () => { calls.camera++ } }
  const deskStoreRequest = async (method, p, body) => {
    if (p === '/decision/work-placement/request') { calls.posts.push(body); return { status: 200, body: bridge.queued ?? { status: 'queued', id: 'wp-1' } } }
    if (p === '/decision/work-placement/result') { calls.polls++; const next = typeof bridge.result === 'function' ? bridge.result(calls.polls, clock.now) : { status: 'pending' }; return { status: 200, body: next } }
    return { status: 404, body: null }
  }
  const deps = { WorkPlacement: WP, SurfaceState, state, readSurfacePref: () => pref,
    document: { querySelectorAll: sel => (sel === '.egd-canvas-card' ? cardNodes : sel.includes('.egd-board-region') ? (sel.includes('.egd-canvas-card') ? [...cardNodes, ...regionNodes] : regionNodes) : []) },
    window: { addEventListener() {}, setTimeout: () => 1 }, persistentEntityGeometry: n => ({ ...n._rect, zIndex: 1 }), cardKindForPersistence: () => 'result',
    safeViewportWorldRect: () => ({ left: view.x, top: view.y, right: view.x + view.width, bottom: view.y + view.height }), viewportToCanvasPoint: (x, y) => ({ x, y }),
    safeViewportRect: () => ({ left: 0, top: 0, right: view.width, bottom: view.height }), deskStoreRequest,
    workWaitNow: () => clock.now, workWaitSleep: async ms => { clock.now += ms }, ...extraDeps }
  const body = `let workInputAt = null, workInputWatch = false;\n${decl('workPresence')}\n${decl('workSceneInputs')}\n${decl('noteWorkSurfacePlacement')}\nstate.noteWorkSurfacePlacement = noteWorkSurfacePlacement;\n${decl('placeWorkSurface')}\n${decl('resolveCanvasCardPlacement')}\n${extraBody}\nreturn { placeWorkSurface, resolveCanvasCardPlacement, ...(typeof extraOut === 'object' ? extraOut : {}) };`
  return { ...new Function(...Object.keys(deps), body)(...Object.values(deps)), calls, clock, state }
}
const MEMBER_B = { member: 'm-0123456789abcdef', self: false, active: true, viewport: r(2400, 200, 1200, 800), focusCard: null, lastInputAgeMs: 900 }
const QUOTE_V1 = { id: 'res-v1', rect: r(3700, 1150, 400, 300), record: { title: 'A사 견적서 v1 단가표', text: '단가 12,000원', provenance: { creator: 'agent', runId: 'run-0' } } }
const WORK = { kind: 'file', runId: 'run-7', conversationId: 'thread-9', requester: MEMBER_B.member }
test('bounded wait: only with the pref "on", only with a conversation; with nothing to ask it posts once and opens at the rule\'s spot without polling', async () => {
  for (const pref of ['advisory', null, 'off']) { const rig = waitRig({ pref, people: [OWNER, MEMBER_B], cards: [QUOTE_V1] }); assert.equal(await rig.placeWorkSurface('file', WORK), null, String(pref)); assert.equal(rig.calls.posts.length, 0) }
  const lonely = waitRig({ people: [OWNER, MEMBER_B], cards: [QUOTE_V1] }); assert.equal(await lonely.placeWorkSurface('file', { kind: 'file', runId: 'run-7' }), null, 'no conversation: the usual path')
  const plain = waitRig({ people: [OWNER, MEMBER_B] })
  const spot = await plain.placeWorkSurface('file', WORK)
  assert.deepEqual([spot.quiet, plain.calls.posts.length, plain.calls.polls, plain.clock.now], [true, 1, 0, 0], 'no card may be asked about: posted for the record, no wait at all')
  assert.ok(!hits(spot, OWNER.viewport) && !hits(spot, MEMBER_B.viewport) && gapTo(spot, MEMBER_B.viewport) < 900, 'the rule\'s spot, beside B\'s view')
  assert.equal(plain.calls.posts[0].dto.rule, 'requester_working')
})
test('bounded wait: a timely "same matter" opens it beside that card; "pending" past 1.5 s opens it at the rule\'s spot and reads nothing after the deadline; "unknown" stops at once', async () => {
  const timely = waitRig({ people: [OWNER, MEMBER_B], cards: [QUOTE_V1], bridge: { result: n => (n < 3 ? { status: 'pending' } : { status: 'decided', kind: 'beside_related', related: 'R1', source: 'decision' }) } })
  const beside = await timely.placeWorkSurface('file', WORK)
  assert.equal(timely.calls.polls, 3); assert.ok(timely.clock.now <= WP.WORK_PLACEMENT_WAIT_MS)
  assert.ok(gapTo(beside, QUOTE_V1.rect) <= 25 && !hits(beside, OWNER.viewport) && !hits(beside, MEMBER_B.viewport) && beside.quiet, 'beside the v1 quote card, quietly')
  const late = waitRig({ people: [OWNER, MEMBER_B], cards: [QUOTE_V1], bridge: { result: (n, now) => (now >= WP.WORK_PLACEMENT_WAIT_MS ? { status: 'decided', kind: 'beside_related', related: 'R1' } : { status: 'pending' }) } })
  const ruled = await late.placeWorkSurface('file', WORK)
  assert.equal(late.clock.now, WP.WORK_PLACEMENT_WAIT_MS, 'waited exactly the bound'); assert.equal(late.calls.polls, WP.WORK_PLACEMENT_WAIT_MS / WP.WORK_PLACEMENT_POLL_MS - 1, 'no read at or after the deadline')
  assert.ok(gapTo(ruled, QUOTE_V1.rect) > 25 && gapTo(ruled, MEMBER_B.viewport) < 900 && ruled.quiet, 'the rule\'s spot: the late answer is not acted on')
  assert.equal(late.calls.camera, 0)
  const gone = waitRig({ people: [OWNER, MEMBER_B], cards: [QUOTE_V1], bridge: { result: () => ({ status: 'unknown' }) } })
  await gone.placeWorkSurface('file', WORK); assert.deepEqual([gone.calls.polls, gone.clock.now], [1, WP.WORK_PLACEMENT_POLL_MS])
  const refused = waitRig({ people: [OWNER, MEMBER_B], cards: [QUOTE_V1], bridge: { queued: { status: 'no-heartbeat' } } })
  const kept = await refused.placeWorkSurface('file', WORK); assert.deepEqual([refused.calls.polls, kept.quiet], [0, true], 'not queued: no wait, the rule\'s spot')
})
test('bounded wait: an answer that would now put it in the owner\'s view is re-checked away; the file viewer path waits, then opens without the hook a second time', async () => {
  // the owner panned over the v1 card while the answer was out: beside it is now inside the owner's view, so the fresh rule's spot is used
  const people = [{ ...OWNER }, MEMBER_B]
  const rig = waitRig({ people, cards: [QUOTE_V1], bridge: { result: n => { if (n === 2) people[0].viewport = r(3500, 900, 1400, 900); return n < 2 ? { status: 'pending' } : { status: 'decided', kind: 'beside_related', related: 'R1' } } } })
  const spot = await rig.placeWorkSurface('file', WORK)
  assert.ok(!hits(spot, people[0].viewport), 'not where the owner now looks'); assert.ok(spot.quiet)
  // the run file viewer: openVerifiedRunFile waits first; spawnFileCard then uses that placement and does not call the hook again (one request)
  const zone = readFileSync(new URL('../overlay/resources/surface/EGDeskSurfaceFileCard.mjs', import.meta.url), 'utf8')
  assert.match(zone, /workPlacement = \(await state\.placeWorkSurface\?\.\('file', \{ kind: 'file', runId: selected\.runId, conversationId: selected\.conversationId \}\)\) \?\? null;[^\n]*\n    if \(!current\(\)\) return \{ status: 'stale' \};\n    verifiedRunOpens\.add\(opening\);\n    const card = spawnFileCard\(\{ openMode: 'new', verifiedRunOpen: opening, workPlacement \}\);/)
  assert.match(zone, /const placement = \(runFile && options\.workPlacement\) \|\| resolveCanvasCardPlacement\('file', runFile \?/)
  assert.match(zone, /activate: !options\.restore && !options\.deferPresentation && !placement\.quiet,/, 'opened without focus')
  assert.equal(WP.WORK_PLACEMENT_WAIT_MS, 1500, 'the default Decision deadline')
})

// ================= 11. result cards wait under the same bounded rule (L1 c16, Main's position 3) =================
// The real ChatState builds the record; the window's real openAnswerResultCard, resultCardPlacement and placeWorkSurface run; spawnResultCard is recorded.
const ANSWER_THREAD = { id: 'thread-9', title: 'A사 견적', conversationId: 'thread-9', messages: [] }
const ANSWER_MESSAGE = { id: 'msg-7', role: 'assistant', status: 'completed', conversationId: 'thread-9', runId: 'run-7', answerId: 'thread-9/run-7', createdAt: 1_700_000_000_000,
  content: 'v2는 v1보다 단가가 12,000원에서 11,000원으로 낮습니다. 이 단가 인하를 소유자께서 승인해 주셔야 합니다.' }
function resultRig(options = {}) {
  const spawned = [], open = new Set(), notices = []
  const extraDeps = { ChatState, codexMessageAuthorLabel: () => '분석 담당', boardNotice: text => notices.push(text),
    makeSourceRef: (kind, fields) => `${kind}:${fields.scope}:${fields.id}`, findOpenCardBySourceRef: ref => (open.has(ref) ? { ref } : null),
    spawnResultCard: o => { spawned.push(o); return { id: 'card', placement: o.workPlacement ?? null } } }
  const extraBody = `const resultCardWaits = new Map();\n${decl('resultCardPlacement')}\nstate.resultCardPlacement = resultCardPlacement;\n${decl('openAnswerResultCard')}\nconst extraOut = { openAnswerResultCard, resultCardPlacement };`
  return { ...waitRig({ ...options, extraDeps, extraBody }), spawned, open, notices }
}
test('result card wait: unless the pref is "on" nothing waits: the card opens at once, synchronously, with today\'s placement; an answer whose card is open waits for nothing', () => {
  for (const pref of ['advisory', null, 'off']) {
    const rig = resultRig({ pref, people: [OWNER, MEMBER_B], cards: [QUOTE_V1] })
    const card = rig.openAnswerResultCard(ANSWER_THREAD, ANSWER_MESSAGE, { opener: null })
    assert.deepEqual(card, { id: 'card', placement: null }, `${pref}: not a promise, opened now`)
    assert.equal(rig.spawned.length, 1); assert.ok(!('workPlacement' in rig.spawned[0])); assert.equal(rig.calls.posts.length, 0)
  }
  const rig = resultRig({ people: [OWNER, MEMBER_B], cards: [QUOTE_V1] })
  rig.open.add(`chat-answer:codex-answer:${ChatState.resultCardKey(ChatState.resultCardRecord(ANSWER_THREAD, ANSWER_MESSAGE))}`)
  assert.deepEqual(rig.openAnswerResultCard(ANSWER_THREAD, ANSWER_MESSAGE), { id: 'card', placement: null }, 'already open: brought back at once (spawnResultCard), no wait')
  assert.equal(rig.calls.posts.length, 0)
  assert.equal(rig.openAnswerResultCard(ANSWER_THREAD, { ...ANSWER_MESSAGE, status: 'streaming' }), null); assert.match(rig.notices[0], /아직 카드로 만들 수 없습니다/)
})
test('result card wait: pref "on" -> the card opens only after the bounded wait; a timely "same matter" puts it beside that card, quietly; a second press shares the wait (one request)', async () => {
  const rig = resultRig({ people: [OWNER, MEMBER_B], cards: [QUOTE_V1], bridge: { result: n => (n < 3 ? { status: 'pending' } : { status: 'decided', kind: 'beside_related', related: 'R1', source: 'decision' }) } })
  const first = rig.openAnswerResultCard(ANSWER_THREAD, ANSWER_MESSAGE), again = rig.openAnswerResultCard(ANSWER_THREAD, ANSWER_MESSAGE)
  assert.ok(first instanceof Promise && again instanceof Promise); assert.equal(rig.spawned.length, 0, 'nothing opens before the answer or the deadline')
  await Promise.all([first, again])
  assert.equal(rig.calls.posts.length, 1, 'one placement request for both presses'); assert.equal(rig.calls.posts[0].clientThreadId, 'thread-9')
  assert.equal(rig.calls.posts[0].dto.surface, 'result')
  const placed = rig.spawned[0].workPlacement
  assert.ok(gapTo(placed, QUOTE_V1.rect) <= 25 && !hits(placed, OWNER.viewport) && !hits(placed, MEMBER_B.viewport) && placed.quiet, 'beside the v1 quote card, outside both views, quiet')
  assert.ok(rig.clock.now <= WP.WORK_PLACEMENT_WAIT_MS); assert.equal(rig.calls.camera, 0)
  assert.deepEqual(rig.state.workPlacementLog.at(-1), { surface: 'result', waited: true, decided: 'beside_related', opened: 'beside_related', source: 'decision', applied: true })
})
test('result card wait: the answer comes after 1.5 s -> the card opens at the rule\'s spot at the deadline; the late answer is only recorded by the bridge; nothing reads it and nothing moves', async () => {
  const rig = resultRig({ people: [OWNER, MEMBER_B], cards: [QUOTE_V1], bridge: { result: () => ({ status: 'pending' }) } })
  const card = await rig.openAnswerResultCard(ANSWER_THREAD, ANSWER_MESSAGE)
  assert.equal(rig.clock.now, WP.WORK_PLACEMENT_WAIT_MS, 'waited exactly the bound')
  assert.equal(rig.calls.polls, WP.WORK_PLACEMENT_WAIT_MS / WP.WORK_PLACEMENT_POLL_MS - 1, 'no read at or after the deadline')
  const placed = rig.spawned[0].workPlacement
  assert.ok(gapTo(placed, QUOTE_V1.rect) > 25 && gapTo(placed, MEMBER_B.viewport) < 900 && placed.quiet && !hits(placed, OWNER.viewport), 'the rule\'s spot beside B\'s view')
  assert.deepEqual(rig.state.workPlacementLog.at(-1), { surface: 'result', waited: true, decided: null, opened: 'near_requester', source: 'rule', applied: true })
  // the bridge answers late: the real placement runtime judges the very request the window posted and records "beside_related"
  const b = bridge(judgeClient())
  const s = b.placement.submit('dm', rig.calls.posts[0].dto, b.hb); assert.equal(s.status, 'queued'); b.beat(); await b.placement.idle()
  const record = b.placement.result('dm', s.id)
  assert.equal(record.status, 'decided'); assert.equal(record.kind, 'beside_related', 'recorded')
  // ...and nothing in the window acts on it: no more reads, the one card is where it opened, no camera move
  const before = { polls: rig.calls.polls, spawned: rig.spawned.length, rect: { ...card.placement } }
  rig.clock.now += 10_000
  assert.deepEqual({ polls: rig.calls.polls, spawned: rig.spawned.length, rect: { ...card.placement } }, before); assert.equal(rig.calls.camera, 0)
})
test('result card wait: the press, the published-result chip and spawnResultCard use the waited placement; restore never waits; opened without focus', () => {
  assert.match(decl('openAnswerResultCard'), /state\.resultCardPlacement\(record\) : null;\n    return waiting \? waiting\.then\(open, \(\) => open\(null\)\) : open\(null\);/)
  assert.match(surface, /const waiting = record \? \(state\.resultCardPlacement\?\.\(record\) \?\? null\) : null;\n        const workPlacement = waiting \? \(\(await waiting\.catch\(\(\) => null\)\) \?\? null\) : null;\n        return record \? spawnResultCard\(\{ record, opener: options\.opener \|\| null, \.\.\.\(workPlacement \? \{ workPlacement \} : \{\}\) \}\) : null;/)
  const spawn = decl('spawnResultCard')
  assert.match(spawn, /const placement = \(!options\.restore && options\.workPlacement\) \|\| resolveCanvasCardPlacement\('result', options\.restore \? \{\} :/)
  assert.match(spawn, /\.\.\.\(placement\.quiet \? \{ activate: false \} : \{\}\)/)
  assert.match(decl('resultCardPlacement'), /WorkPlacement\.workPlacementMode\(readSurfacePref\(WorkPlacement\.WORK_PLACEMENT_PREF\)\) !== 'on'\) return null;/)
})
