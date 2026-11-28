// L55 (round f): an act refused because the page changed under it (a ticking clock, a banner) is decided anew by the decision model, which is shown what changed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runBrowserReflex } from './egdesk-browser-reflex.mjs'
import { CHANGE_REDECISIONS, changeEligible, changeRetargetable, summarizeChange } from './egdesk-browser-change.mjs'
import { NEXT, choice, el, plain, world } from './egdesk-browser-change.fixture.mjs'

const run = (w, extra = {}) => runBrowserReflex({ cardId: 'c', goal: 'Fill the form, then open next', values: { '[F1] Name': 'Kim' }, callTool: w.callTool, client: w.client, maxSteps: 6, ...extra })
const evidenceOf = request => request.input[1].content

test('a page that never stops changing (a ticking clock): the fill and the open proceed on a fresh look, decided by the model', async () => {
  const w = world({ shape: plain })
  const result = await run(w)
  assert.equal(result.outcome, 'done', JSON.stringify(result))
  assert.deepEqual(w.live.filled, [['f_1', 'Kim']])
  assert.deepEqual(w.live.opened, [NEXT])
  assert.ok(w.live.refused >= 2, 'both acts were refused once by the moving revision')
  // the model was shown what changed, once per refused act, and the new guard came from a look taken after its request
  const asked = w.live.decisions.filter(request => /Page change check/.test(evidenceOf(request)))
  assert.equal(asked.length, 2)
  assert.match(evidenceOf(asked[0]), /target: unchanged/)
  assert.ok(asked[0].questions.some(q => q.name === 'change_wait'))
  const fill = w.live.acts.filter(a => a.name === 'egdesk_browser_fill')
  assert.equal(fill.at(-1).args.expectedRevision, w.live.acts.filter(a => a.name === 'egdesk_browser_fill').at(-1).args.expectedRevision)
  assert.ok(result.steps.some(step => step.change?.rounds?.some(round => round.decided === 'same' && round.acted === 'ok')))
})

test('the target moved: the model sees "moved" and the act goes to the same element at its new place', async () => {
  const w = world({ shape: live => [el('f_1', 'textbox', 'Name', { bounds: { x: 10, y: 100 + live.revision * 3, width: 200, height: 24 } })] })
  const result = await run(w, { goal: 'Fill the form' })
  assert.equal(result.outcome, 'done', JSON.stringify(result))
  const asked = w.live.decisions.find(request => /Page change check/.test(evidenceOf(request)))
  assert.match(evidenceOf(asked), /target: moved or resized, otherwise unchanged/)
  const last = w.live.acts.at(-1)
  assert.equal(last.args.ref, 'f_1')
  assert.deepEqual(w.live.filled, [['f_1', 'Kim']])
  assert.equal(last.args.expectedTarget.bounds.y, 100 + last.args.expectedRevision * 3, 'the expected target is the fresh one')
})

test('the target changes under every request (its name ticks): three decisions, never an act on a guess, an honest hand-off', async () => {
  const w = world({ shape: live => [el('l_1', 'link', 'Next ' + live.revision, { href: NEXT })] })
  const result = await run(w, { goal: 'Open next', values: {} })
  assert.deepEqual([result.outcome, result.reason, result.unsettled], ['escalated', 'tool_failed', true], JSON.stringify(result))
  assert.deepEqual(w.live.opened, [])
  assert.equal(w.live.decisions.filter(request => /Page change check/.test(evidenceOf(request))).length, CHANGE_REDECISIONS)
  assert.equal(w.live.acts.length, 1, 'only the refused act was ever sent')
})

test('re-target: the field is replaced by another element of the same kind; the model picks it and the fill goes there', async () => {
  const w = world({ shape: live => (live.revision < 4 ? [el('f_1', 'textbox', 'Name')] : [el('f_9', 'textbox', 'Name')]) })
  const result = await run(w, { goal: 'Fill the form' })
  assert.equal(result.outcome, 'done', JSON.stringify(result))
  assert.deepEqual(w.live.filled, [['f_9', 'Kim']])
  assert.ok(w.live.decisions.some(request => /target: no longer on the page/.test(evidenceOf(request))), 'the model was told the target is gone')
  assert.ok(result.steps.some(step => step.change?.rounds?.some(round => round.decided === 'other')))
})

test('the target was removed and nothing replaces it: the model answers blocked, the loop stops honestly, nothing is sent', async () => {
  const w = world({ shape: live => (live.revision < 3 ? [el('f_1', 'textbox', 'Name')] : [el('l_1', 'link', 'Elsewhere', { href: NEXT })]), answer: (q, live) => (q.name === 'next_step' && live.revision >= 3 ? choice('blocked') : null) })
  const result = await run(w, { goal: 'Fill the form' })
  assert.deepEqual([result.outcome, result.reason], ['escalated', 'blocked'])
  assert.deepEqual(w.live.filled, [])
  assert.equal(w.live.acts.length, 1, 'only the refused act was ever sent')
})

test('the document was replaced: the new page is decided anew (bounded), the person-only page states are asked there', async () => {
  const w = world({ shape: plain, staleBy: 'document', onFirstAct: live => { live.doc = 'doc-2' } })
  // the first act is refused as a replaced document; the replacement page has the same form
  const result = await run(w, { goal: 'Fill the form' })
  assert.equal(result.outcome, 'done', JSON.stringify(result))
  assert.deepEqual(w.live.filled, [['f_1', 'Kim']])
  assert.ok(result.steps.length >= 2, 'a new step, a new observation, a new decision')
})

test('the bound: a page that never settles ends with an honest hand-off after at most 1 + CHANGE_REDECISIONS tries', async () => {
  const w = world({ shape: plain, tickOnAct: true })
  w.callTool = (original => async (name, args) => { if (name === 'egdesk_browser_fill' || name === 'egdesk_browser_navigate') { w.live.acts.push({ name, args }); w.live.refused++; throw Object.assign(new Error('x'), { code: 'BROWSER_OBSERVATION_STALE', staleBy: 'revision' }) } return original(name, args) })(w.callTool)
  const result = await run(w, { goal: 'Fill the form', maxSteps: 6 })
  assert.deepEqual([result.outcome, result.reason, result.code, result.unsettled], ['escalated', 'tool_failed', 'BROWSER_OBSERVATION_STALE', true])
  assert.equal(w.live.acts.length, 1 + CHANGE_REDECISIONS)
  assert.equal(w.live.decisions.filter(request => /Page change check/.test(evidenceOf(request))).length, 1, 'once decided and approved, the same target is re-tried without asking again')
})

test('the model says wait: the page is waited for (not acted on), then the act goes through', async () => {
  let said = false
  const w = world({ shape: plain, answer: (q, live, request) => (q.name === 'change_wait' && !said ? (said = true, { type: 'predicate', probability: 0.95 }) : null) })
  const result = await run(w, { goal: 'Fill the form' })
  assert.equal(result.outcome, 'done', JSON.stringify(result))
  assert.ok(w.live.waits >= 1)
  assert.deepEqual(w.live.filled, [['f_1', 'Kim']])
})

test('a changed page never lets the model past a person-only gate: it turned into a sign-in wall, so the loop hands off and sends nothing', async () => {
  const w = world({ shape: plain, answer: (q, live) => (q.name === 'page_state' && live.revision >= 3 ? 'login_required' : null) })
  const result = await run(w, { goal: 'Fill the form' })
  assert.equal(result.outcome, 'handoff')
  assert.equal(result.pageState, 'login_required')
  assert.deepEqual(w.live.filled, [])
  assert.equal(w.live.acts.length, 1)
})

test('a gated control is never a candidate of the re-decision, and a POST submit keeps its own gate', () => {
  assert.equal(changeEligible({ item: { postUrl: 'https://x.invalid/post' } }), false)
  assert.equal(changeEligible({ item: { askSite: true } }), false)
  assert.equal(changeEligible({ item: { kind: 'press' } }), true)
  const fill = { item: { kind: 'fill' } }
  assert.equal(changeRetargetable(fill, { item: { kind: 'fill' } }), true)
  assert.equal(changeRetargetable(fill, { item: { kind: 'press' } }), false)
  assert.equal(changeRetargetable({ item: { kind: 'navigate' } }, { item: { kind: 'navigate' } }), false)
  assert.equal(changeRetargetable({ item: { kind: 'press', readOnly: { kind: 'get_form' } } }, { item: { kind: 'press', readOnly: { kind: 'get_form' } } }), false)
})

test('summarizeChange: closed facts about the target and the regions that changed', () => {
  const base = { url: 'u', documentId: 'd', viewport: { width: 1, height: 1 }, text: ['a', 'clock 1'], interactiveElements: [el('f_1', 'textbox', 'Name', { bounds: { x: 0, y: 0, width: 100, height: 20 } }), el('b_1', 'button', 'Ad', { bounds: { x: 0, y: 500, width: 50, height: 20 } })] }
  const same = summarizeChange(base, { ...base, text: ['a', 'clock 2'] }, 'f_1')
  assert.deepEqual([same.target, same.textLines, same.overlapsTarget, same.dialogAppeared], ['same', 1, false, false])
  const valueChanged = summarizeChange(base, { ...base, interactiveElements: [el('f_1', 'textbox', 'Name', { value: 'x', bounds: { x: 0, y: 0, width: 100, height: 20 } }), base.interactiveElements[1]] }, 'f_1')
  assert.deepEqual([valueChanged.target, valueChanged.targetFields], ['changed', ['value']])
  const gone = summarizeChange(base, { ...base, interactiveElements: [base.interactiveElements[1]] }, 'f_1')
  assert.equal(gone.target, 'gone')
  const modal = summarizeChange(base, { ...base, interactiveElements: [...base.interactiveElements, el('d_1', 'dialog', 'Cookies', { bounds: { x: 0, y: 0, width: 400, height: 300 } })] }, 'f_1')
  assert.deepEqual([modal.dialogAppeared, modal.addedElements, modal.overlapsTarget], [true, 1, true])
  const elsewhere = summarizeChange(base, { ...base, interactiveElements: [base.interactiveElements[0], el('b_1', 'button', 'Ad 2', { bounds: { x: 0, y: 500, width: 50, height: 20 } })] }, 'f_1')
  assert.deepEqual([elsewhere.changedElements, elsewhere.overlapsTarget], [1, false])
})
