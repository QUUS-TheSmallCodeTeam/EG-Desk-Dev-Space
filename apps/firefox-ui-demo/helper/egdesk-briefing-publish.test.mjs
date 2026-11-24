// L4 cycle 9: the `on` path of the briefing flow, end to end on mounted code. A synthetic canvas with provenance-carrying result cards (real card records, real
// output store ids) -> the chrome's own candidate/request builders -> the production Decisions handler (observe route, mode on, flag "on") -> reuse-first design by a mock
// subjective model -> flow check loop -> PROPOSED briefing through the real ContextRuntime (result cards bound from the bridge's own output store, same validation as
// egdesk_publish_briefing_multi) -> the fold proposal held for the user's own screen (apply / Cmd+Z through the surface history). Fakes: DOM, the provider (synthetic),
// the subjective model and the native app-server of the chat runtime. No network.
import assert from 'node:assert/strict'
import test from 'node:test'
import * as BriefingHost from '../overlay/resources/EGDeskBriefingHost.sys.mjs'
import { validBriefing } from '../overlay/resources/EGDeskBriefingState.sys.mjs'
import { engineOf, fits, publishSchema, rig } from '../scripts/egdesk-briefing-rig.support.mjs'
import { readFileSync } from 'node:fs'
import { REPORT, design, designWithNew, reuseScript, scene } from './egdesk-briefing-publish.support.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const s = surface.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return surface.slice(s, surface.indexOf('\n  }', s) + 4) }
const r = (x, y, width, height) => ({ x, y, width, height })
void r
function briefingDeps(h, engine) {
  return { engine, runFor: ids => h.chat.runFor(ids), propose: (run, args) => h.contexts.proposeBriefing(run, args), publishOutput: (run, args) => h.contexts.publishOutput(run, args) }
}
const bodyFor = (s, flow = 'on') => BriefingHost.observeRequest({ mode: flow, report: REPORT, answerId: s.h.ids.answerId, conversationId: s.h.ids.conversationId, runId: s.h.ids.runId, candidates: BriefingHost.canvasBriefingCandidates(s.cards) })
async function foldOffer(s, reply, { pref = 'on' } = {}) {
  // the surface's own function (compiled from the real source) holds the fold proposal; the arrange wiring (real source) hands it to the panel when the user opens it
  const notices = []
  new Function('state', 'document', 'boardNotice', 'BriefingHost', 'readSurfacePref', `${decl('offerBriefingRetrieval')}\noffer = offerBriefingRetrieval;`.replace('offer =', 'arguments[5].offer ='))(
    s.W.state, s.W.doc, m => notices.push(m), BriefingHost, name => (name === BriefingHost.BRIEFING_FLOW_PREF ? pref : undefined), (globalThis.__o = {}))
  globalThis.__o.offer(reply); return notices
}

test('on path: 2 reused, the stale output folded on the user screen, 0 new -> a PROPOSED briefing through the real context runtime; retrieval waits for the user and is undoable', async t => {
  const s = await scene(t); const engineLog = []
  const R = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: briefingDeps(s.h, engineOf(engineLog, () => design())) } })
  const before = s.h.events.filter(e => e.event === 'briefing.published').length
  const res = await R.http('POST', '/decision/briefing-observe', bodyFor(s))
  assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body)); assert.deepEqual([res.body.steps, res.body.newComponents, res.body.retrievals], [2, 0, [{ viewId: 'res-old' }]]); assert.equal(res.body.judgeRequests, 3)
  assert.equal(R.calls.length, 3, 'placement + reuse + one flow check')
  // published as PROPOSED through the same path as the tool: record, event, run context; every target was bound from the bridge's own output store
  const published = s.h.events.filter(e => e.event === 'briefing.published'); assert.equal(published.length, before + 1)
  const briefing = s.h.chat.runFor(s.h.ids).context.briefings.at(-1); assert.equal(briefing.presentationStatus, 'proposed'); assert.equal(briefing.id, res.body.briefingId)
  assert.deepEqual(briefing.steps.map(x => [x.id, x.targets.length, x.targets[0].viewId]), [['s1', 1, 'res-a'], ['s2', 1, 'res-b']]); assert.equal(briefing.steps[1].emphasis, 'outline')
  assert.equal(validBriefing({ id: briefing.id, title: briefing.title, steps: briefing.steps }), true)
  const binding = s.h.contexts.bindings.get(s.h.contexts.bindingKey(s.h.chat.runFor(s.h.ids)))
  for (const step of briefing.steps) { const cap = binding.captures.find(c => c.sourceId === step.targets[0].sourceId); assert.equal(cap.kind, 'board'); assert.ok(binding.sourceIds.includes(cap.sourceId)) }
  assert.equal(binding.captures.some(c => c.source.resourceId === s.outputs.oldV1.id), false, 'the stale output is not bound: it is not part of the briefing')
  const stored = await s.h.store.listRecords(binding.ownerKey, 'briefings', x => x.id === briefing.id); assert.equal(stored.length, 1)
  // the final answer itself is still the chat answer: nothing else was published, no new component made
  assert.equal(s.h.events.filter(e => e.event === 'output.published').length, 4, 'only the four outputs the Agent itself published')
  // the subjective model was constrained to reuse
  assert.deepEqual(engineLog[0].targets.map(x => x.alias), ['T1', 'T2']); assert.deepEqual([engineLog[0].reuse, engineLog[0].retire, engineLog[0].maxNew], [['T1', 'T2'], ['T3'], 0])
  // the retrieval proposal: held, not shown, not applied; the user opens the panel -> preview -> apply -> undo
  const notices = await foldOffer(s, res.body); assert.equal(notices.length, 1); assert.deepEqual(s.W.collapsedIds(), [])
  assert.deepEqual(s.W.state.briefingRetrievalOffer, { option: 'retrieval', collapse: [{ id: 'res-old', value: true }] })
  const s0 = s.W.seen(); await s.W.real.arrange().open('@desk', null)
  assert.ok(s.W.control('retrieval')?.checked, 'the preview is there only because the user opened the panel'); assert.equal(s.W.state.briefingRetrievalOffer, null, 'consumed once'); assert.deepEqual(s.W.collapsedIds(), [])
  s.W.control('apply').fire('click'); for (let i = 0; i < 400 && s.W.control('apply'); i++) await new Promise(x => setTimeout(x, 5))
  assert.deepEqual(s.W.collapsedIds(), ['res-old']); assert.deepEqual(s.W.seen(), s0); assert.equal(s.W.fetches.length, 0, 'no shared Board write')
  s.W.key(); assert.deepEqual(s.W.collapsedIds(), []); s.W.key(true); assert.deepEqual(s.W.collapsedIds(), ['res-old'])
  const rows = R.calibration.entries(); assert.equal(rows.length, 3); assert.ok(!/Invoice|Delivery|Old shipment|res-|src-/.test(JSON.stringify(rows)))
  assert.equal(R.budget.snapshot().inputTokens, 33)
})

test('on path: one required new component -> exactly one new output is created by the Agent\'s own publish path, then bound and used by its step', async t => {
  const s = await scene(t); const engineLog = []
  const engine = async request => { engineLog.push(request); return request.kind === 'briefing_component' ? { markdown: '# Next steps summary\nRefund the delay fee and ship the replacement.' } : designWithNew() }
  const R = rig(t, { mode: 'on', script: reuseScript({ P3: .91 }), handlerOptions: { briefing: briefingDeps(s.h, engine) } })
  const outputsBefore = s.h.events.filter(e => e.event === 'output.published').length
  const res = await R.http('POST', '/decision/briefing-observe', bodyFor(s))
  assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body)); assert.deepEqual([res.body.steps, res.body.newComponents], [3, 1])
  assert.equal(s.h.events.filter(e => e.event === 'output.published').length, outputsBefore + 1, 'exactly one new component')
  assert.deepEqual(engineLog.map(x => x.kind), ['briefing_design', 'briefing_component']); assert.deepEqual(engineLog[0].newAllowed, [{ part: 'P3', label: 'Next steps' }])
  const run = s.h.chat.runFor(s.h.ids), briefing = run.context.briefings.at(-1); assert.equal(briefing.steps.length, 3)
  const last = briefing.steps[2], binding = s.h.contexts.bindings.get(s.h.contexts.bindingKey(run)), cap = binding.captures.find(c => c.sourceId === last.targets[0].sourceId)
  assert.equal(cap.label, 'Next steps summary'); assert.equal(last.targets[0].viewId, undefined, 'not on the canvas yet: the step explains, nothing is lit up until the user opens the result')
  assert.equal(validBriefing({ id: briefing.id, title: briefing.title, steps: briefing.steps }), true)
})

test('on path fallbacks: nothing is published, nothing is offered, the chat answer stays', async t => {
  const none = async (script, handlerBriefing, opts = {}) => {
    const s = await scene(t, opts); const engineLog = []
    const R = rig(t, { mode: 'on', script, handlerOptions: handlerBriefing === null ? {} : { briefing: briefingDeps(s.h, engineOf(engineLog, handlerBriefing ?? (() => design()))) } })
    const before = s.h.events.filter(e => e.event === 'briefing.published' || e.event === 'output.published').length
    const res = await R.http('POST', '/decision/briefing-observe', bodyFor(s)); const after = s.h.events.filter(e => e.event === 'briefing.published' || e.event === 'output.published').length
    return { s, R, res, engineLog, published: after - before }
  }
  // an inconclusive check ends in chat after the bound
  const inc = await none(reuseScript({ P3: .1 }, () => ({ u: .5, issues: { explanation_mismatch_S2: .6 } })))
  assert.deepEqual([inc.res.body.outcome, inc.res.body.reason, inc.published], ['fallback-chat', 'check-inconclusive', 0]); assert.equal(inc.res.body.retrievals, undefined)
  const sw = await foldOffer(inc.s, inc.res.body); assert.deepEqual(sw, []); assert.equal(inc.s.W.state.briefingRetrievalOffer ?? null, null)
  // the judge says bubble: no design at all
  const bubble = await none(n => ({ placement: { value: 'bubble', p: .93 } })); assert.deepEqual([bubble.res.body.outcome, bubble.engineLog.length, bubble.published], ['bubble', 0, 0])
  // no briefing capability for that run: the existing permission refuses; nothing created, nothing offered
  const nocap = await none(reuseScript({ P3: .1 }), undefined, { withoutBriefingCapability: true })
  assert.deepEqual([nocap.res.body.outcome, nocap.res.body.reason, nocap.published], ['fallback-chat', 'publish-failed', 0])
  // a new component whose body the subjective model does not deliver: no output, no briefing
  const nobody = await none(reuseScript({ P3: .91 }), request => request.kind === 'briefing_component' ? null : designWithNew())
  assert.deepEqual([nobody.res.body.outcome, nobody.res.body.reason, nobody.published], ['fallback-chat', 'publish-failed', 0])
  // not wired / wrong flag / gone run
  assert.deepEqual((await none(reuseScript(), null)).res.body, { status: 'skipped', reason: 'no-engine' })
  const s = await scene(t); const R = rig(t, { mode: 'on', script: reuseScript(), handlerOptions: { briefing: briefingDeps(s.h, async () => design()) } })
  assert.deepEqual((await R.http('POST', '/decision/briefing-observe', bodyFor(s, 'advisory'))).body, { status: 'skipped', reason: 'mode' })
  assert.deepEqual((await R.http('POST', '/decision/briefing-observe', { ...bodyFor(s), runId: 'gone' })).body, { status: 'skipped', reason: 'run-gone' }); assert.equal(R.calls.length, 0)
})

test('data sharing (D2): the briefing judgments follow the shared egress gate and nothing else; allowed publishes, denied sends and publishes nothing', async t => {
  const { createEgressGate, modelDataPermissions } = await import('./egdesk-decision-egress.mjs')
  const { runBriefingFlow } = await import('./egdesk-briefing-flow.mjs')
  const s = await scene(t)
  const candidates = BriefingHost.canvasBriefingCandidates(s.cards)
  // allowed: the handler derives the gate from the same permissions (canvas cards the host marked maySend), so the live path runs end to end
  const R = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: briefingDeps(s.h, async () => design()) } })
  assert.equal((await R.http('POST', '/decision/briefing-observe', bodyFor(s))).body.outcome, 'presented')
  // every judgment (placement, reuse/retrieve, flow check) is asked of the shared gate with the canvas_text kind before it is sent
  const asked = []; const spy = { allows: kind => { asked.push(kind); return true } }
  const R2 = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }) })
  const ok = await runBriefingFlow({ report: REPORT, candidates, currentAnswerId: s.h.ids.answerId, egress: spy, decide: R2.decide, engine: async () => design(), allow: async () => true })
  assert.equal(ok.status, 'presented'); assert.deepEqual(asked, ['canvas_text', 'canvas_text', 'canvas_text']); assert.equal(R2.calls.length, 3)
  // denied by the shared permissions (no canvas data may go to a model): zero requests, no design, nothing published or offered
  const R3 = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }) }); const engineLog = []
  const denied = await runBriefingFlow({ report: REPORT, candidates, currentAnswerId: s.h.ids.answerId, egress: createEgressGate(modelDataPermissions({ canvasMaySend: false })), decide: R3.decide, engine: engineOf(engineLog, () => design()), allow: async () => true })
  assert.deepEqual([denied.status, denied.reason], ['bubble', 'declined']); assert.equal(R3.calls.length, 0); assert.equal(engineLog.length, 0)
  // and at the handler: no card the host may send means no candidate at all, so nothing is asked and nothing is published
  const before = s.h.events.filter(e => e.event === 'briefing.published' || e.event === 'output.published').length
  const R4 = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: briefingDeps(s.h, async () => design()) } })
  const blocked = bodyFor(s); blocked.candidates = blocked.candidates.map(c => ({ ...c, maySend: false }))
  const res = await R4.http('POST', '/decision/briefing-observe', blocked)
  assert.deepEqual([res.body.outcome, res.body.reason], ['bubble', 'no-board-targets']); assert.equal(R4.calls.length, 0)
  assert.equal(s.h.events.filter(e => e.event === 'briefing.published' || e.event === 'output.published').length, before)
  // one mechanism: the handler has no separate consent or egress option of its own
  const src = readFileSync(new URL('./egdesk-board-presentation-http.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /const consent = |egress = null/); assert.match(src, /allow: async \(\) => true/)
})

test('result card binding: only a published output of this conversation, only with the run\'s briefing capability, same validation as the tool', async t => {
  const s = await scene(t); const run = s.h.chat.runFor(s.h.ids)
  const cap = await s.h.contexts.bindCardSource(run, { outputId: s.outputs.invoice.id, viewId: 'res-a' }); assert.equal(cap.kind, 'board'); assert.equal(cap.source.resourceId, s.outputs.invoice.id)
  assert.equal((await s.h.contexts.bindCardSource(run, { outputId: s.outputs.invoice.id, viewId: 'res-a' })).sourceId, cap.sourceId, 'idempotent')
  for (const bad of [{ outputId: 'not-an-id' }, { outputId: '00000000-0000-4000-8000-000000000000' }, { outputId: s.outputs.invoice.id, viewId: '' }]) await assert.rejects(() => s.h.contexts.bindCardSource(run, bad))
  await assert.rejects(() => s.h.contexts.proposeBriefing(run, { title: 'x', steps: [{ id: 's1', text: 't', fallback: 'f', targets: [{ outputId: s.outputs.invoice.id, extra: 1 }] }] }), /outputId and viewId only/)
  const noCap = await scene(t, { withoutBriefingCapability: true }); await assert.rejects(() => noCap.h.contexts.bindCardSource(noCap.h.chat.runFor(noCap.h.ids), { outputId: noCap.outputs.invoice.id }))
  fits(publishSchema, { title: 'ok', steps: [{ id: 's1', text: 't', fallback: 'f', targets: [{ sourceId: cap.sourceId, viewId: 'res-a' }] }] })
})

test('cycle 22, the person\'s side: a late fold offer is re-checked against the screen as it is NOW: flag still on, the Agent\'s own result cards only, never a shared-Board card or one already folded', async t => {
  const reply = { outcome: 'presented', retrievals: [{ viewId: 'res-old' }, { viewId: 'res-a' }, { viewId: 'res-b' }, { viewId: 'gone' }] }
  const off = await scene(t); assert.deepEqual(await foldOffer(off, reply, { pref: 'advisory' }), []); assert.equal(off.W.state.briefingRetrievalOffer ?? null, null, 'flag turned away from "on" while the flow ran: nothing is offered')
  const s = await scene(t)
  s.W.doc.getElementById('res-a').dataset.jointManaged = 'card' // moved onto a shared Board meanwhile
  s.W.doc.getElementById('res-b')._resultRecord = { ...s.W.doc.getElementById('res-b')._resultRecord, provenance: null } // not recorded as the Agent's own
  const notices = await foldOffer(s, reply)
  assert.equal(notices.length, 1); assert.deepEqual(s.W.state.briefingRetrievalOffer, { option: 'retrieval', collapse: [{ id: 'res-old', value: true }] })
  assert.deepEqual(s.W.collapsedIds(), [], 'an offer only: nothing is folded, moved or opened until the person applies it')
  const folded = await scene(t); folded.W.doc.getElementById('res-old').classList.add('egd-card-collapsed')
  assert.deepEqual(await foldOffer(folded, { outcome: 'presented', retrievals: [{ viewId: 'res-old' }] }), []); assert.equal(folded.W.state.briefingRetrievalOffer ?? null, null, 'already folded: no offer, no notice')
})
