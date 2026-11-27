// L1 cycle 27: collaboration inside lane L5's real-engine check (helper/egdesk-real-engine-check.mjs), as a HOOK in its own module (registered in helper/egdesk-real-engine-hooks.mjs).
// Two synthetic people share ONE room: the owner (the local person, whose conversation it is) and an invited member. A conversation script says who sends each turn
// (`from: 'owner' | 'invited'`), and the product's own requester / presence path carries it, without a window:
//   - the Desk's presence snapshot is posted to the bridge's own route (createPresenceMirrorHttpHandler, POST /presence/snapshot) and kept posted every 3 s while the
//     conversation runs, as the window does; the owner's row is the own one, the invited member a seated member with a view of their own;
//   - before an invited turn the requester is told through the bridge's own route (createRunRequesterHttpHandler, POST /presence/requester): the registry takes it only
//     while the alias is in the mirrored snapshot (the same rule as in the bridge), and an owner turn clears it (the local person asked, as before);
//   - the check's conversation flow is composed with the product's audience rule over that registry (`conversationFlow` in this entry: presence, audience, attentionPosted,
//     exactly the keys codex-bridge-server.mjs passes when EGDESK_PRESENCE=on), so the heartbeat reads WHO asked from the same place the bridge does.
// For a turn whose `expect` has a `collab` entry, AFTER the answer is posted, the hook records and the entry's own checks decide (by code, on the record):
//   requester       the bridge's audience names the invited member (or nobody: the owner asked), and the flow asked for it the same way
//   attention       the finished result's attention: the code-built scene (a synthetic one: no canvas exists here) goes through the product's work-placement runtime and
//                   its own route (createWorkPlacement, POST /decision/work-placement/request) on the room's live heartbeat; the owner question (owner_action) is asked
//                   of the Decision model about the run's request and ONLY the answering model's own sentences (placementContextFor); the outcome is recorded
//   ownerQuestion   what that Decision request asked: the question names, the run's request quoted, the model's own sentences quoted and none of the draft check's copy
//   noIdentity      no member alias, board id, request id or coordinate is in any Decision request of the turn
//   cameraUntouched record level: the outcome is one of the placement words (leave / point / surface_near_requester), the requester's surface lands in nobody else's view,
//                   and the scene the hook built holds no coordinate; nothing in this hook can move a camera (no canvas is composed)
// What stays out: the window (cameras, focus, cards on a canvas), the joint Board's feed and service. Those are measured by scripts/egdesk-multiuser-live-measure.mjs.
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { PRESENCE_MIRROR, RUN_REQUESTER, createPresenceMirror, createPresenceMirrorHttpHandler, createRunRequesterHttpHandler, createRunRequesters } from './egdesk-presence-mirror.mjs'
import { createWorkPlacement, createWorkPlacementHttpHandler } from './egdesk-work-placement.mjs'
import * as DraftCheck from './egdesk-draft-check.mjs'
// the draft check's fixed fallback sentences (the owner removed them; L3): read when the module still has them, else none (the same reading as the multiuser measure)
const DRAFT_CHECK_COPY = DraftCheck.DRAFT_CHECK_COPY ?? {}
import { messageCounts } from './egdesk-real-engine-journey.mjs'
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs'

export const COLLAB_FLAGS = Object.freeze(['EGDESK_PRESENCE', 'EGDESK_WORK_PLACEMENT'])
export const COLLAB_FROM = Object.freeze(['owner', 'invited'])
// the two people (synthetic): the invited member as the joint presence feed names one (m- + 16 hex), the Board it was invited to (a v4 uuid), the aliases of the scene
export const COLLAB_PEOPLE = Object.freeze({
  owner: Object.freeze({ member: 'self', scene: 'M1', viewport: Object.freeze({ x: 0, y: 0, width: 1280, height: 800 }) }),
  invited: Object.freeze({ member: 'm-3f9a1c7e5b2d4a60', scene: 'M2', board: '0b1e7f3a-5c2d-4e8b-9a61-3d2c1f0e9a77', viewport: Object.freeze({ x: 2900, y: 500, width: 1200, height: 800 }) }),
})
export const COLLAB_LIMITS = Object.freeze({ repostMs: 3000, attentionWaitMs: 25_000, pointerWaitMs: 30_000, sharedChars: 4000, strings: 8, stringChars: 200, outcomeWords: Object.freeze(['leave', 'point', 'surface_near_requester']) })
const clip = (text, n) => String(text ?? '').slice(0, n)
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim()

// ---- the `expect.collab` entry of a script turn: its shape (validator + JSON schema) and its checks ----
// c29: roomKept and receiptsClosed belong to a restart turn; continuity to the first message turn after it
export const COLLAB_RESTART_KEYS = Object.freeze(['roomKept', 'receiptsClosed'])
export const COLLAB_EXPECT_KEYS = Object.freeze(['requester', 'attention', 'ownerQuestion', 'noIdentity', 'cameraUntouched', ...COLLAB_RESTART_KEYS, 'continuity', 'twoRuns'])
const ATTENTION_KEYS = ['branch', 'kind', 'pointer']
const OWNER_QUESTION_KEYS = ['questions', 'quotesRequest', 'quotesOwnAnswer']
const strings = { type: 'array', maxItems: COLLAB_LIMITS.strings, items: { type: 'string', minLength: 1, maxLength: COLLAB_LIMITS.stringChars } }
export const COLLAB_EXPECT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: {
    requester: { enum: [...COLLAB_FROM] },
    attention: { type: 'object', additionalProperties: false, minProperties: 1, properties: { branch: { enum: ['owner', 'requester'] }, kind: { enum: [...COLLAB_LIMITS.outcomeWords] }, pointer: { enum: ['posted', 'raised', 'none'] } } },
    ownerQuestion: { type: 'object', additionalProperties: false, minProperties: 1, properties: { questions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,40}$' } }, quotesRequest: strings, quotesOwnAnswer: { const: true } } },
    noIdentity: { const: true },
    cameraUntouched: { const: true },
    roomKept: { const: true },
    receiptsClosed: { const: true },
    continuity: { const: true },
    twoRuns: { const: true },
  },
})
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
/** [] when the entry is well formed, else the problems as short texts. */
export function validateCollabExpect(e) {
  const out = []
  if (!plain(e) || !Object.keys(e).length) return ['an object with at least one key']
  for (const k of Object.keys(e)) if (!COLLAB_EXPECT_KEYS.includes(k)) out.push(`${k}: unknown key`)
  if (e.requester !== undefined && !COLLAB_FROM.includes(e.requester)) out.push(`requester: one of ${COLLAB_FROM.join(' / ')}`)
  if (e.attention !== undefined) {
    if (!plain(e.attention) || !Object.keys(e.attention).length) out.push('attention: an object { branch?, kind?, pointer? }')
    else {
      for (const k of Object.keys(e.attention)) if (!ATTENTION_KEYS.includes(k)) out.push(`attention.${k}: unknown key`)
      if (e.attention.branch !== undefined && !['owner', 'requester'].includes(e.attention.branch)) out.push('attention.branch: owner or requester')
      if (e.attention.kind !== undefined && !COLLAB_LIMITS.outcomeWords.includes(e.attention.kind)) out.push(`attention.kind: one of ${COLLAB_LIMITS.outcomeWords.join(' / ')}`)
      if (e.attention.pointer !== undefined && !['posted', 'raised', 'none'].includes(e.attention.pointer)) out.push('attention.pointer: posted, raised or none')
    }
  }
  if (e.ownerQuestion !== undefined) {
    const q = e.ownerQuestion
    if (!plain(q) || !Object.keys(q).length) out.push('ownerQuestion: an object { questions?, quotesRequest?, quotesOwnAnswer? }')
    else {
      for (const k of Object.keys(q)) if (!OWNER_QUESTION_KEYS.includes(k)) out.push(`ownerQuestion.${k}: unknown key`)
      if (q.questions !== undefined && (!Array.isArray(q.questions) || !q.questions.length || q.questions.length > 4 || q.questions.some(n => typeof n !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(n)))) out.push('ownerQuestion.questions: 1-4 closed names')
      if (q.quotesRequest !== undefined && (!Array.isArray(q.quotesRequest) || q.quotesRequest.length > COLLAB_LIMITS.strings || q.quotesRequest.some(s => typeof s !== 'string' || !s || s.length > COLLAB_LIMITS.stringChars))) out.push('ownerQuestion.quotesRequest: strings')
      if (q.quotesOwnAnswer !== undefined && q.quotesOwnAnswer !== true) out.push('ownerQuestion.quotesOwnAnswer: true')
    }
    if (e.attention === undefined) out.push('ownerQuestion: needs attention (the question is the attention scene\'s)')
  }
  for (const k of [...COLLAB_RESTART_KEYS, 'continuity', 'twoRuns']) if (e[k] !== undefined && e[k] !== true) out.push(`${k}: true`)
  if (e.noIdentity !== undefined && e.noIdentity !== true) out.push('noIdentity: true')
  if (e.cameraUntouched !== undefined && e.cameraUntouched !== true) out.push('cameraUntouched: true')
  if (e.cameraUntouched === true && e.attention === undefined) out.push('cameraUntouched: needs attention (it reads the attention outcome)')
  if (e.noIdentity === true && e.attention === undefined) out.push('noIdentity: needs attention (it reads the Decision requests the attention scene made)')
  return out
}
/** The collab part of a script turn: who sends it. */
export function validateCollabFrom(from) { return COLLAB_FROM.includes(from) ? [] : [`one of ${COLLAB_FROM.join(' / ')}`] }

/** checkCollabExpect(expect, record) -> [{ check, ok, detail }] (names are "collab.<key>"); a missing record fails every check. */
export function checkCollabExpect(expect, rec) {
  const out = [], put = (check, ok, detail) => out.push({ check: `collab.${check}`, ok: ok === true, detail })
  if (!rec) return [{ check: 'collab.ran', ok: false, detail: { why: 'the collaboration hook did not run for this turn (flag off or the hook is not attached)' } }]
  // after a restart (c29): what the new bridge holds about the room, read against what the old one held
  if (expect.roomKept === true || expect.receiptsClosed === true) {
    const r = rec.restart ?? null
    if (expect.roomKept === true) {
      const same = !!r?.before?.route && JSON.stringify(r.before.route) === JSON.stringify(r.after?.route) && JSON.stringify(r.before.row) === JSON.stringify(r.after?.row) && r.before.account !== null && r.before.account === r.after?.account
      put('roomKept', same, { route: r ? [r.before?.route ?? null, r.after?.route ?? null] : null, row: r ? [r.before?.row ?? null, r.after?.row ?? null] : null, accountKept: r ? r.before?.account === r.after?.account && r.before?.account !== null : null })
    }
    if (expect.receiptsClosed === true) {
      const a = r?.after
      // nothing carried over: no receipt of what was attached or sent, no approval question assumed still open (an unread question is asked again, never taken as answered); and the old one DID have its question open
      put('receiptsClosed', r?.before?.awaiting === true && !!a && a.memoryReceipts === 0 && a.contextReceipts === 0 && a.awaiting === false, { before: r?.before ? { awaiting: r.before.awaiting } : null, after: a ? { memoryReceipts: a.memoryReceipts, contextReceipts: a.contextReceipts, awaiting: a.awaiting } : null })
    }
  }
  // c30 (U7): two runs at the same time on one Desk, judged by code on what the placement did for each
  if (expect.twoRuns === true) {
    const t = rec.twoRuns ?? null, runs = t?.runs ?? [], put2 = (name, ok, detail) => put(`twoRuns.${name}`, ok, detail)
    put2('placed', runs.length === 2 && runs.every(r => r.spot && r.outsideViews === true && r.outsideCards === true), { runs: runs.map(r => ({ run: r.run, rule: r.rule, outsideViews: r.outsideViews, outsideCards: r.outsideCards, spot: !!r.spot })) })
    put2('separate', runs.length === 2 && t.overlap === false && t.told?.main === (rec.from === 'invited' ? COLLAB_PEOPLE.invited.member : null) && t.told?.side === null, { overlap: t?.overlap ?? null, told: t?.told ?? null })
    put2('stillness', !!t && t.inputsUnchanged === true && t.ownerBefore === t.ownerAfter && t.moves.length === 0, { inputsUnchanged: t?.inputsUnchanged ?? null, ownerBefore: t?.ownerBefore ?? null, ownerAfter: t?.ownerAfter ?? null, moves: t?.moves ?? null })
    put2('surfacing', runs.length === 2 && runs.every(r => r.attention?.result?.status === 'decided' && r.attention.result.branch === 'requester' && r.attention.result.forMember === r.requester && r.attention.otherRequesterTold === false),
      { runs: runs.map(r => ({ run: r.run, requester: r.requester, result: r.attention?.result ? { status: r.attention.result.status, branch: r.attention.result.branch, kind: r.attention.result.kind, forMember: r.attention.result.forMember } : null, otherRequesterTold: r.attention?.otherRequesterTold ?? null })) })
    put2('judged', runs.length === 2 && t.judgments === 2 && runs.every(r => r.judgments?.length === 1 && r.judgments[0].questions.join() === 'owner_action' && r.judgments[0].quotesOwn === true && r.judgments[0].quotesOther === false && r.judgments[0].identityLeak === false),
      { runs: runs.map(r => ({ run: r.run, judgments: (r.judgments ?? []).map(j => ({ questions: j.questions, quotesOwn: j.quotesOwn, quotesOther: j.quotesOther, identityLeak: j.identityLeak })) })), total: t?.judgments ?? null })
  }
  if (expect.continuity === true) {
    const c = rec.continuity ?? null
    put('continuity', !!c && c.sameThread === true && c.resumed === true && c.sentOnce === true && c.asRequester === rec.from, { sameThread: c?.sameThread ?? null, resumes: c?.resumes ?? null, userMessages: c?.userMessages ?? null, asRequester: c?.asRequester ?? null })
  }
  if (expect.requester !== undefined) {
    const named = rec.audience?.requester ?? null, want = expect.requester === 'invited' ? COLLAB_PEOPLE.invited.member : null
    // the registry says who asked AND every time the conversation flow asked for the audience of this turn's run it got the same answer
    const flowSame = (rec.flowAudience ?? []).every(a => (a?.requester ?? null) === want)
    put('requester', named === want && rec.set === (expect.requester === 'invited' ? 'held' : 'cleared') && flowSame, { from: rec.from, set: rec.set, audience: named, flowAsked: (rec.flowAudience ?? []).length, flowSame })
  }
  const att = rec.attention
  if (expect.attention !== undefined) {
    const a = expect.attention, res = att?.result ?? null
    // posted: the placement runtime raised the pointer AND the conversation's flow posted exactly one message for it (the window's R4: one pointer message in the owner's own conversation)
    const pointerOk = a.pointer === undefined || (att ? (a.pointer === 'posted' ? att.pointer === 'posted' && att.flowMessages === 1 : a.pointer === 'raised' ? ['raised', 'posted'].includes(att.pointer) : att.pointer === 'none') : false)
    put('attention', !!res && res.status === 'decided' && (a.branch === undefined || res.branch === a.branch) && (a.kind === undefined || res.kind === a.kind) && pointerOk,
    { submitted: att?.submitted ?? null, heartbeat: att?.heartbeat ?? null, result: res ? { status: res.status, branch: res.branch ?? null, kind: res.kind ?? null, source: res.source ?? null, forMember: res.forMember ?? null } : null, pointer: att?.pointer ?? null, flowMessages: att?.flowMessages ?? null })
  }
  if (expect.ownerQuestion !== undefined) {
    const q = expect.ownerQuestion, failed = []
    const mine = (att?.requests ?? []).filter(r => r.family === 'work_placement')
    if (mine.length !== 1) failed.push(`requests:${mine.length}`)
    else {
      const r = mine[0]
      if (q.questions !== undefined && JSON.stringify(r.questions) !== JSON.stringify(q.questions)) failed.push('questions')
      for (const text of q.quotesRequest ?? []) if (!oneLine(r.shared).includes(oneLine(text))) failed.push(`quote:${clip(text, 24)}`)
      if (q.quotesOwnAnswer) {
        const own = oneLine(rec.ownAnswer ?? '')
        if (!own || !oneLine(r.shared).includes(own)) failed.push('own_answer')
        // none of the draft check's own sentences is in what the judge was shown
        if (Object.values(DRAFT_CHECK_COPY ?? {}).some(copy => typeof copy === 'string' && copy && oneLine(r.shared).includes(oneLine(copy)))) failed.push('check_copy_quoted')
      }
    }
    put('ownerQuestion', failed.length === 0, { requests: mine.length, questions: mine.map(r => r.questions), failed })
  }
  if (expect.noIdentity === true) {
    const leaks = (att?.requests ?? []).filter(r => r.identityLeak).map(r => r.family)
    put('noIdentity', (att?.requests ?? []).length > 0 && leaks.length === 0, { requests: (att?.requests ?? []).length, leaks })
  }
  if (expect.cameraUntouched === true) {
    const res = att?.result ?? null
    put('cameraUntouched', !!res && COLLAB_LIMITS.outcomeWords.includes(res.kind) && att.landedInsideOthers === false && att.sceneHasCoordinates === false,
      { kind: res?.kind ?? null, landedInsideOthers: att?.landedInsideOthers ?? null, sceneHasCoordinates: att?.sceneHasCoordinates ?? null })
  }
  return out
}

// ---- the world: presence mirror, requester registry and their routes (the bridge's own modules) ----
const localRequest = (method, p, body) => Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: p, method, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
const localResponse = () => Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, setHeader() {}, writeHead(s) { this.status = s }, end(j) { this.body = j ? JSON.parse(j) : null; this.writableEnded = true } })
async function route(handler, pathname, body) {
  const req = localRequest('POST', pathname, body), res = localResponse()
  await handler(req, res, new URL(pathname, 'http://127.0.0.1:39218'))
  return { status: res.status ?? null, body: res.body ?? null }
}
/** The Desk's presence rows as the window posts them: the own row first, the invited member seated with a view of their own. */
export const presenceRows = () => [
  { member: COLLAB_PEOPLE.owner.member, self: true, active: true, viewport: { ...COLLAB_PEOPLE.owner.viewport }, focusCard: null, lastInputAgeMs: 2000 },
  { member: COLLAB_PEOPLE.invited.member, self: false, active: true, viewport: { ...COLLAB_PEOPLE.invited.viewport }, focusCard: null, lastInputAgeMs: 4000 },
]
/** createCollabWorld({ now?, setInterval?, clearInterval? }) -> { mirror, requesters, flow, publish(), tell(from, keys), audienceFor(run), stop() } */
export function createCollabWorld({ now = Date.now, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const mirror = createPresenceMirror({ now }), requesters = createRunRequesters({ presence: mirror, now })
  const presenceHttp = createPresenceMirrorHttpHandler({ mirror, enabled: () => true }), requesterHttp = createRunRequesterHttpHandler({ requesters, enabled: () => true })
  const flowAudience = []   // what the conversation flow asked of the registry: [{ key, answer }]
  let timer = null, placement = null
  const publish = () => route(presenceHttp, PRESENCE_MIRROR.path, { rows: presenceRows() })
  const world = {
    mirror, requesters, flowAudience,
    publish,
    start() { if (timer) return; void publish(); timer = setTimer(() => { void publish() }, COLLAB_LIMITS.repostMs); timer.unref?.() },
    stop() { if (timer) clearTimer(timer); timer = null },
    // who sends the next turn: the invited member is told through the bridge's route (taken only while the presence snapshot lists them), the owner clears it
    async tell(from, { clientThreadId, conversationId = null }) {
      await publish()
      const body = { clientThreadId, conversationId, requester: from === 'invited' ? { board: COLLAB_PEOPLE.invited.board, alias: COLLAB_PEOPLE.invited.member } : null }
      return (await route(requesterHttp, RUN_REQUESTER.path, body)).body?.status ?? null
    },
    // the flow's audience rule, over the same registry as the bridge's (recorded: the check reads what the flow was told)
    audience: ({ run } = {}) => { const answer = requesters.audience({ run }); flowAudience.push({ key: run?.clientThreadId ?? null, requester: answer?.requester ?? null, owner: answer?.owner ?? null }); return answer },
    get placement() { return placement }, set placement(value) { placement = value },
  }
  return world
}

// ---- the attention scene the hook builds (a synthetic one: the window builds it from the canvas; no canvas exists here) ----
/** A finished, agent-made result card: the owner is working at the left of the space, the invited member at the right; each outcome holds no coordinate, only closed words. */
export function attentionScene() {
  const { owner, invited } = COLLAB_PEOPLE
  return { kind: 'attention', surface: 'result',
    members: [{ alias: owner.scene, self: true, active: true, idle: false }, { alias: invited.scene, self: false, active: true, idle: false }], requester: invited.scene,
    state: 'finished', ownerMustAct: false, card: { creator: 'agent', movable: true },
    forOwner: { kind: 'point', distance: 'far', direction: 'right', insideView: [], forMember: owner.scene },
    forRequester: { kind: 'surface_near_requester', distance: 'near', direction: 'right', insideView: [invited.scene], forMember: invited.scene } }
}
const COORDINATE = /"(?:x|y|width|height|left|top)"\s*:/
/** Whether a Decision request's text holds what identifies a person or the Board, or a coordinate (multiuser v4 K2): the invited member's feed alias, the Board id, a scene alias, a coordinate key. */
export const identityLeak = text => text.includes(COLLAB_PEOPLE.invited.member) || text.includes(COLLAB_PEOPLE.invited.board) || COORDINATE.test(text) || /"M[1-8]"|\bM[1-8]\b/.test(text)

// ---- the hook ----
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const v of Object.values(value)) deepFreeze(v) } return value }

/** The product flag that needs the Decision model (the attention scene's owner question); registered with the others in helper/egdesk-real-engine-registrations.mjs. */
export const COLLAB_DECISION_FLAGS = Object.freeze(['EGDESK_WORK_PLACEMENT'])

/**
 * The collaboration hook of ONE conversation: a registered turn hook (helper/egdesk-real-engine-extensions.mjs registerTurnHooks; registered in helper/egdesk-real-engine-registrations.mjs).
 * It does nothing unless the conversation's flags say EGDESK_PRESENCE=on.
 *   flowOptions({ FLAG })        the keys the bridge adds to conversationFlow with presence on (presence, audience, attentionPosted)
 *   attach(deps)                 the placement runtime over the check's own runtime and Decision client; presence starts being posted
 *   beforeSend({ turn, state })  who sends this turn, told through the bridge's own routes
 *   afterTurn({ ..., expect })   for a turn with `expect.collab`: the record (under `collab` in the turn record) and the entry's own checks (by code, on the record)
 *   dispose()                    presence stops being posted
 */
export function createCollabTurnHook(conversation, { world = createCollabWorld() } = {}) {
  const active = FLAG => FLAG?.EGDESK_PRESENCE === 'on'
  let chat = null, store = null, requestLog = [], L = COLLAB_LIMITS, ready = false, bodies = [], placement = null, placementHttp = null
  let restartedFrom = null // after a restart: the engine thread the room had before (the first message turn must continue on it)
  // what the bridge holds about the room right now: its route and saved row, the account of that route, what the new runtime has in memory
  const roomFacts = ({ clientThreadId, conversationId }) => {
    let route = null, row = null, account = null
    try { route = chat.requestEngineRoute({ clientThreadId, conversationId }, { verifyAccount: false }) } catch { route = null }
    try { const r = store.getConversation(clientThreadId); row = r ? { clientThreadId: r.clientThreadId ?? clientThreadId, conversationId: r.conversationId ?? null, engineId: r.engineId ?? null, engineProfileId: r.engineProfileId ?? null } : null } catch { row = null }
    try { account = route ? (chat.engineOwnerHash(route.engineId, route.engineProfileId) ?? null) : null } catch { account = null }
    let awaiting = null; try { awaiting = chat.gateHookBroker?.()?.awaitingReply?.(conversationId) === true } catch { awaiting = null }
    return { route, row, account, awaiting, memoryReceipts: chat.turnMemoryDelivered?.size ?? null, contextReceipts: chat.contextDelivered?.size ?? null }
  }
  let last = { from: 'owner', set: null, clientThreadId: null, mark: 0, opted: false }
  return {
    flowOptions: ({ FLAG }) => (active(FLAG) ? { presence: world.mirror, audience: ({ run }) => world.audience({ run }), attentionPosted: ({ key, provider }) => { if (provider === 'work_placement') world.placement?.acknowledgePointer(key) } } : {}),
    attach(deps) {
      const { client, FLAG, calibrationLog = null, limits = {} } = deps
      if (!active(FLAG)) return
      chat = deps.chat; store = deps.store ?? null; requestLog = deps.requestLog ?? []; L = { ...COLLAB_LIMITS, ...(limits?.collab ?? {}) }
      world.start()
      bodies = [] // the Decision requests of the placement runtime (bounded copies)
      // the placement runtime of the bridge (createWorkPlacement), over the check's own Decision client; every request it makes is recorded on the way through
      const recordingClient = client ? { ...client, decide: async request => { bodies.push(request); return client.decide(request) } } : null
      const on = FLAG.EGDESK_WORK_PLACEMENT === 'on' && recordingClient !== null
      placement = createWorkPlacement({ client: recordingClient, mode: () => (on ? 'on' : 'off'), enabled: () => on, live: () => on, calibrationLog, contextFor: (key, options) => chat.placementContextFor(key, options) })
      world.placement = placement
      placementHttp = createWorkPlacementHttpHandler({ placement, heartbeatFor: key => chat.heartbeatFor(key) })
      ready = true
    },
    // before a message turn: who sends it (the script's `from`, the owner by default), told through the bridge's own routes
    async beforeSend({ turn, state, room }) {
      if (!ready) return
      const { clientThreadId, conversationId = null } = state()
      if (room === 'alongside') { // the concurrent run's room: its own sender, told the same way; the main room's own record is not touched
        await world.tell(COLLAB_FROM.includes(turn?.from) ? turn.from : 'owner', { clientThreadId, conversationId })
        return
      }
      const from = COLLAB_FROM.includes(turn?.from) ? turn.from : 'owner'
      // The check's one-time threads are not the owner's direct conversation (whose answers the draft check holds and whose flow may speak). Once the room's live session exists (from the
      // second turn on) it is opted in to the flow's messages, the pointer, as the runtime does for a bounded run, without holding any answer (chat.allowIntermediateMessages, draft check on):
      // it takes effect for the NEXT run of the session, which is why a script puts a turn of the owner's before the first one that expects a pointer.
      const opted = chat.allowIntermediateMessages?.(clientThreadId) === true
      last = { from, set: await world.tell(from, { clientThreadId, conversationId }), clientThreadId, mark: world.flowAudience.length, opted }
    },
    // c29: the old bridge is about to go: what it holds about the room (the new one reads its own against this)
    beforeRestart({ state }) {
      if (!ready) return undefined
      const { clientThreadId, conversationId = null } = state()
      return { clientThreadId, conversationId, facts: roomFacts({ clientThreadId, conversationId }), requester: world.requesters.audience({ run: { clientThreadId, conversationId } })?.requester ?? null }
    },
    // c29: the new bridge is up and the room resumed: what it holds now. The requester registry and the presence snapshot are memory of the old process: empty until the window tells again.
    afterRestart({ carried, expect, state }) {
      if (!ready) return null
      const { clientThreadId, conversationId = null } = state()
      restartedFrom = carried?.conversationId ?? null
      const after = roomFacts({ clientThreadId, conversationId })
      const rec = { restart: { before: carried?.facts ?? null, after, requesterBefore: carried?.requester ?? null, requesterAfter: world.requesters.audience({ run: { clientThreadId, conversationId } })?.requester ?? null } }
      return { record: rec, expectations: expect?.collab === undefined ? [] : checkCollabExpect(expect.collab, rec) }
    },
    async afterTurn({ run, say, answer, turnIndex = 0, expect: turnExpect, alongside = null }) {
      const expect = turnExpect?.collab
      if (!ready || expect === undefined) return null
        const keys = { clientThreadId: run?.clientThreadId ?? last.clientThreadId, conversationId: run?.conversationId ?? null }
        const markBodies = bodies.length
        const rec = { turnIndex, request: clip(say, 200), from: last.from, set: last.set, optedIn: last.opted, audience: null, flowAudience: [], flowAudienceTotal: world.flowAudience.length, ownAnswer: null, attention: null }
        const audience = world.requesters.audience({ run: keys }) // the bridge's own answer for this run
        rec.audience = audience ? { requester: audience.requester, owner: audience.owner } : { requester: null, owner: null }
        rec.flowAudience = world.flowAudience.slice(last.mark).filter(a => a.key === keys.clientThreadId).map(a => ({ requester: a.requester, owner: a.owner })).slice(-8)
        const key = keys.clientThreadId
        // c29, the first message turn after a restart: the room CONTINUES (the same engine thread, resumed on the new engine) and the message was sent once, as the same requester
        if (expect.continuity === true) {
          let row = null, users = null
          try { row = store.getConversation(key) } catch { row = null }
          try { users = store.listMessages(key, { limit: 500 }).messages.filter(m => m.role === 'user' && String(m.text ?? '') === say).length } catch { users = null }
          const resumes = requestLog.filter(r => r.method === 'thread/resume' && !r.error).length
          rec.continuity = { sameThread: !!restartedFrom && row?.conversationId === restartedFrom && (run?.conversationId ?? restartedFrom) === restartedFrom, resumes, resumed: resumes >= 1, userMessages: users, sentOnce: users === 1,
            asRequester: rec.audience.requester === COLLAB_PEOPLE.invited.member ? 'invited' : 'owner' }
        }
        if (expect.twoRuns === true && alongside) rec.twoRuns = await recordTwoRuns({ main: { run, say, answer, key: keys.clientThreadId, from: last.from }, side: alongside })
        // the answering model's own sentences of this turn's answer (the posted answer without the draft check's appended copy), as the placement judge is given them
        try { const live = chat.runFor?.({ conversationId: run?.conversationId, runId: run?.runId, answerId: run?.answerId }); rec.ownAnswer = live ? clip(chat.runOwnAnswerText(live), 1200) : null } catch { rec.ownAnswer = null }
        // the attention scene costs Decision calls and may post a message: only for a turn whose expectation asks for it
        if (expect.attention !== undefined && typeof answer === 'string' && answer.trim() && key) {
          const scene = attentionScene()
          const heartbeat = chat.heartbeatFor(key) ?? null
          const submitted = (await route(placementHttp, '/decision/work-placement/request', { clientThreadId: key, conversationId: keys.conversationId, dto: scene })).body ?? { status: 'invalid' }
          const flows = () => (store ? messageCounts(store, key).flows : 0), flowsBefore = flows(), recordsBefore = placement.records().length
          const att = { submitted: submitted.status, id: submitted.id ?? null, heartbeat: heartbeat ? heartbeat.state ?? 'unknown' : 'none', mayPoint: last.opted, result: null, pointer: 'none', flowMessages: 0, requests: [], landedInsideOthers: null, sceneHasCoordinates: COORDINATE.test(JSON.stringify(scene)) }
          if (submitted.status === 'queued') {
            const deadline = Date.now() + L.attentionWaitMs
            let result = { status: 'pending' }
            while (Date.now() < deadline) { result = (await route(placementHttp, '/decision/work-placement/result', { clientThreadId: key, conversationId: keys.conversationId, id: submitted.id })).body ?? { status: 'unknown' }; if (result.status !== 'pending') break; await sleep(100) }
            await placement.idle()
            att.result = { status: result.status, branch: result.branch ?? null, kind: result.kind ?? null, source: result.source ?? null, forMember: result.forMember ?? null }
            const r = placement.records().slice(recordsBefore).at(-1) ?? null // this scene's own record, never an earlier one
            att.pointer = r?.pointer === 'raised' ? 'raised' : 'none'
            // a raised pointer is carried to the conversation by its flow at a beat: wait (bounded) until it is acknowledged, i.e. the message was posted
            if (att.pointer === 'raised') {
              const until = Date.now() + L.pointerWaitMs
              while (Date.now() < until && placement.facts(key)?.pointerPending === true) await sleep(200)
              if (placement.facts(key)?.pointerPending !== true) att.pointer = 'posted'
            }
            att.flowMessages = flows() - flowsBefore
            att.landedInsideOthers = r?.landed ? r.landed.insideOthers === true : false
            att.record = r ? { kind: r.kind, surface: r.surface, state: r.state ?? null, branch: r.branch ?? null, source: r.source, pointer: r.pointer ?? null, would: r.would } : null
          }
          att.requests = bodies.slice(markBodies).map(request => {
            const text = JSON.stringify(request), shared = (request.input ?? []).map(m => m.content).join('\n')
            return { family: 'work_placement', questions: (request.questions ?? []).map(q => q.name), shared: clip(shared, L.sharedChars),
              identityLeak: identityLeak(text) }
          })
          rec.attention = att
        }
        return { record: rec, expectations: checkCollabExpect(expect, rec) }
    },
    dispose() { world.stop() },
  }

  // c30 (U7): the placement of two concurrent runs on one Desk, and what became of each. The people are the hook's two (presence rows as the bridge holds them), the runs are the turn's two rooms.
  async function recordTwoRuns({ main, side }) {
    const { owner, invited } = COLLAB_PEOPLE
    const rows = world.mirror.snapshot() ?? presenceRows()
    const frozen = deepFreeze(JSON.parse(JSON.stringify(rows)))
    const ownerView = () => { const row = world.mirror.snapshot()?.find(r => r.self); return JSON.stringify(row ? { viewport: row.viewport, focusCard: row.focusCard } : null) }
    const ownerBefore = ownerView(), inputsBefore = JSON.stringify(frozen)
    const surface = { kind: 'file', size: { width: 720, height: 520 } }
    const userCards = [{ id: 'owner-memo', rect: { x: 100, y: 100, width: 500, height: 400 }, kind: 'memo', creator: 'user' }]
    const requesters = { main: main.from === 'invited' ? invited.member : owner.member, side: owner.member }
    const tasks = state => [{ id: 'run-main', state, requester: requesters.main, waiting: [requesters.main], ownerMustAct: false, surfaces: [] }, { id: 'run-side', state, requester: requesters.side, waiting: [requesters.side], ownerMustAct: false, surfaces: [] }]
    const hit = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    // the first run opens its surface, then the second (it finds the first's card already on the canvas)
    const a1 = WP.advisoryPlacement({ presence: frozen, cards: userCards, tasks: tasks('running'), obstacles: [], taskId: 'run-main', surface })
    const card1 = a1?.spot ? { id: 'run-main-viewer', rect: a1.spot, kind: 'file', creator: 'agent', taskId: 'run-main', movable: true } : null
    const a2 = WP.advisoryPlacement({ presence: frozen, cards: [...userCards, ...(card1 ? [card1] : [])], tasks: tasks('running'), obstacles: [], taskId: 'run-side', surface })
    const card2 = a2?.spot ? { id: 'run-side-viewer', rect: a2.spot, kind: 'file', creator: 'agent', taskId: 'run-side', movable: true } : null
    const views = frozen.filter(r => r.active).map(r => r.viewport)
    const placed = (adv, card, run, others) => ({ run, requester: null, rule: adv?.would?.rule ?? null, spot: card ? { ...card.rect } : null,
      outsideViews: !!card && views.every(v => !hit(card.rect, v)), outsideCards: !!card && [...userCards, ...others].every(c => !hit(card.rect, c.rect)) })
    const runs = [placed(a1, card1, 'run-main', []), placed(a2, card2, 'run-side', card1 ? [card1] : [])]
    // the results: both finished; the attention scene of each, built from the canvas and sent to ITS room's live heartbeat
    const finished = (id, requester, cardId) => ({ id, state: 'finished', requester, waiting: [requester], ownerMustAct: false, surfaces: [{ kind: 'result', cardId }] })
    const scene = WP.enumerateWorkScene({ presence: frozen, cards: [...userCards, card1, card2].filter(Boolean), tasks: [finished('run-main', requesters.main, 'run-main-viewer'), finished('run-side', requesters.side, 'run-side-viewer')], obstacles: [] })
    const aliasOf = member => scene.members.find(m => m.member === member)?.alias ?? null
    const rooms = [{ run: 'run-main', key: main.key, card: 'run-main-viewer', requester: requesters.main }, { run: 'run-side', key: side.clientThreadId, card: 'run-side-viewer', requester: requesters.side }]
    const submitted = []
    for (const r of rooms) {
      const req = WP.attentionRequest(scene, { taskId: r.run, cardId: r.card })
      const out = req ? (await route(placementHttp, '/decision/work-placement/request', { clientThreadId: r.key, conversationId: null, dto: req.dto })).body ?? { status: 'invalid' } : { status: 'no-scene' }
      submitted.push({ r, out, requester: aliasOf(r.requester), result: null })
    }
    await Promise.all(submitted.map(async s => {
      if (s.out.status !== 'queued') return
      const deadline = Date.now() + L.attentionWaitMs
      let result = { status: 'pending' }
      while (Date.now() < deadline) { result = (await route(placementHttp, '/decision/work-placement/result', { clientThreadId: s.r.key, conversationId: null, id: s.out.id })).body ?? { status: 'unknown' }; if (result.status !== 'pending') break; await sleep(100) }
      s.result = { status: result.status, branch: result.branch ?? null, kind: result.kind ?? null, forMember: result.forMember ?? null }
    }))
    await placement.idle()
    // each run's Decision judgments: the requests that quote ITS request, and whether they also quote the other run's
    const mentioning = text => bodies.filter(request => (request.input ?? []).map(m => m.content).join('\n').includes(text))
    for (const [i, run] of runs.entries()) {
      const s = submitted[i], mine = i === 0 ? main.say : side.say, theirs = i === 0 ? side.say : main.say
      run.requester = s.requester
      run.attention = { submitted: s.out.status, result: s.result, otherRequesterTold: submitted[1 - i].requester !== run.requester && s.result?.forMember === submitted[1 - i].requester }
      run.judgments = mentioning(mine).map(request => { const shared = (request.input ?? []).map(m => m.content).join('\n'); return { questions: (request.questions ?? []).map(q => q.name), quotesOwn: shared.includes(mine), quotesOther: shared.includes(theirs), identityLeak: identityLeak(JSON.stringify(request)) } })
    }
    // who the bridge's own registry names as the requester of each room, as the turn was sent
    const told = key => world.requesters.audience({ run: { clientThreadId: key, conversationId: null } })?.requester ?? null
    return { people: { main: main.from, side: 'owner' }, told: { main: told(main.key), side: told(side.clientThreadId) }, runs, overlap: !!card1 && !!card2 && hit(card1.rect, card2.rect), ownerBefore, ownerAfter: ownerView(), inputsUnchanged: JSON.stringify(frozen) === inputsBefore, moves: [], judgments: runs.reduce((n, r) => n + r.judgments.length, 0) }
  }
}
