// L4 cycle 12: which task's work surface goes into which active user's which screen.
// The canvas runtime (EGDeskWorkPlacement.sys.mjs) enumerates members, tasks, occupied/free regions and the placement OPTIONS by code, under the hard rules;
// the Decision model (a mock client here) picks among option aliases at a beat of the REAL heartbeat (egdesk-heartbeat.mjs, virtual timers), through the judge
// half (egdesk-work-placement.mjs) and the shared egress gate; attention is re-judged when the flow changes and becomes a closed fact on the heartbeat.
// Synthetic: the canvas is a plain model (cards, one camera, one focus) and presence is a mock of the multi-user provider interface. No network, no DOM.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { HEARTBEAT_LIMITS, createHeartbeat } from './egdesk-heartbeat.mjs'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'
import { createEgressGate, EGRESS_KINDS, EGRESS_SITES, modelDataPermissions } from './egdesk-decision-egress.mjs'
import { WORK_PLACEMENT_LIMITS, createWorkPlacement, createWorkPlacementHttpHandler, normalizePlacementDto, placementQuestion, pointerWriterPrompt, readPlacement } from './egdesk-work-placement.mjs'
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'

const r = (x, y, width, height) => ({ x, y, width, height })
const A = r(0, 0, 1200, 800), B = r(4000, 0, 1200, 800)   // region A: the owner's view; region B: the invited member's view
const FILE = { kind: 'file', size: { width: 720, height: 520 } }
const hits = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const gapTo = (a, b) => Math.hypot(Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)), Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)))

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
// ---- the real heartbeat on a virtual clock ----
function beating(key = 'dm') {
  let clock = 0; const timers = []
  const hb = createHeartbeat({ key, monotonicNow: () => clock, setTimer: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t }, clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) } })
  hb.start()
  const beat = () => { timers.sort((a, b) => a.at - b.at); const t = timers.shift(); if (!t) return false; clock = Math.max(clock, t.at); t.fn(); return true }
  return { hb, beat, now: () => clock, advance: ms => { clock += ms } }
}
// ---- a Decisions client that prefers a kind of option, by reading only the closed descriptions it was sent ----
function judgeClient(prefer, { p = .93, fail = null } = {}) {
  const calls = []
  const WORDS = { near_requester: 'just outside the requester', quiet: 'away from everyone', adjacent_area: 'empty work area', reuse: 'already open', beside_related: 'next to a card', in_requester_view: 'inside the requester\'s own view',
    leave: 'say nothing', point: 'tell the member', surface_near_requester: 'move the card' }
  return { calls, model: 'mock', async decide(request) {
    calls.push(request)
    if (fail) throw Object.assign(new Error(fail), { code: fail })
    const q = request.questions[0], order = typeof prefer === 'function' ? prefer(q) : prefer
    const hit = order.map(kind => q.choices.find(c => c.description.includes(WORDS[kind]))).find(Boolean) ?? q.choices[0]
    const other = q.choices.find(c => c !== hit)
    return { answers: { [q.name]: { type: 'choice', choice: hit.value, confidence: p, probabilities: [{ value: hit.value, probability: p }, { value: other.value, probability: 1 - p }] } }, usage: { inputTokens: 9 } }
  } }
}
function bridge(client, extra = {}) {
  const b = beating(); const log = []
  const placement = createWorkPlacement({ client, mode: () => 'advisory', enabled: () => true, live: () => true, calibrationLog: { record: e => log.push(e) }, now: b.now, setTimer: () => null, ...extra })
  // the chrome's judge: queue the closed request, let the heartbeat beat once, read the choice
  const judge = async dto => { const s = placement.submit('dm', dto, b.hb); if (s.status !== 'queued') return null; b.beat(); await placement.idle(); const res = placement.result('dm', s.id); return res.status === 'decided' ? res.choice : null }
  return { ...b, placement, judge, log }
}

// ================= 1. the runtime enumerates, by code =================
test('scene: active users and their views, tasks with requester and waiters, occupied and free regions; ids stay behind aliases', () => {
  const d = desk(); d.open(r(5300, 24, 720, 520))
  const s = d.scene()
  assert.deepEqual(s.members.map(m => [m.alias, m.self, m.active, m.idle]), [['M1', true, true, false], ['M2', false, true, false]])
  assert.deepEqual(s.tasks.map(t => [t.alias, t.state, t.requester, t.waiting, t.surfaces.length]), [['K1', 'running', 'M2', ['M2'], 1]])
  assert.equal(s.occupied.length, 4); assert.ok(s.freeFrames.length > 0 && s.freeFrames.every(f => !s.occupied.some(o => hits(o, f.rect)) && !hits(f.rect, A) && !hits(f.rect, B)), 'free frames are empty and outside every active view')
  assert.equal(s.cards.find(c => c.id === 'agent-1').taskId, 'run-1', 'a task\'s surface card is tied to its task')
  // presence rows that do not fit the interface are dropped; a second "self" is not believed
  const odd = WP.normalizePresence([{ member: 'a', self: true, active: true, viewport: A, lastInputAgeMs: 1 }, { member: 'b', self: true, active: true, viewport: B, lastInputAgeMs: 1 }, { member: 'c', viewport: { x: 0 } }, { member: 'a', viewport: A }, null])
  assert.deepEqual(odd.map(m => [m.member, m.self]), [['a', true], ['b', false]])
  const single = WP.createSingleUserPresence({ viewport: () => A, focusCard: () => 'own-doc', lastInputAt: () => 1000, now: () => 26_000 }).snapshot()
  assert.deepEqual(single, [{ member: 'self', self: true, active: true, viewport: A, focusCard: 'own-doc', lastInputAgeMs: 25_000 }], 'the single-user provider has the same shape')
  assert.deepEqual(WP.createSingleUserPresence({ viewport: () => null }).snapshot(), [])
})
test('options: each is a real rectangle that already passed the hard rules, described in closed words only', () => {
  const d = desk(); const s = d.scene()
  const options = WP.placementOptions(s, { taskId: 'run-1', surface: FILE })
  assert.deepEqual(options.map(o => o.kind), ['near_requester', 'quiet', 'adjacent_area'])
  for (const o of options) {
    assert.ok(WP.placementAllowed(s, o.rect, 'M2'), o.kind); assert.ok(!hits(o.rect, A), `${o.kind} is outside the owner's view`); assert.ok(!d.cards.some(c => hits(c.rect, o.rect)), `${o.kind} is free`)
    assert.deepEqual(Object.keys(o.descriptor).sort(), ['direction', 'distance', 'insideView', 'kind', 'related'])
  }
  const near = options.find(o => o.kind === 'near_requester'), quiet = options.find(o => o.kind === 'quiet')
  assert.ok(!hits(near.rect, B) && gapTo(near.rect, B) < WP.PLACEMENT_RULES.nearViews * 1200); assert.deepEqual([near.descriptor.distance, near.descriptor.direction, near.descriptor.insideView], ['near', 'right', []])
  assert.ok(gapTo(quiet.rect, B) >= .5 * 1200 && gapTo(quiet.rect, A) >= .5 * 1200, 'quiet is away from every active view')
  assert.equal(WP.defaultOption(options).kind, 'near_requester', 'the code\'s own pick is the requester\'s side, never inside a view')
  // into the requester's own view only when that requester waits and is idle
  d.people[1].lastInputAgeMs = 25_000
  const idle = WP.placementOptions(d.scene(), { taskId: 'run-1', surface: FILE }); const inView = idle.find(o => o.kind === 'in_requester_view')
  assert.ok(inView && hits(inView.rect, B) && !d.cards.some(c => hits(c.rect, inView.rect))); assert.equal(inView.descriptor.distance, 'in_view'); assert.deepEqual(inView.descriptor.insideView, ['M2'])
  assert.notEqual(WP.defaultOption(idle).kind, 'in_requester_view')
  // reuse and beside-related once the task has a card
  d.people[1].lastInputAgeMs = 900; const id = d.open(near.rect)
  const again = WP.placementOptions(d.scene(), { taskId: 'run-1', surface: { ...FILE, cardId: id } })
  assert.equal(again[0].kind, 'reuse'); assert.deepEqual(again[0].rect, near.rect); assert.equal(WP.defaultOption(again).kind, 'reuse')
  const second = WP.placementOptions(d.scene(), { taskId: 'run-1', surface: { kind: 'terminal', size: { width: 600, height: 380 } } })
  const beside = second.find(o => o.kind === 'beside_related'); assert.ok(beside && beside.descriptor.related === 'same_task' && gapTo(beside.rect, near.rect) <= 24 + 1 && WP.placementAllowed(d.scene(), beside.rect, 'M2'))
  assert.equal(WP.defaultOption(second).kind, 'beside_related', 'a task\'s surfaces gather')
})
test('the closed request: aliases, task words, option descriptors, the default and where it lands today; no id, title or coordinate', () => {
  const d = desk(); const req = WP.placementRequest(d.scene(), { taskId: 'run-1', surface: FILE }, { landed: r(24, 24, 720, 520) })
  assert.deepEqual(Object.keys(req.dto), ['kind', 'surface', 'members', 'task', 'options', 'default', 'landed'])
  assert.deepEqual(req.dto.task, { state: 'running', requester: 'M2', waiting: ['M2'], ownerMustAct: false })
  assert.deepEqual(req.dto.landed, { distance: 'far', direction: 'left', insideView: ['M1'] }, 'today it would open in the OWNER\'s view, far from the member who asked')
  const wire = JSON.stringify(req.dto); for (const bad of ['acct-', 'own-doc', 'b-board', 'run-1', '"x"', '"rect"', '4000', '5224']) assert.ok(!wire.includes(bad), bad)
  assert.ok(normalizePlacementDto(req.dto), 'the bridge accepts exactly this shape')
})

// ================= 2. hard rules are code, here and again on the bridge =================
test('hard rules: never inside another active user\'s view; no camera or focus API exists; user-made cards never move; the bridge re-checks from the descriptors', () => {
  const d = desk(); const s = d.scene()
  assert.equal(WP.placementAllowed(s, r(200, 600, 100, 100), 'M2'), false, 'inside the owner\'s view'); assert.equal(WP.placementAllowed(s, r(4700, 550, 300, 200), 'M2'), true, 'the requester\'s own view is not "another"')
  assert.equal(WP.placementAllowed(s, r(4700, 550, 300, 200), 'M1'), false, 'the same spot is forbidden for a task the owner asked for')
  const source = readFileSync(new URL('../overlay/resources/EGDeskWorkPlacement.sys.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const forbidden of ['setCamera', 'setCanvasViewportTarget', 'setCanvasPanTarget', '.focus(', 'setActiveEntity', 'fetch(', 'document.', 'boardLedger', 'saveBoard']) assert.ok(!source.includes(forbidden), `the placement runtime cannot ${forbidden}`)
  const dto = WP.placementRequest(s, { taskId: 'run-1', surface: FILE }, {}).dto
  const forged = fn => { const copy = structuredClone(dto); fn(copy); return normalizePlacementDto(copy) }
  assert.equal(forged(c => { c.options[0].insideView = ['M1'] }), null, 'an option inside the owner\'s view is refused whole')
  assert.equal(forged(c => { c.options[0].kind = 'in_requester_view'; c.options[0].insideView = ['M2'] }), null, 'into the requester\'s view without a waiting, idle requester')
  assert.equal(forged(c => { c.options[0].rect = { x: 1 } }), null); assert.equal(forged(c => { c.options[0].title = 'Secret plan' }), null); assert.equal(forged(c => { c.default = 'P9' }), null)
  assert.equal(forged(c => { c.members.push({ alias: 'M3', self: true, active: true, idle: false }) }), null, 'two selves')
  assert.ok(forged(c => { c.members[0].active = false; c.options[0].insideView = ['M1'] }), 'an inactive member\'s old view is not protected')
  // attention: a user-made or shared card is never offered a move, whatever the DTO claims
  d.people[1].lastInputAgeMs = 30_000
  for (const [id, expectMove] of [['own-doc', false], ['b-board', false]]) { const a = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: id }); assert.equal(a.options.some(o => o.kind === 'surface_near_requester'), expectMove, id) }
  const agentCard = d.open(r(5300, 24, 720, 520)); const att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: agentCard })
  assert.ok(att.options.some(o => o.kind === 'surface_near_requester')); const bad = structuredClone(att.dto); bad.card.creator = 'user'; assert.equal(normalizePlacementDto(bad), null, 'the bridge refuses a move of a card nobody\'s Agent made')
  const bad2 = structuredClone(att.dto); bad2.options.find(o => o.kind === 'surface_near_requester').insideView = ['M1', 'M2']; assert.equal(normalizePlacementDto(bad2), null)
})

// ================= 3. the journey: owner at A, invited member at B =================
test('journey: B asks the owner\'s Agent to inspect a file -> the viewer opens near B at a beat; nothing changes in A (camera, focus, cards)', async () => {
  const d = desk(); const client = judgeClient(['near_requester']); const br = bridge(client)
  const before = d.snapshot()
  const placed = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: FILE }, judge: br.judge })
  assert.deepEqual([placed.option.kind, placed.source], ['near_requester', 'decision']); assert.equal(client.calls.length, 1, 'one judgment, at the beat')
  const id = d.open(placed.rect)
  assert.ok(!hits(placed.rect, A) && !hits(placed.rect, B) && gapTo(placed.rect, B) < 900, 'next to the member\'s view, outside it, nowhere near the owner\'s')
  const after = JSON.parse(d.snapshot()), was = JSON.parse(before)
  assert.deepEqual(after.camera, was.camera); assert.equal(after.focus, was.focus); assert.deepEqual(after.cards.slice(0, 3), was.cards, 'the owner\'s cards and the member\'s board did not move')
  assert.equal(d.cards.filter(c => hits(c.rect, A)).length, 2, 'nothing new in region A'); assert.equal(d.cards.find(c => c.id === id).creator, 'agent')
  // what the Decision model saw: closed words and aliases
  const sent = JSON.stringify(client.calls[0]); for (const bad of ['acct-', 'own-doc', 'run-1', '5224', '"x":']) assert.ok(!sent.includes(bad), bad)
  assert.deepEqual(client.calls[0].questions.map(q => [q.name, q.type]), [['place', 'choice']]); assert.ok(client.calls[0].questions[0].choices.every(c => /^P[1-8]$/.test(c.value)))
  assert.deepEqual(br.log.map(e => [e.feature, e.mode, e.judgments[0].q, e.judgments[0].would]), [['board_arrangement', 'advisory', 'choice', 'act']])
  assert.deepEqual(br.placement.records().map(x => [x.kind, x.source, x.would.kind, x.would.distance]), [['placement', 'decision', 'near_requester', 'near']])
})
test('journey: the owner pans into B -> nothing is moved under them; whatever opens next stays out of the owner\'s new view', async () => {
  const d = desk(); const br = bridge(judgeClient(['near_requester']))
  const first = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: FILE }, judge: br.judge }); const viewer = d.open(first.rect)
  const cardsBefore = JSON.stringify(d.cards)
  // the owner pans: their view now covers B's side, including the viewer
  d.people[0].viewport = r(4600, -100, 1400, 900); d.camera = { ...d.people[0].viewport }
  assert.ok(hits(first.rect, d.people[0].viewport)); assert.equal(JSON.stringify(d.cards), cardsBefore, 'a pan moves no card: the viewer stays where it was opened')
  const options = WP.placementOptions(d.scene(), { taskId: 'run-1', surface: { kind: 'terminal', size: { width: 600, height: 380 } } })
  assert.ok(options.length > 0); for (const o of options) assert.ok(!hits(o.rect, d.people[0].viewport), `${o.kind} would open under the owner`)
  assert.ok(!options.some(o => o.kind === 'beside_related'), 'next to the viewer is now inside the owner\'s view, so that option does not exist')
  // an attention re-judgment cannot pull the viewer anywhere either: its requester is active, and a move into the owner's view is never listed
  const att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer }); assert.deepEqual(att.options.map(o => o.kind), ['leave', 'point'], 'it may be pointed out to its requester; no move is listed')
  assert.equal(att.options[1].forMember, 'M2')
  // a choice made BEFORE the pan is re-checked against the scene as it is when it would be applied
  const d2 = desk(); const slow = async dto => { const pick = dto.options.find(o => o.kind === 'near_requester').alias; d2.people[0].viewport = r(4900, -200, 1600, 1100); return pick }
  const late = await WP.placeSurface({ scene: d2.inputs, request: { taskId: 'run-1', surface: FILE }, judge: slow })
  assert.ok(late && !hits(late.rect, d2.people[0].viewport), 'the stale spot was dropped'); assert.equal(late.source, 'revalidated')
})
test('journey: the task now needs the OWNER\'s approval -> a pointer fact on the heartbeat, no card moved, nothing brought into the owner\'s view', async () => {
  const d = desk(); const client = judgeClient(q => (q.name === 'attention' ? ['point'] : ['near_requester'])); const br = bridge(client)
  const first = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: FILE }, judge: br.judge }); const viewer = d.open(first.rect)
  d.tasks[0].state = 'waiting_owner'; d.tasks[0].ownerMustAct = true
  const before = d.snapshot()
  const att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer })
  assert.deepEqual(att.options.map(o => o.kind), ['leave', 'point'], 'the requester is active, so no move is even listed; a move into the owner\'s view never is')
  assert.deepEqual(att.options[1].descriptor, { kind: 'point', distance: 'very_far', direction: 'right', insideView: [], forMember: 'M1' }); assert.equal(att.actor, 'M1'); assert.equal(att.fallback.kind, 'point')
  const alias = await br.judge(att.dto); const settled = WP.settle(() => WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer }), att.options.find(o => o.alias === alias))
  assert.deepEqual([settled.option.kind, settled.source], ['point', 'decision']); assert.equal(settled.option.rect, undefined, 'a pointer carries no rectangle: there is nothing to move')
  assert.equal(d.snapshot(), before, 'camera, focus and every card are exactly as they were')
  // the fact rides the REAL heartbeat as closed labels, for the conversation flow
  const fact = br.hb.facts().sources.work_placement
  assert.deepEqual(fact, { placementsPending: 0, placementsDecided: 2, pointerPending: true, pointerWhere: 'right', pointerDistance: 'very_far', pointerFor: 'owner', pointerNeeds: 'owner_action' })
  assert.equal(br.hb.facts().phase, 'thinking', 'the provider does not change the heartbeat\'s own phase or step counts'); assert.equal(br.hb.facts().stepsDone, 0)
  const prompt = pointerWriterPrompt(fact); for (const piece of ['to the right of', 'far away', 'needs their decision', 'Nothing was moved into their view', 'in the language they wrote in']) assert.ok(prompt.includes(piece), piece)
  assert.equal(br.placement.acknowledgePointer('dm'), true); assert.equal(br.hb.facts().sources.work_placement.pointerPending, false, 'withdrawn once the flow has posted')
})
test('journey: the requester waits and goes idle -> surfacing the Agent\'s card near THEIR view becomes an option; it never enters the owner\'s view', async () => {
  const d = desk(); const client = judgeClient(q => (q.name === 'attention' ? ['surface_near_requester'] : ['quiet'])); const br = bridge(client)
  const first = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: FILE }, judge: br.judge }); assert.equal(first.option.kind, 'quiet'); const viewer = d.open(first.rect)
  d.tasks[0].state = 'finished'; d.people[1].lastInputAgeMs = 45_000
  const att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer }); assert.deepEqual(att.options.map(o => o.kind), ['leave', 'point', 'surface_near_requester'])
  const alias = await br.judge(att.dto); const pick = att.options.find(o => o.alias === alias); assert.equal(pick.kind, 'surface_near_requester')
  assert.ok(hits(pick.rect, B) && !hits(pick.rect, A) && !d.cards.some(c => c.id !== viewer && hits(c.rect, pick.rect)), 'a free spot in the idle requester\'s own view')
  assert.equal(att.fallback.kind, 'point', 'without a judgment the code never moves a card')
  // the owner walks over while the judgment is out: the spot that was chosen is now under the owner, so it is not used. What is left is a spot beside the
  // requester's view and outside the owner's, or (when the owner's view covers all of that too) no move at all.
  d.people[0].viewport = r(3900, -50, 1500, 950)
  const settled = WP.settle(() => WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer }), pick)
  assert.equal(settled.source, 'revalidated'); assert.equal(settled.option.kind, 'surface_near_requester')
  assert.ok(!hits(settled.option.rect, d.people[0].viewport) && !hits(settled.option.rect, B), 'beside the requester\'s view, not under the owner')
  d.people[0].viewport = r(1500, -3000, 7000, 7000)
  const none = WP.settle(() => WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer }), pick)
  assert.deepEqual([none.option.kind, none.source], ['point', 'revalidated'], 'the owner\'s view covers every spot: no move is listed, and the requester is told where the card is instead')
})

// ================= 4. single user, crowded canvas =================
test('single user: the Agent\'s work region is beside my view, not in it; into my view only when I am waiting and idle and the judge says so', async () => {
  const d = desk({ single: true }); const client = judgeClient(['in_requester_view', 'near_requester']); const br = bridge(client)
  const working = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: FILE }, judge: br.judge })
  assert.equal(working.option.kind, 'near_requester'); assert.ok(!hits(working.rect, A) && gapTo(working.rect, A) < 900 && working.option.descriptor.direction === 'right', 'just to the right of what I am looking at')
  assert.ok(!working.dto.options.some(o => o.kind === 'in_requester_view'), 'while I am typing, "into my view" is not even an option')
  d.people[0].lastInputAgeMs = 60_000
  const big = WP.placementOptions(d.scene(), { taskId: 'run-1', surface: FILE }); assert.ok(!big.some(o => o.kind === 'in_requester_view'), 'my view has no free room for a surface this large: the option does not exist')
  const RESULT = { kind: 'result', size: { width: 400, height: 300 } }
  const idle = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: RESULT }, judge: br.judge })
  assert.equal(idle.option.kind, 'in_requester_view'); assert.ok(hits(idle.rect, A) && !d.cards.some(c => hits(c.rect, idle.rect)), 'a free spot in my own view, covering nothing')
  // unsure answer -> the code's default, which is never inside a view
  const unsure = bridge(judgeClient(['in_requester_view'], { p: .55 }))
  const kept = await WP.placeSurface({ scene: d.inputs, request: { taskId: 'run-1', surface: RESULT }, judge: unsure.judge }); assert.equal(kept.option.kind, 'near_requester')
  assert.deepEqual(unsure.placement.records().map(x => x.source), ['unsure'])
})
test('crowded canvas: no free spot near or quiet -> the adjacent work area (the next wholly empty frame)', async () => {
  const d = desk({ single: true })
  // Everything around my view is taken (Board regions and cards) out to several views, except one whole frame four steps to the right.
  const free = r(A.x + 4 * (A.width + 48), A.y, A.width, A.height), far = 40_000
  const obstacles = [r(-far, -far, 2 * far, far - 24), r(-far, 824, 2 * far, far), r(-far, -24, far - 24, 848), r(1224, -24, free.x - 24 - 1224, 848), r(free.x + free.width + 24, -24, far, 848)]
  const inputs = () => ({ ...d.inputs(), obstacles })
  const s = WP.enumerateWorkScene(inputs())
  const options = WP.placementOptions(s, { taskId: 'run-1', surface: FILE })
  assert.deepEqual(options.map(o => o.kind), ['adjacent_area']); assert.ok(hits(options[0].rect, free) && options[0].rect.x === free.x + 24 && !obstacles.some(o => hits(o, options[0].rect)))
  assert.equal(options[0].descriptor.distance, 'very_far'); assert.equal(options[0].descriptor.direction, 'right'); assert.equal(WP.defaultOption(options).kind, 'adjacent_area')
  const client = judgeClient(['adjacent_area']); const br = bridge(client)
  const placed = await WP.placeSurface({ scene: inputs, request: { taskId: 'run-1', surface: FILE }, judge: br.judge })
  assert.equal(placed.option.kind, 'adjacent_area'); assert.equal(client.calls.length, 0, 'one option is the code\'s own: nothing is asked'); assert.deepEqual(br.placement.records().map(x => x.source), ['single_option'])
  // nowhere at all: the runtime says so and the caller keeps today's placement
  const walled = WP.placementRequest(WP.enumerateWorkScene({ presence: d.presence.snapshot(), tasks: d.tasks, cards: [], obstacles: [r(-far, -far, 2 * far, 2 * far)] }), { taskId: 'run-1', surface: FILE }); assert.equal(walled, null)
})

// ================= 5. heartbeat, mode, budget of judgments, egress =================
test('heartbeat: one judgment per beat, stale scenes are dropped, off / no heartbeat / denied egress ask nothing', async () => {
  const d = desk(); const dto = WP.placementRequest(d.scene(), { taskId: 'run-1', surface: FILE }).dto
  const client = judgeClient(['quiet']); const br = bridge(client)
  const a = br.placement.submit('dm', dto, br.hb), b = br.placement.submit('dm', dto, br.hb)
  assert.equal(client.calls.length, 0, 'queuing asks nothing'); assert.deepEqual(br.placement.result('dm', a.id), { status: 'pending' })
  assert.deepEqual(br.hb.snapshot().providers, ['work_placement']); assert.equal(br.hb.facts().sources.work_placement.placementsPending, 2)
  br.beat(); await br.placement.idle(); assert.equal(client.calls.length, 1); assert.equal(br.placement.result('dm', a.id).kind, 'quiet'); assert.deepEqual(br.placement.result('dm', b.id), { status: 'pending' })
  br.advance(31_000); br.beat(); await br.placement.idle(); assert.equal(client.calls.length, 1, 'the second scene went stale: it is not judged'); assert.deepEqual(br.placement.result('dm', b.id), { status: 'expired' })
  assert.equal(client.calls[0].timeoutMs, 2000); assert.equal(client.calls[0].promptCacheKey, 'work-placement')
  // switches
  const off = createWorkPlacement({ client, mode: () => 'advisory', enabled: () => false }); assert.deepEqual(off.submit('dm', dto, br.hb), { status: 'off' })
  const modeOff = createWorkPlacement({ client, mode: () => 'off', enabled: () => true }); assert.deepEqual(modeOff.submit('dm', dto, br.hb), { status: 'off' })
  assert.deepEqual(br.placement.submit('dm', dto, null), { status: 'no-heartbeat' }); assert.deepEqual(br.placement.submit('dm', { ...dto, extra: 1 }, br.hb), { status: 'invalid' })
  const stopped = beating(); stopped.hb.stop('run_end'); assert.deepEqual(br.placement.submit('other', dto, stopped.hb), { status: 'no-heartbeat' })
  // the shared egress gate: a content-free kind of the run's own data class
  assert.deepEqual(EGRESS_KINDS.placement_facts.data, 'run'); assert.deepEqual(EGRESS_SITES['egdesk-work-placement.mjs'], ['placement_facts'])
  const denied = bridge(judgeClient(['quiet']), { egressFor: () => createEgressGate(modelDataPermissions({ runActive: false })) })
  const s = denied.placement.submit('dm', dto, denied.hb); denied.beat(); await denied.placement.idle()
  assert.deepEqual([denied.placement.result('dm', s.id).source, denied.placement.result('dm', s.id).kind], ['not_allowed', 'near_requester'], 'the code\'s default stands')
  // a failing Decision call: the default, recorded with its closed reason
  const failing = bridge(judgeClient(['quiet'], { fail: 'timeout' })); const f = failing.placement.submit('dm', dto, failing.hb); failing.beat(); await failing.placement.idle()
  assert.equal(failing.placement.result('dm', f.id).source, 'failed'); assert.deepEqual(failing.log.map(e => e.fallback), ['timeout'])
  // the per-heartbeat cap
  const capped = bridge(judgeClient(['quiet']), { limits: { maxEvals: 1 } })
  for (let i = 0; i < 3; i++) { capped.placement.submit('dm', dto, capped.hb); capped.beat(); await capped.placement.idle() }
  assert.deepEqual(capped.placement.records().map(x => x.source), ['decision', 'limit', 'limit'])
})
test('question and reading: aliases as values, closed descriptions; an unsure or unknown answer is the code\'s default', () => {
  const d = desk(); const dto = normalizePlacementDto(WP.placementRequest(d.scene(), { taskId: 'run-1', surface: FILE }).dto)
  const q = placementQuestion(dto); assert.deepEqual(q.questions[0].choices.map(c => c.value), dto.options.map(o => o.alias))
  assert.ok(q.questions[0].choices[0].description.includes('just outside the requester') && q.questions[0].choices[0].description.includes('inside nobody\'s view'))
  const ans = (value, p) => ({ place: { type: 'choice', choice: value, confidence: p, probabilities: [{ value, probability: p }, { value: 'P1', probability: 1 - p }] } })
  assert.deepEqual([readPlacement(dto, ans('P2', .9)).alias, readPlacement(dto, ans('P2', .9)).accepted], ['P2', true])
  assert.deepEqual([readPlacement(dto, ans('P2', .6)).alias, readPlacement(dto, ans('P2', .6)).accepted], [dto.default, false])
  assert.equal(readPlacement(dto, ans('P7', .95)).alias, dto.default); assert.equal(readPlacement(dto, { place: { type: 'refusal' } }).alias, dto.default)
  assert.equal(placementQuestion({ ...dto, options: dto.options.slice(0, 1) }), null)
})
test('bridge route: loopback JSON POST only; the request finds the conversation\'s heartbeat by local chat id or thread id', async () => {
  const d = desk(); const dto = WP.placementRequest(d.scene(), { taskId: 'run-1', surface: FILE }).dto
  const client = judgeClient(['near_requester']); const br = bridge(client)
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
  const res = await call('POST', '/decision/work-placement/result', { conversationId: 'thread-9', id: queued.body.id }); assert.deepEqual([res.body.status, res.body.kind, res.body.source], ['decided', 'near_requester', 'decision'])
  const records = await call('POST', '/decision/work-placement/records', {}); assert.equal(records.body.records.length, 1); assert.ok(!/acct-|own-doc|"x"/.test(JSON.stringify(records.body)))
})

// ================= 6. the first real consumer: advisory, default off, byte-identical =================
const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const s = surface.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return surface.slice(s, surface.indexOf('\n  }', s) + 4) }
function consumer({ pref } = {}) {
  const log = { prefs: [], posts: [], queries: 0, listeners: 0 }
  const nodes = [{ id: 'c1', isConnected: true, dataset: {}, _rect: r(100, 100, 500, 400) }, { id: 'c2', isConnected: true, dataset: {}, _rect: r(650, 120, 300, 220), _resultRecord: { provenance: { creator: 'agent', runId: 'run-7' } } }]
  const state = { activeEntityId: 'c1' }
  const deps = { WorkPlacement: WP, state, readSurfacePref: key => { log.prefs.push(key); return pref }, document: { querySelectorAll: sel => { log.queries++; return sel === '.egd-canvas-card' ? nodes : [] } },
    window: { addEventListener: () => { log.listeners++ } }, persistentEntityGeometry: n => ({ ...n._rect, zIndex: 1 }), cardKindForPersistence: () => 'file', safeViewportWorldRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800 }),
    deskStoreRequest: async (method, path, body) => { log.posts.push([method, path, body]); return { status: 200, body: { status: 'queued' } } } }
  const body = `let workInputAt = null, workInputWatch = false;\n${decl('workPresence')}\n${decl('noteWorkSurfacePlacement')}\nreturn noteWorkSurfacePlacement;`
  return { note: new Function(...Object.keys(deps), body)(...Object.values(deps)), log, state }
}
test('consumer, default path: with the flag unset the hook reads the pref and does nothing else; the placement that is returned is never touched', () => {
  for (const pref of [undefined, null, 'off', 'on', 'ADVISORY', { unreadable: true }]) {
    const c = consumer({ pref }); const placement = Object.freeze({ x: 24, y: 24, width: 720, height: 520, inView: true })
    c.note('file', placement, { runId: 'run-7', conversationId: 'thread-9' })
    assert.deepEqual(c.log, { prefs: ['egdesk.workPlacement'], posts: [], queries: 0, listeners: 0 }, String(pref)); assert.deepEqual(Object.keys(c.state), ['activeEntityId'])
  }
  // the hook sits after the unchanged placement computation and its result is not used
  const fn = decl('resolveCanvasCardPlacement')
  assert.match(fn, /const placed = SurfaceState\.placeCanvasView\(\{ size, safe, occupied, anchor, gap: 24 \}\);\n[^\n]*\n    if \(options\.workSurface\) state\.noteWorkSurfacePlacement\?\.\(kind, placed, options\.workSurface\);\n    return placed;/)
  assert.match(surface, /resolveCanvasCardPlacement\('result', options\.restore \? \{\} : \{ workSurface: \{ kind: 'result'/)
  const zone = readFileSync(new URL('../overlay/resources/surface/EGDeskSurfaceFileCard.mjs', import.meta.url), 'utf8')
  assert.match(zone, /resolveCanvasCardPlacement\('file', runFile \? \{ workSurface: \{ kind: 'file', runId: runFile\.target\?\.runId, conversationId: runFile\.target\?\.conversationId \} \} : \{\}\)/)
  const server = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(server, /enabled: \(\) => \['advisory', 'on'\]\.includes\(process\.env\.EGDESK_WORK_PLACEMENT\),/); assert.match(server, /live: \(\) => process\.env\.EGDESK_WORK_PLACEMENT === 'on'/); assert.match(server, /if \(await handleWorkPlacementHttp\(req, res, url\)\) return/)
})
test('consumer, advisory: records where it WOULD go against where it lands today, sends only the closed request, changes nothing', () => {
  const c = consumer({ pref: 'advisory' }); const placement = Object.freeze({ x: 24, y: 440, width: 720, height: 340, inView: true })
  c.note('file', placement, { runId: 'run-7', conversationId: 'thread-9' })
  assert.equal(c.log.posts.length, 1); const [method, path, body] = c.log.posts[0]
  assert.deepEqual([method, path, Object.keys(body)], ['POST', '/decision/work-placement/request', ['clientThreadId', 'conversationId', 'dto']]); assert.ok(normalizePlacementDto(body.dto), 'exactly the closed shape the bridge accepts')
  assert.deepEqual(body.dto.landed, { distance: 'in_view', direction: 'in_view', insideView: ['M1'] }, 'today: inside my own view')
  assert.deepEqual(c.state.workPlacementLog, [{ surface: 'file', would: { alias: 'P1', kind: 'near_requester', distance: 'near', direction: 'right', insideView: [], related: 'none' }, landed: body.dto.landed, differs: true }])
  assert.ok(!/c1|c2|run-7|thread-9/.test(JSON.stringify(body.dto)) && !/"x"|"rect"/.test(JSON.stringify(c.state.workPlacementLog)))
  assert.equal(c.log.listeners, 3, 'input is watched only once the flag is on'); c.note('result', placement, { runId: 'run-8' }); assert.equal(c.log.listeners, 3); assert.equal(c.log.posts.length, 1, 'without a conversation nothing is sent')
  assert.equal(c.state.workPlacementLog.length, 2)
})

// ================= 7. cycle 14: nudges, and the pointer round trip on lane L3's REAL session heartbeat, after the run =================
test('nudge: a queued scene and a raised pointer ask the heartbeat for a beat now; advisory decides "point" but raises nothing', async () => {
  const d = desk(); const viewer = d.open(r(5300, 24, 720, 520)); d.tasks[0].state = 'waiting_owner'; d.tasks[0].ownerMustAct = true
  const att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer })
  const b = beating(); const nudges = []; const real = b.hb.nudge.bind(b.hb); const hb = Object.create(b.hb, { nudge: { value: () => { const ok = real(); nudges.push(ok); return ok } } })
  const timers = []
  const live = createWorkPlacement({ client: judgeClient(['point']), mode: () => 'on', enabled: () => true, live: () => true, now: b.now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.at(-1) } })
  assert.equal(live.submit('dm', att.dto, hb).status, 'queued'); assert.deepEqual(nudges, [true], 'queued: the judgment does not wait for the grid')
  b.beat(); await live.idle()
  assert.equal(live.facts('dm').pointerPending, true); assert.deepEqual(nudges, [true, false], 'the pointer\'s own nudge falls inside the same beat interval and is refused')
  assert.deepEqual(timers.map(x => x.ms), [5000], 'so it is tried once more, one beat interval later'); b.advance(5000); timers[0].fn(); assert.deepEqual(nudges, [true, false, true])
  assert.deepEqual(live.records().map(x => [x.kind, x.would.kind, x.pointer]), [['attention', 'point', 'raised']])
  // the session's own acknowledgement (hb.acknowledge) withdraws the fact, with or without the bridge's attentionPosted wiring
  assert.equal(b.hb.acknowledge('work_placement', 'attention'), true); assert.equal(live.facts('dm').pointerPending, false)
  // wording the request bodies showed to be misleading (cycle 14): a quiet spot is never described as "near", and "leave" says whose view the card's place is measured from
  const quiet = WP.placementOptions(desk().scene(), { taskId: 'run-1', surface: FILE }).find(o => o.kind === 'quiet'); assert.equal(quiet.descriptor.distance, 'far')
  const asked = placementQuestion(normalizePlacementDto(att.dto)).questions[0].choices.map(c => c.description)
  assert.deepEqual(asked, ['leave everything as it is and say nothing; the card is very_far, to the right of M1; inside nobody\'s view', 'leave the card where it is and tell the member who must act where it is; very_far, to the right of M1; inside nobody\'s view'])
  // advisory (the default): the same decision is recorded as what it WOULD do; no fact, so no message can follow
  const a = beating(); const advisory = createWorkPlacement({ client: judgeClient(['point']), mode: () => 'advisory', enabled: () => true, now: a.now })
  advisory.submit('dm', att.dto, a.hb); a.beat(); await advisory.idle()
  assert.equal(advisory.facts('dm').pointerPending, false); assert.deepEqual(advisory.records().map(x => [x.would.kind, x.pointer]), [['point', 'advisory']])
})
const POINTER = '오른쪽 작업 구역에 결과가 있어요. 확인이 필요합니다.'
test('pointer round trip, post-run, on the real session heartbeat: attention scene -> judged "point" -> pointer fact -> ONE message to the owner -> acknowledged -> withdrawn', async t => {
  // Real CodexChatRuntime with lane L3's session heartbeat and conversation flow (their fixture: mock engine, mock decision model, virtual clock). The placement runtime is this lane's real module.
  const people = [{ member: 'self', self: true, active: true, lastInputAgeMs: 2000 }, { member: 'm-jin', active: false }]
  const audience = { 'dm-task': { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, 'dm-owner': { requester: 'self', owner: 'self', participants: ['self'] } }
  const acks = []; let placement
  const w = world(t, { presence: { snapshot: () => people }, audience: ({ run }) => audience[run.clientThreadId] ?? null, policy: { message: values => (values.includes('pointer') ? 'pointer' : 'none') },
    writer: prompt => (/on the desk/.test(prompt) ? POINTER : null), attentionPosted: e => { acks.push(e); if (e.provider === 'work_placement') placement.acknowledgePointer(e.key) } }) // the bridge's own wiring (codex-bridge-server.mjs)
  const client = judgeClient(['point'])
  placement = createWorkPlacement({ client, mode: () => 'on', enabled: () => true, live: () => true, now: () => w.at(), setTimer: (fn, ms) => w.chat.setTimer(fn, ms) })
  const o = await w.dm('dm-owner', '예산표 정리해 주세요'); await w.advance(3000); await o.final('예산표를 정리했습니다.')
  const m = await w.dm('dm-task', '분기 보고서 초안을 만들어 주세요'); await w.advance(4000); await m.final('보고서 초안을 만들었습니다.')
  const hb = w.chat.heartbeatFor('dm-task')
  assert.deepEqual([hb.state, hb.tempo], ['running', 'idle'], 'the run is over and the session heartbeat is still there (cycle 12\'s gap)')
  // The canvas: owner at A, the member at B, the Agent's result card beside B; the finished task now needs the OWNER's approval.
  const d = desk(); const viewer = d.open(r(5300, 24, 720, 520)); d.tasks[0].state = 'waiting_owner'; d.tasks[0].ownerMustAct = true
  const canvas = d.snapshot(), att = WP.attentionRequest(d.scene(), { taskId: 'run-1', cardId: viewer })
  const eventsBefore = w.events.length
  assert.equal(placement.submit('dm-task', att.dto, hb).status, 'queued')
  await w.advance(HEARTBEAT_LIMITS.nudgeMs)
  assert.equal(client.calls.length, 1, 'judged within half a second of the submit, not at the 20 s idle grid')
  assert.deepEqual(hb.facts().sources.work_placement, { placementsPending: 0, placementsDecided: 1, pointerPending: true, pointerWhere: 'right', pointerDistance: 'very_far', pointerFor: 'owner', pointerNeeds: 'owner_action' })
  assert.deepEqual(o.assistant(), ['예산표를 정리했습니다.'], 'not yet: the second nudge was refused')
  await w.advance(WORK_PLACEMENT_LIMITS.renudgeMs + HEARTBEAT_LIMITS.nudgeMs)
  assert.deepEqual(o.assistant(), ['예산표를 정리했습니다.', POINTER], 'ONE completed message, in the owner\'s own conversation, about 6 s after the submit')
  assert.deepEqual(m.assistant(), ['보고서 초안을 만들었습니다.'], 'nothing in the member\'s conversation')
  assert.deepEqual(acks, [{ key: 'dm-task', provider: 'work_placement' }]); assert.equal(placement.facts('dm-task').pointerPending, false, 'acknowledged: the fact is withdrawn')
  assert.equal(hb.facts().sources.work_placement.pointerPending, false)
  // what each model saw: closed labels only; the writer was told where in fixed words; no member id, title or coordinate anywhere
  const judged = JSON.stringify(client.calls[0]), asked = w.beatRequests.at(-1).input.join('\n'), prompt = w.forkPrompts.at(-1)
  assert.match(asked, /attention_kind: approval/); assert.match(asked, /attention_for: owner/); assert.match(asked, /attention_where: right/)
  assert.match(prompt, /to the right of what they are looking at on the desk/)
  for (const text of [judged, asked, prompt]) assert.doesNotMatch(text, /m-jin|acct-|보고서|예산표|own-doc|5300|"x"/)
  // nothing moved: the canvas is as it was, and the only events are the message's own
  assert.equal(d.snapshot(), canvas); assert.deepEqual([...new Set(w.events.slice(eventsBefore).map(e => `${e.clientThreadId}:${e.event}`))], ['dm-owner:message.started', 'dm-owner:message.delta', 'dm-owner:message.completed'])
  // once: later beats judge nothing more and post nothing more
  await w.advance(60_000)
  assert.deepEqual([client.calls.length, w.requests.flow, o.assistant().length, m.assistant().length], [1, 1, 2, 1])
})
