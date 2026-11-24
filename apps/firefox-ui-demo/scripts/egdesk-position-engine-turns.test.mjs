// L7 c28: the turn position counts completed ENGINE turns (runs of EG-Desk's own record), not posted messages. Real v7 journey: s1's answer was withheld whole
// by the draft check (a tense false positive, then the revision flagged again), so nothing was posted, yet the engine held s1's pages. The position said
// "first / no_prior_turns", the receipts were ignored, the follow-up's triage had no "Held in the answering model's context" section, the context catalog was
// not pruned, the page was fetched and re-sent. Offline, scripted world; only the draft check's answers on the s1 sentence are forced (as in L2's experiment).
import test from 'node:test'
import assert from 'node:assert/strict'
import { allOnWorld, scriptedDecisions, DM } from './egdesk-all-on.support.mjs'
import { STEPS, DEFAULT_CAPS, PLAN_FILE_V7, createMeasureTransport, loadJourneyPlan, waitNote, pointerNote, faithfulRevision } from './egdesk-all-on-live-measure.mjs'

const S1 = 'A사 견적은 v1 발송 후 v2 수정 계획 단계이며'
const cid = w => w.state.lastOf.get(DM).conversationId
const position = w => w.chat.turnPosition({ engine: { id: 'codex' }, conversationId: cid(w), clientThreadId: DM })
const restart = w => { for (const m of [w.chat.loadedThreads, w.chat.compactedThreads, w.chat.foreignThreads, w.chat.turnMemoryDelivered, w.chat.turnMemoryShadow, w.chat.contextDelivered, w.chat.turnMemoryLatest]) m.clear() }

// s1 then s2 of the v7 journey; withhold = the draft check flags the s1 sentence and its revision again, so s1 posts nothing
async function journey(t, { withhold, ids = ['s1-first-turn', 's2-follow-up'] }) {
  const plan = loadJourneyPlan(PLAN_FILE_V7), base = scriptedDecisions()
  const scripted = { answer: async wire => {
    const answers = await base.answer(wire)
    if (withhold && wire.questions.some(q => q.name === 'tense_0') && JSON.stringify(wire.input).includes(S1)) {
      const revised = JSON.stringify(wire.input).includes('기록에 따르면 ' + S1)
      return answers.map(a => (a.name === 'tense_0' ? { ...a, probability: revised ? 0.92 : 0.91 } : a))
    }
    return answers } }
  const { transport } = createMeasureTransport({ caps: DEFAULT_CAPS, plan, scripted })
  const w = allOnWorld(t, { transport, settleLimitMs: 60000, env: { ...plan.world.env, ...plan.world.switches['action-relevance'].env }, budgets: plan.world.budgets })
  w.state.wording.wait = waitNote; w.state.wording.pointer = pointerNote; w.state.wording.revise = faithfulRevision
  await w.settings.turnMemory.save('on')
  const j = { note: {}, sends: [], said: [], async say(text, extra) { try { await w.send(text, extra) } catch {} await w.idle() }, async pause() { await new Promise(r => setTimeout(r, 60)); await w.idle() } }
  const out = {}
  for (const def of STEPS.filter(d => ids.includes(d.id))) {
    w.step(def.id); j.said = []; await def.run(w, j); await w.idle()
    if (def.id === 's1-first-turn') out.positionAfterS1 = position(w)
    const dec = w.decisions.filter(d => d.step === def.id), catalog = dec.find(d => /"answer_type"/.test(d.raw))
    out[def.id] = { posted: w.history().filter(([r]) => r === 'assistant').length, held: dec.filter(d => d.feature === 'memory_triage').map(d => /Held in the answering model/.test(d.raw)),
      catalog: catalog ? (JSON.parse(catalog.raw).input.map(m => JSON.stringify(m.content)).join('').match(/#\d+ \|/g) ?? []).length : null, features: dec.map(d => d.feature).join(',') }
  }
  return { w, out }
}

test('a first answer the draft check withheld whole is still a completed turn: the follow-up is mid-session with receipts, as when the answer was posted', async t => {
  const normal = await journey(t, { withhold: false })
  const withheld = await journey(t, { withhold: true })
  assert.equal(normal.out['s1-first-turn'].posted, 1); assert.equal(withheld.out['s1-first-turn'].posted, 0, 'nothing was posted for s1')
  assert.deepEqual(withheld.out.positionAfterS1, { kind: 'mid', reason: 'live_thread' })
  assert.deepEqual(withheld.out.positionAfterS1, normal.out.positionAfterS1)
  const a = normal.out['s2-follow-up'], b = withheld.out['s2-follow-up']
  assert.deepEqual(b.held, [true], 'the triage lists what the engine holds')
  assert.deepEqual({ held: b.held, catalog: b.catalog, features: b.features }, { held: a.held, catalog: a.catalog, features: a.features }, 'the same requests, the same pruned catalog as with a posted answer')
})

test('normal turns: with the answer posted the position is mid/live_thread and the run record counts s1 and s2 (the draft-check fork is not a run of the conversation)', async t => {
  const { w, out } = await journey(t, { withhold: false })
  assert.deepEqual(out.positionAfterS1, { kind: 'mid', reason: 'live_thread' })
  assert.equal(w.chat.completedEngineTurns(cid(w), DM), 2, 's1 and s2 are both completed runs')
})

test('a restart after a withheld first answer: the thread is resumed with history (mid), not first; receipts stay closed until a live turn follows', async t => {
  const { w } = await journey(t, { withhold: true, ids: ['s1-first-turn'] })
  assert.equal(w.history().filter(([r]) => r === 'assistant').length, 0)
  restart(w)
  assert.deepEqual(position(w), { kind: 'mid', reason: 'resumed_thread_with_history' })
  assert.equal(usable(w), false, 'a resumed thread is not live: no receipts')
})
const usable = w => { const pos = position(w); return pos.kind === 'mid' && pos.reason === 'live_thread' }

test('what counts: completed runs of this conversation only; a conversation with no completed run (running, failed, interrupted, another conversation, a draft-check fork) is first', async t => {
  const w = allOnWorld(t, { env: { EGDESK_DRAFT_CHECK: 'off' } })
  await w.settings.turnMemory.save('on')
  const real = w.chat.store, runs = []
  w.chat.store = { ...real, listRuns: () => ({ runs, hasMore: false }), listMessages: () => ({ messages: [{ role: 'assistant', status: 'completed' }] }) }
  const cidX = 'conv-x', ctx = { conversationId: cidX, clientThreadId: DM }
  const pos = () => w.chat.turnPosition(ctx)
  assert.deepEqual(pos(), { kind: 'first', reason: 'no_prior_turns' }, 'a posted message without a completed engine turn is not a prior turn')
  for (const status of ['running', 'failed', 'interrupted', 'inProgress']) { runs.length = 0; runs.push({ runId: 'r', status, conversationId: cidX }); assert.equal(pos().reason, 'no_prior_turns', status) }
  runs.length = 0; runs.push({ runId: 'r', status: 'completed', conversationId: 'another' }); assert.equal(pos().reason, 'no_prior_turns', 'a run of another conversation')
  runs.length = 0; runs.push({ runId: 'r', status: 'completed', conversationId: cidX }); w.chat.loadedThreads.add(cidX); assert.deepEqual(pos(), { kind: 'mid', reason: 'live_thread' })
  assert.deepEqual(pos(), { kind: 'mid', reason: 'live_thread' }); w.chat.loadedThreads.delete(cidX); assert.equal(pos().reason, 'resumed_thread_with_history')
  // the record cannot be read: first (the conservative side)
  w.chat.store = { ...real, listRuns() { throw new Error('closed') } }; assert.equal(pos().reason, 'no_prior_turns')
  w.chat.store = null; assert.equal(pos().reason, 'no_prior_turns')
  w.chat.store = real
})

test('paging: a completed run on a later page of the record counts', async t => {
  const w = allOnWorld(t, { env: { EGDESK_DRAFT_CHECK: 'off' } })
  const cidX = 'conv-x', pages = [{ runs: Array.from({ length: 100 }, (_, i) => ({ runId: 'a' + i, status: 'failed', conversationId: cidX })), hasMore: true, nextCursor: 100 }, { runs: [{ runId: 'z', status: 'completed', conversationId: cidX }], hasMore: false }]
  w.chat.store = { listRuns: (_c, { afterSeq }) => pages[afterSeq === 0 ? 0 : 1] }
  w.chat.loadedThreads.add(cidX)
  assert.deepEqual(w.chat.turnPosition({ conversationId: cidX, clientThreadId: DM }), { kind: 'mid', reason: 'live_thread' })
})
