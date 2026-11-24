// L4 cycle 11: the subjective model's side of the briefing flow, on L3's internal turns. The same model that wrote the answer designs / redesigns the briefing and
// writes a new component's text on a PRIVATE fork; replies are parsed and validated by the flow's own validators; everything is bounded; any failure leaves the chat answer.
// Mounted: real CodexChatRuntime (internal turns over a mock native app-server, as in the held-answers tests), real ContextRuntime + store, the production Decisions
// handler with the bridge's own dependency factory (briefingDeps), the chrome's request builders, the surface history. Fakes: DOM, provider (synthetic), native app-server.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as BriefingHost from '../overlay/resources/EGDeskBriefingHost.sys.mjs'
import { validBriefing } from '../overlay/resources/EGDeskBriefingState.sys.mjs'
import { BRIEFING_CHROME_WAIT_MS, BRIEFING_ENGINE_LIMITS, BRIEFING_FILL_EFFORT, briefingDeps, componentPrompt, createBriefingEngine, designPrompt, parseEngineJson, redesignPrompt, shapeDesign } from './egdesk-briefing-engine.mjs'
import { resolveDesign, enumerateBriefingFacts } from './egdesk-briefing-flow.mjs'
import { REPORT, design, designWithNew, reuseScript, scene, harness } from './egdesk-briefing-publish.support.mjs'
import { rig } from '../scripts/egdesk-briefing-rig.support.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const s = surface.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return surface.slice(s, surface.indexOf('\n  }', s) + 4) }
const json = value => '```json\n' + JSON.stringify(value) + '\n```'
const bodyFor = s => BriefingHost.observeRequest({ mode: 'on', report: REPORT, answerId: s.h.ids.answerId, conversationId: s.h.ids.conversationId, runId: s.h.ids.runId, candidates: BriefingHost.canvasBriefingCandidates(s.cards) })
// These journeys are the EARLIER order (the subjective model designs, the Decision model checks), kept behind the internal switch for comparison (cycle 13 made skeleton-first the default).
const deps = (s, enabled = true) => briefingDeps({ chat: s.h.chat, contexts: s.h.contexts, enabled, order: 'design-first' })
const count = (s, event) => s.h.events.filter(e => e.event === event).length
const index = (s, event, from = 0) => s.h.events.findIndex((e, i) => i >= from && e.event === event)

// ---------------- 1. parsing and shaping: structured output only ----------------
test('reply parsing: one JSON object (fences and prose tolerated), reduced to the closed design shape; anything else is null', () => {
  const d = designWithNew()
  assert.deepEqual(shapeDesign(parseEngineJson(json(d))), d)
  assert.deepEqual(shapeDesign(parseEngineJson(`Here it is:\n${JSON.stringify(d)}\nDone.`)), d)
  for (const bad of ['', 'no json here', '{"steps": ', '[1,2]', 'x'.repeat(BRIEFING_ENGINE_LIMITS.replyMax + 1), null, 42]) assert.equal(shapeDesign(parseEngineJson(bad)), null, String(bad).slice(0, 20))
  assert.equal(shapeDesign({ title: 'x' }), null, 'no steps array')
  const noisy = shapeDesign({ title: 't', evil: 'drop me', steps: [{ text: 'a', targets: ['T1', 7, { x: 1 }], fallback: 'f', tool: 'run', viewId: 'v' }, 'junk'], newComponents: [{ part: 'P1', title: 'n', summary: 's', path: '/etc' }, 5] })
  assert.deepEqual(noisy, { title: 't', steps: [{ text: 'a', targets: ['T1'], fallback: 'f' }, { text: '', targets: [] }], newComponents: [{ part: 'P1', title: 'n', summary: 's' }] }, 'unknown fields and non-string targets are dropped')
  // the flow's validator still decides: a shaped reply that breaks the rules is refused there
  const e = enumerateBriefingFacts({ report: 'Alpha one and Beta two matter.', candidates: [{ id: 'a', ref: { outputId: 'x' }, kind: 'output', label: 'Alpha one', onBoard: true, maySend: true }, { id: 'b', ref: { outputId: 'y' }, kind: 'output', label: 'Beta two', onBoard: true, maySend: true }] })
  assert.equal(resolveDesign(noisy, e).ok, false)
})
test('prompts: the answer, the aliases and the reviewer findings travel; the frame forbids tools and addressing the person', () => {
  const request = { kind: 'briefing_design', facts: { referenced: 2 }, reuse: ['T1', 'T2'], retire: ['T3'], newAllowed: [], maxNew: 0, targets: [{ alias: 'T1', kind: 'output', label: 'Invoice totals' }], reply: 'old instruction' }
  const p = designPrompt(request, REPORT)
  for (const piece of ['<answer>', 'Delivery log shows', '"reuse":["T1","T2"]', 'Invoice totals', 'exactly one JSON object', 'Do not use tools', 'language of your answer']) assert.ok(p.includes(piece), piece)
  assert.ok(!p.includes('old instruction'))
  const rp = redesignPrompt({ kind: 'briefing_redesign', revision: 1, remaining: 1, findings: [{ item: 'explanation_mismatch', scope: 'S2', aliases: ['S2', 'T2'], p: .9 }], where: { alias: 'S2', p: .9 }, previous: [{ alias: 'S2', text: 'old text', targets: ['T2'] }], reuse: ['T1', 'T2'] }, REPORT)
  for (const piece of ['explanation_mismatch', '"scope":"S2"', 'old text', 'Fix only what the reviewer named']) assert.ok(rp.includes(piece), piece)
  assert.ok(redesignPrompt({ kind: 'briefing_redesign', invalid: 'reuse-unused', previous: null }).includes('reason code: reuse-unused'))
  assert.ok(redesignPrompt({ kind: 'briefing_redesign_inconclusive', note: 'be specific', previous: [] }).includes('be specific'))
  const cp = componentPrompt({ title: 'Next steps summary', summary: 'Refund and ship' }, REPORT); assert.ok(cp.includes('Next steps summary') && cp.includes('only the component content as markdown') && cp.includes('add no new claims'))
})
test('engine bounds: turns, total time, per-turn time, reply size; a thrown or empty turn is null; unknown requests cost nothing', async () => {
  let clock = 0; const calls = []
  const engine = createBriefingEngine({ report: REPORT, now: () => clock, limits: { maxTurns: 3, totalMs: 50_000, turnMs: 30_000 },
    runText: async (prompt, { timeoutMs }) => { calls.push(timeoutMs); clock += 20_000; return calls.length === 2 ? null : JSON.stringify(design()) } })
  assert.equal(await engine({ kind: 'something_else' }), null); assert.equal(calls.length, 0)
  assert.deepEqual(await engine({ kind: 'briefing_design', targets: [] }), design())
  assert.equal(await engine({ kind: 'briefing_redesign', invalid: 'x' }), null, 'the turn returned nothing')
  assert.deepEqual(await engine({ kind: 'briefing_redesign_inconclusive' }), design())
  assert.equal(await engine({ kind: 'briefing_design' }), null, 'the turn bound is spent')
  assert.deepEqual(calls, [30_000, 30_000, 10_000], 'the last turn only gets what is left of the total time')
  assert.deepEqual(engine.stats(), { turns: 3, refused: 1, elapsedMs: 60_000 })
  const late = createBriefingEngine({ now: () => clock, limits: { totalMs: 10 }, runText: async () => { clock += 11; return JSON.stringify(design()) } })
  assert.ok(await late({ kind: 'briefing_design' })); assert.equal(await late({ kind: 'briefing_design' }), null, 'total time spent')
  const thrower = createBriefingEngine({ runText: async () => { throw new Error('fork failed') } }); assert.equal(await thrower({ kind: 'briefing_design' }), null)
  const big = createBriefingEngine({ runText: async () => 'x'.repeat(BRIEFING_ENGINE_LIMITS.replyMax + 1) }); assert.equal(await big({ kind: 'briefing_design' }), null)
  const comp = createBriefingEngine({ limits: { componentMax: 20 }, runText: async () => '```markdown\n# Title\n' + 'body '.repeat(50) + '\n```' })
  const made = await comp({ kind: 'briefing_component', title: 't', summary: 's' }); assert.equal(made.markdown.length, 20); assert.ok(made.markdown.startsWith('# Title'))
  assert.equal(await createBriefingEngine({ runText: async () => '   ' })({ kind: 'briefing_component' }), null)
  assert.throws(() => createBriefingEngine({}), /runText/)
})

// ---------------- 2. finished-run publishing ----------------
test('a finished run still allows the proposal: its binding outlives the turn, also after a newer answer in the same conversation', async t => {
  const s = await scene(t); const run = s.h.chat.runFor(s.h.ids)
  assert.equal(run.status, 'completed')
  const proposed = await s.h.contexts.proposeBriefing(run, { title: 'After the turn', steps: [{ id: 's1', text: 'The invoice.', fallback: 'Open it.', targets: [{ outputId: s.outputs.invoice.id, viewId: 'res-a' }] }] })
  assert.equal(proposed.presentationStatus, 'proposed'); assert.equal(proposed.answerId, s.h.ids.answerId)
  const event = s.h.events.filter(e => e.event === 'briefing.published').at(-1); assert.deepEqual([event.runId, event.answerId, event.details.briefing.id], [s.h.ids.runId, s.h.ids.answerId, proposed.id], 'the event belongs to the finished answer')
  // a second message in the same conversation starts a newer run; the first answer's briefing can still be proposed and still lands on the first answer
  const next = await s.h.chat.send({ message: 'One more thing', requestId: 'req-2', clientThreadId: 'ui', conversationId: s.h.ids.conversationId, cwd: s.h.cwd, contextCapabilities: { read: true, reader: true, publishBriefing: true } })
  assert.notEqual(next.answerId, s.h.ids.answerId)
  const again = await s.h.contexts.proposeBriefing(run, { title: 'Still the first answer', steps: [{ id: 's1', text: 'The log.', fallback: 'Open it.', targets: [{ outputId: s.outputs.delivery.id, viewId: 'res-b' }] }] })
  assert.equal(again.answerId, s.h.ids.answerId); assert.equal(s.h.events.filter(e => e.event === 'briefing.published').at(-1).answerId, s.h.ids.answerId)
})

// ---------------- 3. end to end, the engine speaking through the internal-turn path ----------------
async function foldOffer(s, reply) {
  const notices = [], box = {}
  // the journey runs with the chrome flag "on" (cycle 22: the offer re-reads it when the reply arrives)
  new Function('state', 'document', 'boardNotice', 'BriefingHost', 'readSurfacePref', 'box', `${decl('offerBriefingRetrieval')}\nbox.offer = offerBriefingRetrieval;`)(s.W.state, s.W.doc, m => notices.push(m), BriefingHost, name => (name === BriefingHost.BRIEFING_FLOW_PREF ? 'on' : undefined), box)
  box.offer(reply); return notices
}
const noDraftLeak = (s, pieces) => { const wire = JSON.stringify(s.h.events); for (const piece of pieces) assert.ok(!wire.includes(piece), `nothing of the private turn reaches the chat: ${piece}`) }

test('e2e reuse 2 / fold 1 / new 0: the design comes from ONE private fork turn of the answer\'s own model; answer first, then the proposal; no draft is ever visible', async t => {
  const s = await scene(t, { forkReply: () => json(design()) })
  const R = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: deps(s) } })
  const completedAt = index(s, 'run.completed'), messagesBefore = count(s, 'message.completed'); assert.ok(completedAt >= 0)
  const res = await R.http('POST', '/decision/briefing-observe', bodyFor(s))
  assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body)); assert.deepEqual([res.body.steps, res.body.newComponents, res.body.retrievals], [2, 0, [{ viewId: 'res-old' }]])
  // the private turn: a fork of THIS conversation, one turn, released afterwards
  assert.deepEqual(s.h.native.filter(([m]) => m === 'thread/fork'), [['thread/fork', s.h.ids.conversationId]]); assert.equal(s.h.forkPrompts.length, 1)
  assert.ok(s.h.forkPrompts[0].includes('<answer>') && s.h.forkPrompts[0].includes('"reuse":["T1","T2"]') && s.h.forkPrompts[0].includes('"maxNew":0'))
  for (const hidden of ['res-a', 'res-old', s.outputs.invoice.id, 'sourceId']) assert.ok(!s.h.forkPrompts[0].includes(hidden), 'the design request names aliases, never ids: ' + hidden)
  // sequence: the answer message and the end of the run come first, the proposal after; the proposal is the only new chat event besides its source bindings
  const after = s.h.events.slice(completedAt + 1).map(e => e.event)
  assert.deepEqual(after.filter(e => e !== 'context.bound'), ['briefing.published']); assert.equal(count(s, 'message.completed'), messagesBefore, 'no new chat message of any kind')
  assert.ok(index(s, 'message.completed') < completedAt && completedAt < index(s, 'briefing.published'))
  noDraftLeak(s, ['You are preparing an Answer Briefing', 'Open the invoice totals.\\"', '"reuse":["T1","T2"]'])
  const briefing = s.h.chat.runFor(s.h.ids).context.briefings.at(-1)
  assert.equal(briefing.presentationStatus, 'proposed'); assert.deepEqual(briefing.steps.map(x => x.targets[0].viewId), ['res-a', 'res-b']); assert.equal(validBriefing({ id: briefing.id, title: briefing.title, steps: briefing.steps }), true)
  assert.equal(briefing.steps[1].text, 'The delivery log shows the shipment was two days late.', 'the step text is the model\'s own, validated')
  // fold proposal: held, then the user's own apply and undo
  assert.equal((await foldOffer(s, res.body)).length, 1); await s.W.real.arrange().open('@desk', null); assert.ok(s.W.control('retrieval')?.checked)
  s.W.control('apply').fire('click'); for (let i = 0; i < 400 && s.W.control('apply'); i++) await new Promise(x => setTimeout(x, 5))
  assert.deepEqual(s.W.collapsedIds(), ['res-old']); s.W.key(); assert.deepEqual(s.W.collapsedIds(), [])
  assert.equal(R.calls.length, 3); assert.equal(R.budget.snapshot().inputTokens, 33)
})

test('e2e one new component: design turn + one component turn; exactly one new result is published by the finished run, then the proposal', async t => {
  const s = await scene(t, { forkReply: prompt => /ONE new board component/.test(prompt) ? '# Next steps summary\nRefund the delay fee and ship the replacement.' : json(designWithNew()) })
  const R = rig(t, { mode: 'on', script: reuseScript({ P3: .91 }), handlerOptions: { briefing: deps(s) } })
  const outputsBefore = count(s, 'output.published'), completedAt = index(s, 'run.completed')
  const res = await R.http('POST', '/decision/briefing-observe', bodyFor(s))
  assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body)); assert.deepEqual([res.body.steps, res.body.newComponents], [3, 1])
  assert.equal(s.h.forkPrompts.length, 2); assert.ok(s.h.forkPrompts[0].includes('"newAllowed":[{"part":"P3","label":"Next steps"}]')); assert.ok(s.h.forkPrompts[1].includes('Component title: Next steps summary'))
  assert.equal(count(s, 'output.published'), outputsBefore + 1)
  const after = s.h.events.slice(completedAt + 1).map(e => e.event).filter(e => e !== 'context.bound'); assert.deepEqual(after, ['output.published', 'briefing.published'], 'the new result first, then the briefing that points at it')
  const made = s.h.events.filter(e => e.event === 'output.published').at(-1).details.output; assert.equal(made.title, 'Next steps summary'); assert.equal(made.answerId, s.h.ids.answerId)
  assert.equal(JSON.stringify(made).includes('Refund the delay fee'), false, 'the event carries metadata only')
  assert.equal(s.h.chat.runFor(s.h.ids).context.briefings.at(-1).steps.length, 3)
})

test('e2e flow-check redesign loop: the reviewer\'s finding goes back to the same model on a second private turn; the fixed design is what is proposed', async t => {
  const bad = () => { const d = design(); d.steps[1].text = 'The invoice total was disputed by the customer.'; return d }
  const s = await scene(t, { forkReply: (prompt, i) => json(i === 0 ? bad() : design()) })
  const R = rig(t, { mode: 'on', handlerOptions: { briefing: deps(s) },
    script: reuseScript({ P3: .1 }, n => n === 2 ? { u: .12, issues: { explanation_mismatch_S2: .93 }, where: { value: 'S2', p: .9 } } : { u: .96, issues: {} }) })
  const res = await R.http('POST', '/decision/briefing-observe', bodyFor(s))
  assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body)); assert.equal(res.body.judgeRequests, 4, 'placement, reuse, check, re-check')
  assert.equal(s.h.forkPrompts.length, 2); assert.equal(s.h.native.filter(([m]) => m === 'thread/fork').length, 2)
  for (const piece of ['explanation_mismatch', '"scope":"S2"', 'The invoice total was disputed by the customer.', '"reuse":["T1","T2"]']) assert.ok(s.h.forkPrompts[1].includes(piece), piece)
  assert.equal(count(s, 'briefing.published'), 1, 'only the design that passed is proposed')
  assert.equal(s.h.chat.runFor(s.h.ids).context.briefings.at(-1).steps[1].text, 'The delivery log shows the shipment was two days late.')
  noDraftLeak(s, ['The invoice total was disputed by the customer.'])
})

test('e2e fallbacks: a model that will not produce a usable design, a failing fork, an engine that cannot fork, a switched-off engine -> the chat answer stays, nothing is proposed', async t => {
  const outcome = async (options, enabled = true, script = reuseScript({ P3: .1 })) => {
    const s = await scene(t, options); const R = rig(t, { mode: 'on', script, handlerOptions: { briefing: deps(s, enabled) } })
    const before = s.h.events.length; const res = await R.http('POST', '/decision/briefing-observe', bodyFor(s))
    return { s, R, res, added: s.h.events.slice(before).map(e => e.event) }
  }
  // prose instead of JSON, three times (design + two bounded retries)
  const prose = await outcome({ forkReply: () => 'I think the briefing should start with the invoice.' })
  assert.deepEqual([prose.res.body.outcome, prose.res.body.reason, prose.s.h.forkPrompts.length, prose.added], ['fallback-chat', 'design-invalid', 3, []]); assert.equal(prose.R.calls.length, 2, 'no flow check is paid for a design that never resolved')
  assert.ok(prose.s.h.forkPrompts[1].includes('reason code: no-title'))
  // a design that breaks the reuse constraint every time
  const stubborn = await outcome({ forkReply: () => json({ title: 't', steps: [{ text: 'only one', targets: ['T3'], fallback: 'f' }] }) })
  assert.deepEqual([stubborn.res.body.reason, stubborn.added], ['design-invalid', []]); assert.ok(stubborn.s.h.forkPrompts[1].includes('reason code: not-reusable-target'))
  // the private turn fails (the fork turn ends without completing)
  const failing = await outcome({ forkReply: () => null }); assert.deepEqual([failing.res.body.outcome, failing.res.body.reason, failing.added], ['fallback-chat', 'design-invalid', []])
  // the engine refuses to fork at all
  const noFork = await outcome({ forkReply: () => json(design()), forkOk: false }); assert.deepEqual([noFork.res.body.outcome, noFork.res.body.reason, noFork.s.h.forkPrompts.length, noFork.added], ['fallback-chat', 'design-invalid', 0, []])
  // a component whose text the model does not deliver: nothing is published at all (no half-made set)
  const noBody = await outcome({ forkReply: prompt => /ONE new board component/.test(prompt) ? '  ' : json(designWithNew()) }, true, reuseScript({ P3: .91 }))
  assert.deepEqual([noBody.res.body.outcome, noBody.res.body.reason, noBody.added], ['fallback-chat', 'publish-failed', []])
  // an inconclusive flow check ends in chat after the bound: three private turns, no proposal, no fold offer
  const unsure = await outcome({ forkReply: () => json(design()) }, true, reuseScript({ P3: .1 }, () => ({ u: .5, issues: { explanation_mismatch_S2: .6 } })))
  assert.deepEqual([unsure.res.body.outcome, unsure.res.body.reason, unsure.s.h.forkPrompts.length, unsure.added], ['fallback-chat', 'check-inconclusive', 3, []]); assert.equal(unsure.res.body.retrievals, undefined)
  // switched off on the bridge (the default): nothing is asked of anyone
  const off = await outcome({ forkReply: () => json(design()) }, false)
  assert.deepEqual(off.res.body, { status: 'skipped', reason: 'no-engine' }); assert.equal(off.R.calls.length, 0); assert.equal(off.s.h.forkPrompts.length, 0); assert.deepEqual(off.added, [])
})

test('guards: only a completed answer gets a briefing, and only once', async t => {
  const working = await scene(t, { finished: false, forkReply: () => json(design()) })
  const R = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: deps(working) } })
  assert.deepEqual((await R.http('POST', '/decision/briefing-observe', bodyFor(working))).body, { status: 'skipped', reason: 'run-not-completed' }); assert.equal(R.calls.length, 0); assert.equal(working.h.forkPrompts.length, 0)
  const s = await scene(t, { forkReply: () => json(design()) }); const R2 = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: deps(s) } })
  const [first, second] = await Promise.all([R2.http('POST', '/decision/briefing-observe', bodyFor(s)), R2.http('POST', '/decision/briefing-observe', bodyFor(s))])
  assert.deepEqual([first.body.outcome, second.body], ['presented', { status: 'skipped', reason: 'already' }]); assert.equal(s.h.events.filter(e => e.event === 'briefing.published').length, 1)
})

// ---------------- 4. sequencing with held answers (D1: completed messages only) ----------------
test('held answers: the final answer is posted once, complete, before the run ends; the briefing proposal comes after it and never as a message', async t => {
  // Held-answer mode on (L3): the draft check gets real evidence and finds nothing to revise, so the held answer is posted unchanged as one completed message.
  const judge = { model: 'mock', async decide(request) {
    const answers = {}
    for (const q of request.questions) {
      const pick = q.type === 'choice' ? (q.choices.find(c => c.value === 'supported') ?? q.choices[0]).value : null
      answers[q.name] = q.type === 'choice' ? { type: 'choice', choice: pick, confidence: .95, probabilities: [{ value: pick, probability: .96 }, { value: q.choices.find(c => c.value !== pick).value, probability: .02 }] }
        // L3 c18: the draft check asks yes/no per sentence by default; sup_N is its "supported" (picked above for the choice design)
        : { type: 'predicate', probability: /^(rel|sup)_/.test(q.name) ? .95 : .03 }
    }
    return { answers, model: 'mock', usage: { inputTokens: 5 }, latencyMs: 3 }
  } }
  const facts = { id: 'doc:ship', kind: 'document', title: 'Shipment facts', summary: 'Invoice totals, delivery log and next steps', timeSlice: 'present', loadText: () => REPORT }
  const s = await scene(t, { forkReply: prompt => { assert.ok(!/Here is your draft answer/.test(prompt), 'no draft revision is expected in this scene'); return json(design()) },
    // eligible: the config's own hook (this harness room is not a profile DM)
    decisionContext: { mode: () => 'on', configured: () => true, client: judge, budgetMs: 800, collect: async () => [facts], draftCheck: { mode: () => 'on', eligible: () => true } } })
  const assistant = s.h.events.filter(e => e.event.startsWith('message.') && e.details?.role !== 'user')
  const posted = assistant.filter(e => e.event === 'message.completed')
  assert.equal(posted.length, 1); assert.equal(posted[0].details.text, REPORT, 'one completed answer message, unchanged')
  assert.equal(assistant.find(e => e.event === 'message.started').details.text, REPORT, 'held: the message appears whole, not as a growing stream')
  const R = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: deps(s) } })
  const res = await R.http('POST', '/decision/briefing-observe', bodyFor(s)); assert.equal(res.body.outcome, 'presented', JSON.stringify(res.body))
  const order = s.h.events.map(e => e.event), answerAt = s.h.events.indexOf(posted[0]), endAt = order.indexOf('run.completed'), briefingAt = order.indexOf('briefing.published')
  assert.ok(answerAt < endAt && endAt < briefingAt, `answer (${answerAt}) < run end (${endAt}) < proposal (${briefingAt})`)
  assert.equal(s.h.events.filter((e, i) => e.event.startsWith('message.') && i > endAt).length, 0, 'no message of any kind after the answer')
  assert.equal(s.h.forkPrompts.length, 1, 'the only private turn is the briefing design')
  noDraftLeak(s, ['You are preparing an Answer Briefing'])
})

test('on the screen: the chrome\'s own reducer shows the completed answer first; the late proposal lands on that same answer as its briefing (no new bubble)', async t => {
  const ChatState = await import('../overlay/resources/EGDeskChatState.sys.mjs')
  const { briefingRequestOffer } = await import('../overlay/resources/EGDeskBriefingState.sys.mjs')
  const s = await scene(t, { forkReply: () => json(design()) })
  const state = ChatState.createChatProtocolState(), thread = { id: 'ui', engineId: 'codex', contextToolsAvailable: true, conversationId: s.h.ids.conversationId, messages: [] }
  const feed = from => { let run = null; for (const e of s.h.events.slice(from)) { if (e.type !== 'chat.event') continue; assert.ok(ChatState.canAdmitChatEvent(state, [thread], e)); run = ChatState.reduceChatEvent(state, e) ?? run } return run }
  let messages = ChatState.projectRunMessages([], feed(0)); const seen = s.h.events.length
  assert.deepEqual(messages.map(m => [m.role, m.status, m.content === REPORT, !!m.briefing]), [['assistant', 'complete', true, false]], 'what the person sees when the run ends: the whole answer, no briefing yet')
  assert.ok(briefingRequestOffer(thread, messages[0]), 'until a briefing exists the answer still offers the existing request control')
  const R = rig(t, { mode: 'on', script: reuseScript({ P3: .1 }), handlerOptions: { briefing: deps(s) } })
  assert.equal((await R.http('POST', '/decision/briefing-observe', bodyFor(s))).body.outcome, 'presented')
  messages = ChatState.projectRunMessages(messages, feed(seen))
  assert.equal(messages.length, 1, 'still one bubble'); assert.equal(messages[0].content, REPORT, 'the answer text is untouched')
  assert.equal(validBriefing(messages[0].briefing), true); assert.equal(messages[0].briefing.steps.length, 2); assert.equal(messages[0].briefing.presentationStatus, 'proposed')
  assert.equal(briefingRequestOffer(thread, messages[0]), null, 'the answer now carries its briefing; the request control gives way to the existing open control')
})

test('bridge wiring: the server mounts briefingDeps behind EGDESK_BRIEFING_FLOW; the chrome waits long enough for the bounded flow', () => {
  const server = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(server, /briefing: briefingDeps\(\{ chat, contexts, enabled: process\.env\.EGDESK_BRIEFING_FLOW === 'on', order: process\.env\.EGDESK_BRIEFING_ORDER === 'design-first' \? 'design-first' : 'skeleton',\n[^\n]*\n    fillCheck: process\.env\.EGDESK_BRIEFING_FILL_CHECK === 'facts' \? 'facts' : 'all',\n[^\n]*\n    coverage: process\.env\.EGDESK_BRIEFING_COVERAGE === 'board' \? 'board' : 'facts',\n[^\n]*\n    outputSchema: process\.env\.EGDESK_BRIEFING_OUTPUT_SCHEMA === 'on' \? 'on' : 'off' \}\)/)
  assert.equal(briefingDeps({ chat: {}, contexts: {} }).order, 'skeleton', 'the default order is skeleton-first'); assert.equal(briefingDeps({ chat: {}, contexts: {}, order: 'design-first' }).order, 'design-first')
  assert.match(surface, new RegExp(`timeoutMs: flowMode === 'on' \\? ${BRIEFING_CHROME_WAIT_MS} : 20000`))
  assert.ok(BRIEFING_ENGINE_LIMITS.totalMs + 5 * 4000 < BRIEFING_CHROME_WAIT_MS, 'private turns plus the judgments fit inside the chrome wait'); assert.ok(BRIEFING_CHROME_WAIT_MS < 300_000, 'under Firefox\'s default response timeout of 300 s (assumed default)')
})

test('c32: the briefing\'s private turns ask chat.internalText with preamble:false (a fresh ephemeral thread must see the prompt alone), with and without the output schema', async () => {
  const calls = []
  const chat = { canInternalTurn: () => true, internalText: async (run, text, options) => { calls.push({ run, options }); return '{"title":"t"}' }, runFor: () => null }
  for (const outputSchema of ['off', 'on']) {
    const engine = briefingDeps({ chat, contexts: {}, enabled: true, outputSchema }).engineFor({ id: 'run-1' }, { report: 'a' })
    await engine({ kind: 'briefing_component', title: 't', summary: 's' })
  }
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.options.preamble === false && c.run.id === 'run-1' && Number.isFinite(c.options.timeoutMs)))
})

test('c34: engine.lastFailure() tells a timeout (nothing came back before its allotted time) from an unusable reply, an empty turn and a refused one; null after a usable reply', async () => {
  let clock = 0
  const seen = []
  const engine = createBriefingEngine({ now: () => clock, limits: { maxTurns: 4, turnMs: 30_000, totalMs: 100_000 }, runText: async (prompt, options) => { seen.push(options.timeoutMs); const r = replies.shift(); clock += r.ms; return r.reply } })
  const replies = [{ ms: 30_400, reply: null }, { ms: 200, reply: null }, { ms: 500, reply: 'prose, not an object' }, { ms: 500, reply: '{"title":"t","items":{}}' }]
  const request = { kind: 'briefing_fill', guide: { items: [] }, materials: [] }
  assert.equal(engine.lastFailure(), null)
  assert.equal(await engine(request), null); assert.equal(engine.lastFailure(), 'timeout', 'null after the whole allotted time')
  assert.equal(await engine(request), null); assert.equal(engine.lastFailure(), 'no-reply', 'null at once: the turn failed, it did not time out')
  assert.equal(await engine(request), null); assert.equal(engine.lastFailure(), 'unusable', 'a reply that is not the asked JSON')
  assert.notEqual(await engine(request), null); assert.equal(engine.lastFailure(), null)
  assert.equal(await engine(request), null); assert.equal(engine.lastFailure(), 'refused', 'the turn bound')
  assert.deepEqual(Object.keys(engine.stats()), ['turns', 'refused', 'elapsedMs'], 'stats are as before; the reason is a separate accessor')
  assert.ok(seen.every(ms => ms <= 30_000))
})
