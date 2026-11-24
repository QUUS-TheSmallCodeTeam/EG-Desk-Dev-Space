// L4 cycle 9: the `on` path of the briefing flow, end to end on mounted code. A synthetic canvas with provenance-carrying result cards (real card records, real
// output store ids) -> the chrome's own candidate/request builders -> the production Decisions handler (observe route, mode on, flag "on") -> reuse-first design by a mock
// subjective model -> flow check loop -> PROPOSED briefing through the real ContextRuntime (result cards bound from the bridge's own output store, same validation as
// egdesk_publish_briefing_multi) -> the fold proposal held for the user's own screen (apply / Cmd+Z through the surface history). Fakes: DOM, the provider (synthetic),
// the subjective model and the native app-server of the chat runtime. No network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import * as BriefingHost from '../overlay/resources/EGDeskBriefingHost.sys.mjs'
import { validBriefing } from '../overlay/resources/EGDeskBriefingState.sys.mjs'
import * as WorkbenchArrange from '../overlay/resources/EGDeskWorkbenchArrange.sys.mjs'
import { world } from '../scripts/egdesk-board-world.support.mjs'
import { engineOf, fits, publishSchema, rig } from '../scripts/egdesk-briefing-rig.support.mjs'
import { readFileSync } from 'node:fs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const s = surface.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return surface.slice(s, surface.indexOf('\n  }', s) + 4) }
const toolJson = reply => JSON.parse(reply.result.contentItems[0].text)
const r = (x, y, width, height) => ({ x, y, width, height })

async function harness(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-briefing-publish-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, 'workspace'); await mkdir(cwd)
  let nativeSeq = 0
  const store = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [cwd] })
  const contexts = new ContextRuntime({ store, getOwnerKey: () => 'email:a@example.com' })
  const replies = [], events = []
  const chat = new CodexChatRuntime({ contexts, respond: (id, result, error) => replies.push({ id, result, error }), emit: e => events.push(e),
    request: async (method, params) => {
      if (method === 'thread/start') return { thread: { id: `parent-${++nativeSeq}` }, cwd, model: 'configured-model' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd }
      if (method === 'turn/start') return { turn: { id: `turn-${nativeSeq}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected native method ${method}`)
    } })
  chat.setConnection(true)
  const source = (await contexts.capture({ clientThreadId: 'ui', attachments: [{ id: 'attachment', kind: 'browser', label: 'Selected page', sourceRef: { viewId: 'view-1', resourceId: 'page-1', url: 'https://example.com/p' },
    capturedAt: 10, captureScope: { type: 'dom-range', locator: '#selected' }, content: { mime: 'text/plain', text: 'Original selected text', truncated: false } }] })).captures[0]
  const run = await chat.send({ message: 'Use selected sources', requestId: 'req-1', clientThreadId: 'ui', cwd, contextSnapshotIds: [source.sourceId], contextCapabilities: { read: true, reader: true, publishBriefing: true } })
  const tool = async (name, args, id) => { await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: id, tool: name, arguments: args } }); await contexts.calls.get(`${run.answerId}/${id}`); return replies.find(x => x.id === id) }
  return { dir, store, contexts, chat, events, run, tool, ids: { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId } }
}

const thread = { id: 'thread-1', title: 'Room', engineId: 'codex', profileEnabled: true, agentProfileId: 'prof-agent-1' }
const REPORT = ['## Billing', 'The Invoice totals show the Q3 amount that was billed to the customer.', '', '## Delivery', 'The Delivery log shows the shipment was two days late.', '',
  '## Next steps', 'Refund the delay fee and ship the replacement as soon as possible.'].join('\n')
const design = () => ({ title: 'Why the shipment is late', steps: [
  { text: 'The invoice total shows the Q3 amount that was billed.', targets: ['T1'], fallback: 'Open the invoice totals.' },
  { text: 'The delivery log shows the shipment was two days late.', targets: ['T2'], emphasis: 'outline', fallback: 'Open the delivery log.' }] })
const designWithNew = () => ({ ...design(), steps: [...design().steps, { text: 'The next steps summary lists what to do about it.', targets: ['new:P3'], fallback: 'See the next steps in chat.' }],
  newComponents: [{ part: 'P3', title: 'Next steps summary', summary: 'Refund the delay fee and ship the replacement' }] })

// the board: three result cards the user kept from this room's published outputs (two of this answer, one stale output of an earlier answer, superseded by v2 of its key)
async function scene(t, { withoutBriefingCapability = false } = {}) {
  const h = await harness(t)
  const publish = async (title, markdown, outputKey, id) => toolJson(await h.tool('egdesk_publish_output', { title, markdown, outputKey }, id)).output
  const invoice = await publish('Invoice totals', '# Invoice totals\nQ3 invoice totals and the amount due', 'invoice-totals', 'o1')
  const delivery = await publish('Delivery log', '# Delivery log\nShipment log showing the delay of two days', 'delivery-log', 'o2')
  const oldV1 = await publish('Old shipment summary', '# Old shipment summary\nEarlier summary of the shipment', 'shipment-summary', 'o3')
  const oldV2 = await publish('Old shipment summary', '# Old shipment summary\nRevised summary of the shipment', 'shipment-summary', 'o4')
  const message = { id: 'm1', conversationId: h.run.conversationId, runId: h.run.runId, answerId: h.run.answerId, createdAt: 1 }
  const card = (meta, over = {}) => ChatState.publishedOutputCardRecord({ ...thread, conversationId: h.run.conversationId }, message, { ...meta, ...over }, `# ${meta.title}\nbody of ${meta.title}`, { now: 2 })
  const recA = card(invoice), recB = card(delivery)
  const recOld = ChatState.supersedeResultRecord(card(oldV1, { answerId: 'answer-earlier', runId: 'run-earlier' }), oldV2, { now: 9 })
  const spec = { cards: [{ id: 'vA', item: 'item-A', rect: r(100, 60, 260, 160), z: 1, kind: 'note' }], links: [],
    others: [{ id: 'res-a', rect: r(100, 300, 260, 160), z: 2, result: recA }, { id: 'res-b', rect: r(620, 300, 260, 160), z: 3, result: recB }, { id: 'res-old', rect: r(620, 60, 260, 160), z: 4, result: recOld }] }
  // The outputs above came from earlier turns that had the capability. This answer's run is modelled as one the user sent WITHOUT the briefing capability: the field assertBound
  // checks is false for it (the same binding state a send without the grant produces), while the room's earlier outputs still exist in the store.
  if (withoutBriefingCapability) { const binding = h.contexts.bindings.get(h.contexts.bindingKey(h.chat.runFor(h.ids))); binding.capabilities = { ...binding.capabilities, publishBriefing: false } }
  const W = world({ WorkbenchArrange, http: async () => ({ status: 503, body: {} }), grant: () => true, spec })
  const cards = [{ id: 'res-a', kind: 'result', record: recA, rect: r(100, 300, 260, 160) }, { id: 'res-b', kind: 'result', record: recB, rect: r(620, 300, 260, 160) }, { id: 'res-old', kind: 'result', record: recOld, rect: r(620, 60, 260, 160) }]
  return { h, W, cards, recOld, outputs: { invoice, delivery, oldV1, oldV2 } }
}
const reuseScript = (parts = {}, check = n => ({ u: .96, issues: {} })) => n => n === 0 ? { placement: { value: 'board', p: .94 } } : n === 1 ? { components: { T1: { value: 'reuse', p: .92 }, T2: { value: 'reuse', p: .92 }, T3: { value: 'retrieve', p: .92 } }, parts } : check(n)
function briefingDeps(h, engine) {
  return { engine, runFor: ids => h.chat.runFor(ids), propose: (run, args) => h.contexts.proposeBriefing(run, args), publishOutput: (run, args) => h.contexts.publishOutput(run, args) }
}
const bodyFor = (s, flow = 'on') => BriefingHost.observeRequest({ mode: flow, report: REPORT, answerId: s.h.ids.answerId, conversationId: s.h.ids.conversationId, runId: s.h.ids.runId, candidates: BriefingHost.canvasBriefingCandidates(s.cards) })
async function foldOffer(s, reply) {
  // the surface's own function (compiled from the real source) holds the fold proposal; the arrange wiring (real source) hands it to the panel when the user opens it
  const notices = []
  new Function('state', 'document', 'boardNotice', `${decl('offerBriefingRetrieval')}\noffer = offerBriefingRetrieval;`.replace('offer =', 'arguments[3].offer ='))(s.W.state, s.W.doc, m => notices.push(m), (globalThis.__o = {}))
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

test('data sharing permission seam: when the shared egress permission says no, nothing is asked and nothing is published', async t => {
  const s = await scene(t); const seen = []
  const R = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: briefingDeps(s.h, async () => design()), egress: async kind => { seen.push(kind); return false } } })
  const res = await R.http('POST', '/decision/briefing-observe', bodyFor(s))
  assert.deepEqual([res.body.outcome, res.body.reason], ['bubble', 'declined']); assert.deepEqual(seen, ['placement']); assert.equal(R.calls.length, 0)
  const ok = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: briefingDeps(s.h, async () => design()), egress: async kind => { seen.push(kind); return true } } })
  assert.equal((await ok.http('POST', '/decision/briefing-observe', bodyFor(s))).body.outcome, 'presented'); assert.deepEqual(seen.slice(1), ['placement', 'briefing-reuse', 'briefing-check'])
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
