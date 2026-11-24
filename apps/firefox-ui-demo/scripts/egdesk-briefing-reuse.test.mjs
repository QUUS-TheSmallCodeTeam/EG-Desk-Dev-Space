// L4 cycle 7: Answer Briefing over components ALREADY rendered on the board: reuse / retrieve / irrelevant per component and "is a new component
// required?" per part of the report, judged by the Decision model over what the runtime enumerated; the subjective model designs reuse-first under
// those findings; the flow check loop runs as before; retrievals are proposals applied on the user's own screen (fold) with undo / Cmd+Z.
// Mounted: production handler (new /decision/briefing-reuse route), Decisions client + shared budget, real calibration log, the support world
// (real surface history, WorkbenchArrange and presentation controller on six real board cards). Fakes: DOM, provider (synthetic), the subjective model.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as WorkbenchArrange from '../overlay/resources/EGDeskWorkbenchArrange.sys.mjs';
import { validBriefing } from '../overlay/resources/EGDeskBriefingState.sys.mjs';
import { completeBriefingArgs, constraintFrom, enumerateBriefingFacts, enumerateReportParts, normalizeReuseDto, prepareBriefingReuse, readBriefingReuse, resolveDesign,
  retrievalPlan, reuseDto, runBriefingFlow } from '../helper/egdesk-briefing-flow.mjs';
import { world } from './egdesk-board-world.support.mjs';
import { engineOf, fits, publishSchema, rig } from './egdesk-briefing-rig.support.mjs';

const r = (x, y, width, height) => ({ x, y, width, height });
const jc = (id, item, rect, z) => ({ id, item, rect, z, kind: 'note' });
const CUR = 'answer-2';
// six components already rendered on the board
const PROV = {
  vA: { label: 'Invoice totals', gist: 'Q3 invoice totals and the amount due', owner: 'agent', createdForAnswer: CUR, ref: { sourceId: 'src-invoice' } },
  vB: { label: 'Delivery log', gist: 'Shipment log showing the delay of two days', owner: 'agent', createdForAnswer: CUR, ref: { sourceId: 'src-delivery' } },
  vC: { label: 'Old shipment summary', gist: 'Earlier summary of the shipment, replaced by the delivery log', owner: 'agent', createdForAnswer: 'answer-1', superseded: true, ref: { artifactId: 'art-old-summary' } },
  vD: { label: 'Team note', gist: 'A note written by the user', owner: 'user', stale: true, ref: { sourceId: 'src-team-note' } },
  vE: { label: 'Quarterly budget', gist: 'Budget sheet for another project', owner: 'shared', ref: { sourceId: 'src-budget' } },
  vF: { label: 'Holiday calendar', gist: 'Company holiday calendar', owner: 'shared', ref: { sourceId: 'src-calendar' } },
};
async function board(extra = {}) {
  const spec = { cards: [jc('vA', 'item-A', r(100, 60, 260, 160), 1), jc('vB', 'item-B', r(620, 60, 260, 160), 2), jc('vC', 'item-C', r(100, 300, 260, 160), 3),
    jc('vD', 'item-D', r(620, 300, 260, 160), 4), jc('vE', 'item-E', r(100, 520, 260, 160), 5), jc('vF', 'item-F', r(620, 520, 260, 160), 6)], others: [], links: [] };
  const W = world({ WorkbenchArrange, http: extra.http ?? (async () => ({ status: 503, body: {} })), grant: extra.grant ?? (() => true), spec });
  const desk = W.real.arrange().designScene('proj1');
  const candidates = desk.cards.map(c => ({ id: c.id, kind: 'source', onBoard: true, maySend: true, rect: c.rect, visibility: c.collapsed ? 'collapsed' : 'visible', ...PROV[c.id] }));
  return { W, desk, candidates, viewport: desk.viewport };
}
const REPORT = ['## Billing', 'The Invoice totals show the Q3 amount that was billed to the customer.', '', '## Delivery', 'The Delivery log shows the shipment was two days late.', '',
  '## Next steps', 'Refund the delay fee and ship the replacement as soon as possible.'].join('\n');
const DECIDE = { vA: 'reuse', vB: 'reuse', vC: 'retrieve', vD: 'irrelevant', vE: 'irrelevant', vF: 'irrelevant' };
const componentScript = (map = {}) => Object.fromEntries(['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((a, i) => { const id = 'v' + 'ABCDEF'[i]; return [a, { value: map[id] ?? DECIDE[id], p: .92 }]; }));
const designReuseOnly = () => ({ title: 'Why the shipment is late', steps: [
  { text: 'The invoice total shows the Q3 amount that was billed.', targets: ['T1'], fallback: 'Open the invoice totals.' },
  { text: 'The delivery log shows the shipment was two days late.', targets: ['T2'], emphasis: 'outline', fallback: 'Open the delivery log.' }] });
const designWithNew = () => ({ ...designReuseOnly(), steps: [...designReuseOnly().steps, { text: 'The next steps summary lists what to do about it.', targets: ['new:P3'], fallback: 'See the next steps in chat.' }],
  newComponents: [{ part: 'P3', title: 'Next steps summary', summary: 'Refund the delay fee and ship the replacement' }] });

// ---------------- 1. runtime options built from real facts ----------------
test('components: owner, origin (which answer), supersession, staleness and visibility decide whether retrieve is even an option', async () => {
  const b = await board(); const e = enumerateBriefingFacts({ report: REPORT, candidates: b.candidates, currentAnswerId: CUR });
  const row = a => { const t = e.targets.find(x => x.alias === a); return [t.label, t.origin, t.retrievable]; };
  assert.deepEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map(row), [['Invoice totals', 'agent-current', false], ['Delivery log', 'agent-current', false], ['Old shipment summary', 'agent-earlier', true],
    ['Team note', 'user', false], ['Quarterly budget', 'shared', false], ['Holiday calendar', 'shared', false]]);
  assert.equal(e.targets[3].stale, true, 'the user note is flagged stale and still cannot be retrieved');
  const variant = (id, patch) => enumerateBriefingFacts({ report: REPORT, currentAnswerId: CUR, candidates: b.candidates.map(c => c.id === id ? { ...c, ...patch } : c) }).targets.find(t => t.id === id);
  assert.equal(variant('vC', { visibility: 'collapsed' }).retrievable, false, 'already folded: nothing to retrieve');
  assert.equal(variant('vC', { superseded: false, stale: false }).retrievable, false, 'an earlier output that is still current stays');
  assert.equal(variant('vA', { stale: true }).retrievable, false, 'an output made for THIS answer is never retired by it');
  assert.equal(variant('vC', { owner: undefined }).retrievable, false, 'unknown provenance counts as the user\'s own');
  assert.equal(variant('vC', { createdForAnswer: null }).retrievable, false);
  assert.equal(enumerateBriefingFacts({ report: REPORT, candidates: b.candidates }).targets[2].retrievable, false, 'without a current answer there is no "earlier"');
});
test('parts: heading sections with the components that already cover them', async () => {
  const b = await board(); const e = enumerateBriefingFacts({ report: REPORT, candidates: b.candidates, currentAnswerId: CUR });
  assert.deepEqual(enumerateReportParts(REPORT, e.targets).map(x => [x.alias, x.label, x.coveredBy]), [['P1', 'Billing', ['T1']], ['P2', 'Delivery', ['T2']], ['P3', 'Next steps', []]]);
  assert.deepEqual(enumerateReportParts('one short paragraph that is long enough to count.\n\nanother paragraph that is long enough to count too.', []).map(x => x.alias), ['P1', 'P2']);
});

// ---------------- 2. the reuse judge ----------------
const dtoFor = async () => { const b = await board(); const e = enumerateBriefingFacts({ report: REPORT, candidates: b.candidates, currentAnswerId: CUR }); const parts = enumerateReportParts(REPORT, e.targets); return { b, e, parts, dto: reuseDto(e, parts) }; };
test('reuse judge packet: a choice per component (retrieve only where the runtime offers it), a predicate per part, no id, path or coordinate', async () => {
  const { dto } = await dtoFor(); const p = prepareBriefingReuse({ mode: 'on', binding: 'b', dto });
  assert.deepEqual(p.packet.questions.map(q => q.name), ['component_T1', 'component_T2', 'component_T3', 'component_T4', 'component_T5', 'component_T6', 'new_P1', 'new_P2', 'new_P3']);
  const opts = n => p.packet.questions.find(q => q.name === n).choices.map(c => c.value);
  assert.deepEqual(opts('component_T3'), ['reuse', 'irrelevant', 'retrieve']); for (const n of ['component_T1', 'component_T4', 'component_T5']) assert.deepEqual(opts(n), ['reuse', 'irrelevant'], n);
  const wire = JSON.stringify(p.packet); for (const bad of ['src-', 'art-', 'vA', 'item-', '"rect"', '"x":']) assert.ok(!wire.includes(bad), bad);
  assert.equal(prepareBriefingReuse({ mode: 'off', binding: 'b', dto }).status, 'manual');
  // the system rule is enforced on the bridge too: a chrome that claims retrievable for a user note is refused
  const forged = structuredClone(dto); forged.components[3].retrievable = true; assert.equal(normalizeReuseDto(forged), null);
  const forged2 = structuredClone(dto); forged2.components[0].origin = 'shared'; forged2.components[0].retrievable = true; assert.equal(normalizeReuseDto(forged2), null);
  assert.equal(normalizeReuseDto({ ...dto, extra: 1 }), null);
  assert.ok(normalizeReuseDto(dto));
});
test('reuse reading: unsure is undecided (not reused, not retrieved); an unusable answer is manual; new component needs the bar', async () => {
  const { dto } = await dtoFor(); const p = prepareBriefingReuse({ mode: 'on', binding: 'b', dto });
  const ans = (over = {}, parts = {}) => Object.fromEntries([...p.packet.questions.map(q => q.type === 'choice'
    ? [q.name, (d => ({ type: 'choice', choice: d.value, confidence: d.p, probabilities: [{ value: d.value, probability: d.p }, { value: q.choices.find(c => c.value !== d.value).value, probability: 1 - d.p }] }))(over[q.name.slice(10)] ?? { value: 'irrelevant', p: .9 })]
    : [q.name, { type: 'predicate', probability: parts[q.name.slice(4)] ?? .05 }])]);
  const rd = readBriefingReuse(p, ans({ T1: { value: 'reuse', p: .95 }, T3: { value: 'retrieve', p: .9 }, T2: { value: 'reuse', p: .6 } }, { P3: .9 }), 'b');
  assert.deepEqual(rd.components.map(c => [c.alias, c.decision]), [['T1', 'reuse'], ['T2', 'undecided'], ['T3', 'retrieve'], ['T4', 'irrelevant'], ['T5', 'irrelevant'], ['T6', 'irrelevant']]);
  assert.deepEqual(rd.parts.map(x => [x.alias, x.newRequired]), [['P1', false], ['P2', false], ['P3', true]]);
  assert.equal(readBriefingReuse(p, { ...ans(), component_T1: { type: 'refusal' } }, 'b').status, 'manual');
  assert.equal(readBriefingReuse(p, ans(), 'other').status, 'manual');
  // a reading that says retrieve for a component that was never offered it (a user note): it counts for nothing, nothing is retired
  assert.equal(readBriefingReuse(p, ans({ T4: { value: 'retrieve', p: .95 } }), 'b').components[3].decision, 'undecided');
});
test('constraint: a new component is allowed only where the judge says so AND no reused component already covers the part', async () => {
  const { e, parts } = await dtoFor();
  const reply = { components: [{ alias: 'T1', decision: 'reuse' }, { alias: 'T2', decision: 'reuse' }, { alias: 'T3', decision: 'retrieve' }, { alias: 'T4', decision: 'retrieve' }, { alias: 'T5', decision: 'irrelevant' }, { alias: 'T6', decision: 'undecided' }],
    parts: [{ alias: 'P1', newRequired: true }, { alias: 'P2', newRequired: false }, { alias: 'P3', newRequired: true }] };
  const c = constraintFrom(reply, e, parts);
  assert.deepEqual([...c.reuse], ['T1', 'T2']); assert.deepEqual(c.retire, ['T3'], 'the user note is never retired even if a reading said retrieve');
  assert.deepEqual([...c.newAllowed.keys()], ['P3']); assert.deepEqual(c.newBlocked, ['P1'], 'P1 is covered by a reused component: reuse first');
});

// ---------------- 3. design constraints ----------------
test('design constraints: reuse aliases only, every reused one used, a new component only where allowed and specified once', async () => {
  const { e, parts } = await dtoFor();
  const c = constraintFrom({ components: [{ alias: 'T1', decision: 'reuse' }, { alias: 'T2', decision: 'reuse' }, { alias: 'T3', decision: 'retrieve' }], parts: [{ alias: 'P3', newRequired: true }] }, e, parts);
  const ok = resolveDesign(designWithNew(), e, { constraint: c });
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.deepEqual(ok.newComponents.map(n => [n.alias, n.part, n.stepId]), [['N1', 'P3', 's3']]); assert.deepEqual(ok.pendingSteps, ['s3']);
  fits(publishSchema, ok.publishArgs); assert.deepEqual(ok.publishArgs.steps.map(s => s.id), ['s1', 's2'], 'a step that waits for its new component is not published yet');
  const full = completeBriefingArgs(ok, { N1: { artifactId: 'art-new-summary' } }); fits(publishSchema, full); assert.deepEqual(full.steps[2].targets, [{ artifactId: 'art-new-summary' }]); assert.equal(completeBriefingArgs(ok, {}), null);
  const mut = (fn, withNew = true) => { const d = withNew ? designWithNew() : designReuseOnly(); fn(d); return resolveDesign(d, e, { constraint: c }).reason; };
  assert.equal(mut(d => { d.steps[0].targets = ['T3']; }), 'not-reusable-target'); assert.equal(mut(d => { d.steps[0].targets = ['T1', 'T5']; }), 'not-reusable-target');
  assert.equal(mut(d => { d.steps[1].targets = ['T1']; }), 'reuse-unused'); assert.equal(mut(d => { d.steps[2].targets = ['new:P1']; }), 'new-not-allowed');
  assert.equal(mut(d => { d.steps.push({ text: 'again', targets: ['new:P3'], fallback: 'f' }); }), 'new-duplicate'); assert.equal(mut(d => { d.newComponents = []; }), 'new-missing-spec');
  assert.equal(mut(d => { d.newComponents.push({ part: 'P2', title: 'x', summary: 'y' }); }), 'new-not-allowed'); assert.equal(mut(d => { d.steps.pop(); }), 'new-unreferenced');
  assert.equal(mut(d => { d.steps[2].targets = ['new:P3']; d.steps = [d.steps[2]]; }, true), 'reuse-unused');
  assert.equal(resolveDesign(designWithNew(), e, { constraint: constraintFrom({ components: c.reuse.size ? [{ alias: 'T1', decision: 'reuse' }, { alias: 'T2', decision: 'reuse' }] : [], parts: [{ alias: 'P3', newRequired: false }] }, e, parts) }).reason, 'new-not-allowed', 'the judge said no new component');
});

// ---------------- 4. the whole flow on a board with six rendered components ----------------
const flowScript = (final, mid) => n => n === 0 ? { placement: { value: 'board', p: .94 } } : n === 1 ? { components: componentScript(), parts: final.parts } : (mid && n === 2 ? mid : { u: .96, issues: {} });
const BASE = { candidates: null };
async function run(t, { design, parts = { P3: .1 }, script, extra = {}, allow } = {}) {
  const b = await board(); const R = rig(t, { script: script ?? flowScript({ parts }) });
  const engineLog = []; const seen = [];
  const out = await runBriefingFlow({ report: REPORT, candidates: b.candidates, currentAnswerId: CUR, links: [], viewport: b.viewport, decide: R.decide,
    allow: allow ?? (async (kind, preview) => { seen.push([kind, JSON.stringify(preview.packet)]); return true; }), engine: engineOf(engineLog, design ?? (() => designReuseOnly())), ...extra });
  return { b, R, out, engineLog, seen };
}
test('flow: six existing components -> reuses the 2 relevant outputs, proposes retrieving the stale one, never the user note, creates 0 new components; retrieval applies on the user screen with undo', async t => {
  const { b, R, out, engineLog, seen } = await run(t);
  assert.equal(out.status, 'presented', JSON.stringify(out)); assert.deepEqual(out.reuse, { reuse: ['T1', 'T2'], retire: ['T3'], newAllowed: [], newBlocked: [] });
  assert.deepEqual(out.newComponents, [], 'no new component'); assert.deepEqual(out.retrievals.map(x => [x.alias, x.id]), [['T3', 'vC']], 'only the stale earlier output of this Agent; not the user note, not the shared ones');
  fits(publishSchema, out.publishArgs); assert.deepEqual(out.publishArgs.steps.flatMap(s => s.targets), [{ sourceId: 'src-invoice' }, { sourceId: 'src-delivery' }]);
  assert.deepEqual(out.stats, { judgeRequests: 3, designRounds: 1 }); assert.equal(R.calls.length, 3, 'one paid request per judgment: placement, reuse, flow check'); assert.equal(R.budget.snapshot().inputTokens, 33);
  // the subjective model is constrained: only reuse targets are offered, stale/irrelevant ones are not even listed
  assert.deepEqual(engineLog[0].targets.map(x => x.alias), ['T1', 'T2']); assert.deepEqual([engineLog[0].reuse, engineLog[0].retire, engineLog[0].newAllowed, engineLog[0].maxNew], [['T1', 'T2'], ['T3'], [], 0]);
  assert.match(engineLog[0].reply, /Reuse first/);
  // what left the machine for the reuse judgment: labels/gists/provenance flags only
  assert.equal(seen[1][0], 'briefing-reuse'); for (const bad of ['src-', 'art-', 'vC', 'item-', '"rect"']) assert.ok(!seen[1][1].includes(bad), bad); assert.ok(seen[1][1].includes('"retrievable":true'));
  // calibration: 1 + 9 + (1 + items + 1) judgments, content-free
  const rows = R.calibration.entries(); assert.equal(rows.length, 3); assert.deepEqual(rows[1].judgments.slice(0, 6).map(j => j.would), ['attach', 'attach', 'act', 'skip', 'skip', 'skip']);
  assert.ok(!/Invoice|Delivery|Team note|Old shipment|src-/.test(JSON.stringify(rows)));
  // apply the retrieval on the user's own screen, then undo / redo through the existing history
  const W = b.W, ui = W.real.arrange(); await ui.open('proj1', null);
  const s0 = W.seen(); assert.deepEqual(W.collapsedIds(), []);
  assert.equal(ui.offerRetrieval(retrievalPlan(out.retrievals)), true); assert.ok(W.control('retrieval')?.checked); assert.deepEqual(W.collapsedIds(), [], 'a preview folds nothing');
  W.control('apply').fire('click'); for (let i = 0; i < 400 && W.control('apply'); i++) await new Promise(res => setTimeout(res, 5));
  assert.deepEqual(W.collapsedIds(), ['vC'], 'only the stale earlier output is folded; the user note and everything else stay'); assert.deepEqual(W.seen(), s0, 'no card moved, resized or restacked');
  assert.deepEqual(W.state.canvasLayoutHistory.size(), { undo: 1, redo: 0 }); assert.equal(W.fetches.length, 0, 'the shared Board is untouched');
  W.key(); assert.deepEqual(W.collapsedIds(), []); W.key(true); assert.deepEqual(W.collapsedIds(), ['vC']); W.key(); assert.deepEqual(W.collapsedIds(), []);
  assert.equal(await (async () => { await ui.open('proj1', null); return !!W.control('undo'); })(), false, 'the panel Undo was retired by Cmd+Z: one history');
});
test('flow: a needed part with no existing component -> exactly 1 new component is allowed (and nothing more)', async t => {
  const { R, out, engineLog } = await run(t, { design: () => designWithNew(), parts: { P3: .91 } });
  assert.equal(out.status, 'presented', JSON.stringify(out)); assert.deepEqual(out.reuse.newAllowed, ['P3']); assert.equal(out.newComponents.length, 1);
  assert.deepEqual(out.newComponents[0], { alias: 'N1', part: 'P3', title: 'Next steps summary', summary: 'Refund the delay fee and ship the replacement', stepId: 's3' });
  assert.deepEqual(engineLog[0].newAllowed, [{ part: 'P3', label: 'Next steps' }]); assert.equal(engineLog[0].maxNew, 1);
  assert.equal(R.calls.length, 3); const full = completeBriefingArgs(out, { N1: { artifactId: 'art-created' } }); fits(publishSchema, full); assert.equal(validBriefing({ id: 'x', title: full.title, steps: full.steps }), true);
  // the check judged the new component's step like any other (its title/summary travel as a planned target)
  const checkCall = R.calls.at(-1); assert.ok(JSON.stringify(checkCall).includes('Next steps summary'));
  // asking for a second one is refused and retried within the bound
  const greedy = await run(t, { parts: { P3: .91 }, design: (req, i) => i === 0 ? { ...designWithNew(), newComponents: [...designWithNew().newComponents, { part: 'P1', title: 'More', summary: 'x' }] } : designWithNew() });
  assert.equal(greedy.out.status, 'presented'); assert.equal(greedy.out.revisions, 1); assert.equal(greedy.engineLog[1].invalid, 'new-not-allowed'); assert.equal(greedy.out.newComponents.length, 1);
});
test('flow: the judge says no new component is needed -> a design that still asks for one is refused and the design stays reuse-only', async t => {
  const { out, engineLog } = await run(t, { parts: { P3: .1 }, design: (req, i) => i === 0 ? designWithNew() : designReuseOnly() });
  assert.equal(out.status, 'presented'); assert.equal(out.revisions, 1); assert.equal(engineLog[1].invalid, 'new-not-allowed'); assert.deepEqual(out.newComponents, []);
});
test('flow: the flow-check loop works as before under the reuse constraint (mismatch -> redesign keeps the constraint -> passes)', async t => {
  const { R, out, engineLog } = await run(t, { script: flowScript({ parts: { P3: .1 } }, { u: .12, issues: { explanation_mismatch_S2: .93 }, where: { value: 'S2', p: .9 } }),
    design: (req, i) => i === 0 ? { ...designReuseOnly(), steps: [designReuseOnly().steps[0], { ...designReuseOnly().steps[1], text: 'The invoice total was disputed by the customer.' }] } : designReuseOnly() });
  assert.equal(out.status, 'presented'); assert.equal(out.revisions, 1); assert.deepEqual(out.stats, { judgeRequests: 4, designRounds: 2 }); assert.equal(R.calls.length, 4);
  assert.deepEqual(engineLog.map(x => x.kind), ['briefing_design', 'briefing_redesign']); assert.deepEqual(engineLog[1].reuse, ['T1', 'T2']); assert.deepEqual(engineLog[1].retire, ['T3']);
  assert.deepEqual(engineLog[1].findings.map(f => [f.item, f.scope]), [['explanation_mismatch', 'S2']]);
});
test('flow: an inconclusive check ends in the chat answer after the bound and proposes NO retrieval', async t => {
  const { R, out } = await run(t, { script: n => n === 0 ? { placement: { value: 'board', p: .9 } } : n === 1 ? { components: componentScript(), parts: { P3: .1 } } : { u: .5, issues: { explanation_mismatch_S2: .6 } } });
  assert.deepEqual([out.status, out.reason, out.revisions], ['fallback-chat', 'check-inconclusive', 2]); assert.equal(out.retrievals, undefined); assert.deepEqual(out.stats, { judgeRequests: 5, designRounds: 3 }); assert.equal(R.calls.length, 5);
});
test('flow: nothing to reuse and nothing new needed -> chat answer; an unusable reuse reading (or a rogue retrieve) -> chat answer with the judge unavailable, nothing retired', async t => {
  const none = await run(t, { script: n => n === 0 ? { placement: { value: 'board', p: .9 } } : { components: Object.fromEntries(['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map(a => [a, { value: 'irrelevant', p: .95 }])), parts: { P3: .1 } } });
  assert.deepEqual([none.out.status, none.out.reason], ['fallback-chat', 'nothing-to-reuse']); assert.equal(none.engineLog.length, 0);
  const rogue = await run(t, { script: n => n === 0 ? { placement: { value: 'board', p: .9 } } : { components: { ...componentScript(), T4: { value: 'retrieve', p: .95 } }, parts: { P3: .1 } } });
  assert.deepEqual([rogue.out.status, rogue.out.reason, rogue.out.detail], ['fallback-chat', 'judge-unavailable', 'manual']); assert.equal(rogue.engineLog.length, 0); assert.equal(rogue.out.retrievals, undefined);
});
test('retrieval is a proposal on the user screen: apply re-checks authority, an already folded or unknown card is refused, and the shared Board is never written', async t => {
  const b = await board(); const ui = b.W.real.arrange(); let granted = true;
  const R2 = await board({ http: async () => ({ status: 503, body: {} }), grant: () => granted });
  const W = R2.W, u = W.real.arrange(); await u.open('proj1', null);
  assert.equal(u.offerRetrieval({ option: 'retrieval', collapse: [{ id: 'nope', value: true }] }), false); assert.equal(u.offerRetrieval({ option: 'retrieval', collapse: [{ id: 'vC', value: false }] }), false);
  assert.equal(u.offerRetrieval({ option: 'retrieval', collapse: [] }), false); assert.equal(u.offerRetrieval({ option: 'retrieval', collapse: [{ id: 'vC', value: true }, { id: 'vC', value: true }] }), false);
  W.real.arrange().close(); void ui;
  // collapsing is a view state of the card: history guard refuses an undo after the user changed the fold themselves
  await u.open('proj1', null); assert.equal(u.offerRetrieval({ option: 'retrieval', collapse: [{ id: 'vC', value: true }] }), true);
  W.control('apply').fire('click'); for (let i = 0; i < 400 && W.control('apply'); i++) await new Promise(res => setTimeout(res, 5));
  assert.deepEqual(W.collapsedIds(), ['vC']); W.doc.getElementById('vC')._setWindowCollapsed(false); const before = W.collapsedIds();
  W.key(); assert.deepEqual(W.collapsedIds(), before, 'the user unfolded it themselves: Cmd+Z does not fight them'); assert.ok(W.notices.some(m => /건너뛰었습니다/.test(m)));
});
test('reuse route: advisory records only; the local cap and a hung judge are handled by the shared handler', { timeout: 20000 }, async t => {
  const { dto } = await dtoFor();
  const adv = rig(t, { mode: 'advisory', script: { components: componentScript(), parts: { P3: .9 } } });
  const ap = await adv.decide.reuse.prepare(dto); const ar = await adv.decide.reuse.run(ap.ticket);
  assert.deepEqual(ar, { status: 'advisory-only', verdict: 'ok' }); assert.equal(adv.calls.length, 1); assert.equal(adv.calibration.entries().length, 1);
  const capped = rig(t, { cap: 5, script: {} }); capped.budget.record({ inputTokens: 9 });
  assert.deepEqual(await capped.decide.reuse.prepare(dto), { status: 'disabled', mode: 'on', reason: 'budget-exceeded' }); assert.equal(capped.calls.length, 0);
  const hung = rig(t, { hang: true, script: {} }); const hp = await hung.decide.reuse.prepare(dto); const t0 = Date.now(); const hr = await hung.decide.reuse.run(hp.ticket);
  assert.deepEqual(hr, { status: 'manual', reason: 'timeout' }); assert.ok(Date.now() - t0 >= 3900 && Date.now() - t0 < 6500); assert.equal(hung.budget.snapshot().unmeteredRequests, 1);
});
void BASE;
