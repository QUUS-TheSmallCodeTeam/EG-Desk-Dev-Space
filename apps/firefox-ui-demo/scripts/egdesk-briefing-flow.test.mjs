// L4 cycle 6: Answer Briefing flow. An agent's final report is judged bubble-or-board by the Decision model (a system-level judge over
// runtime facts); if board, the subjective model (mock engine) designs an Answer Briefing in the existing step/target structure; the judge checks
// the FLOW per step over runtime-enumerated items (understandable, explanation-target match, uncovered target, order, far/overlapping targets) and a
// "where"; findings loop back to the subjective model (max 2 revisions); then the briefing is presented, or the chat answer stays with a note.
// Mounted: the production Board/Decisions HTTP handler (new briefing routes), Decisions client + shared budget, the real calibration log, the support
// world (real controller/WorkbenchArrange geometry for the board facts). Fakes: DOM, provider fetch (synthetic key, no network), the subjective model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as WorkbenchArrange from '../overlay/resources/EGDeskWorkbenchArrange.sys.mjs';
import { validBriefing } from '../overlay/resources/EGDeskBriefingState.sys.mjs';
import { CONTEXT_TOOL_SPECS } from '../helper/egdesk-context-runtime.mjs';
import { createBoardPresentationHttpHandler } from '../helper/egdesk-board-presentation-http.mjs';
import { createDecisionHttpHandler } from '../helper/egdesk-decision-http.mjs';
import { createDecisionBudget, DECISION_MODEL } from '../helper/egdesk-decision-client.mjs';
import { openCalibrationLog } from '../helper/egdesk-decision-calibration-log.mjs';
import { BRIEFING_LIMITS, enumerateBriefingChecks, enumerateBriefingFacts, normalizeBriefingCheckDto, normalizePlacementDto, prepareBriefingCheck, prepareBriefingPlacement,
  readBriefingCheck, readBriefingPlacement, resolveDesign, runBriefingFlow } from '../helper/egdesk-briefing-flow.mjs';
import { world } from './egdesk-board-world.support.mjs';

const KEY = 'egd-synthetic-not-a-key-0004';
const r = (x, y, width, height) => ({ x, y, width, height });
const jc = (id, item, rect, z) => ({ id, item, rect, z, kind: 'note' });

// the schema of the EXISTING publish tool: a proposal must fit it, nothing new
function fits(schema, value, at = 'args') {
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), at + ' is an object');
    for (const k of schema.required || []) assert.ok(Object.hasOwn(value, k), `${at}.${k} required`);
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties || {}, k), `${at}.${k} not allowed`);
    for (const [k, v] of Object.entries(value)) if (schema.properties?.[k]) fits(schema.properties[k], v, `${at}.${k}`);
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity), at + ' array bounds');
    value.forEach((v, i) => schema.items && fits(schema.items, v, `${at}[${i}]`));
  } else if (schema.type === 'string') { assert.equal(typeof value, 'string', at); if (schema.enum) assert.ok(schema.enum.includes(value), at + ' enum'); }
  else if (schema.type === 'integer') assert.ok(Number.isInteger(value), at);
}
const publishSchema = CONTEXT_TOOL_SPECS.find(t => t.name === 'egdesk_publish_briefing_multi').inputSchema;

// ---------------- host rig ----------------
function answerFor(body, script, n) {
  const step = typeof script === 'function' ? script(n, body) : script;
  return body.questions.map(q => {
    if (q.name === 'placement') { const p = step.placement ?? { value: 'board', p: .9 }; return { name: 'placement', type: 'choice', choice: p.value, confidence: p.p, probabilities: [{ value: p.value, probability: p.p }, { value: p.value === 'board' ? 'bubble' : 'board', probability: 1 - p.p }] }; }
    if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: q.name === 'understandable' ? step.u : (step.issues?.[q.name.replace('issue_', '')] ?? .05) };
    const values = q.choices.map(c => c.value), pick = step.where?.value && values.includes(step.where.value) ? step.where.value : 'none', p = step.where?.p ?? .5, other = values.find(v => v !== pick);
    return { name: q.name, type: 'choice', choice: pick, confidence: p, probabilities: [{ value: pick, probability: p }, { value: other, probability: 1 - p }] };
  });
}
function rig(t, { mode = 'on', script, cap = 100000, hang = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-briefing-flow-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const S = { key: KEY, mode };
  const store = { status: 'configured', writable: true, getApiKey: () => S.key, savedAt: () => 17, hint: () => null, save: k => { S.key = k; return true; }, clear: () => { S.key = null; return true; } };
  const modeStore = { get mode() { return S.mode; }, saved: true, persisted: true, save: m => { S.mode = m; return true; } };
  const budget = createDecisionBudget({ monthlyInputTokenCap: cap });
  const calibration = openCalibrationLog({ dataDir: path.join(dir, 'settings'), log() {} });
  const calls = [];
  const provider = async (_u, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    return Response.json({ answers: answerFor(body, script, calls.length - 1), usage: { input_tokens: 11 } });
  };
  const board = createBoardPresentationHttpHandler({ credentials: store, getMode: () => modeStore.mode, budget, fetchImpl: provider, calibrationLog: calibration });
  const settings = createDecisionHttpHandler({ store, mode: modeStore, model: DECISION_MODEL, budget, verifyKey: async () => ({ status: 'verified' }), boardPresentation: board });
  const http = async (method, p, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: p, method, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } });
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(s) { this.status = s; }, end(j) { this.body = JSON.parse(j); this.writableEnded = true; } });
    assert.equal(await settings(req, res, new URL(p, 'http://127.0.0.1:39218')) || await board(req, res, new URL(p, 'http://127.0.0.1:39218')), true, p);
    return { status: res.status, body: res.body };
  };
  const route = root => ({ prepare: async dto => (await http('POST', `${root}/prepare`, dto)).body, run: async ticket => (await http('POST', `${root}/run`, { ticket, confirm: true })).body, cancel: async ticket => (await http('POST', `${root}/cancel`, { ticket })).body });
  return { S, calls, budget, calibration, http, decide: { placement: route('/decision/briefing-placement'), check: route('/decision/briefing-check') } };
}
const engineOf = (log, fn) => async request => { log.push(request); return fn(request, log.length - 1); };

// ---------------- a board with three scattered items (real geometry through the support world) ----------------
const LABELS = { vA: ['Invoice totals', 'Q3 invoice totals and the amount due', 'src-invoice'], vB: ['Delivery log', 'Shipment log showing the delay of two days', 'src-delivery'], vC: ['Customer email', 'Customer email asking for a refund', 'src-email'] };
async function board() {
  const spec = { cards: [jc('vA', 'item-A', r(100, 60, 260, 160), 1), jc('vB', 'item-B', r(700, 420, 260, 160), 2), jc('vC', 'item-C', r(160, 520, 260, 160), 3)], others: [], links: [{ child: 'item-B', parent: 'item-A', kind: 'waits' }] };
  const R0 = { http: async () => ({ status: 503, body: {} }), grant: () => true };
  const W = world({ WorkbenchArrange, ...R0, spec });
  const desk = W.real.arrange().designScene('proj1');
  const candidates = [...desk.cards.filter(c => LABELS[c.id]).map(c => ({ id: c.id, ref: { sourceId: LABELS[c.id][2] }, kind: 'source', label: LABELS[c.id][0], gist: LABELS[c.id][1], onBoard: true, maySend: true, rect: c.rect })),
    { id: 'bound-memo', ref: { sourceId: 'src-memo' }, kind: 'source', label: 'Archived memo', gist: 'Old memo', onBoard: false, maySend: true },
    { id: 'private-note', ref: { sourceId: 'src-private' }, kind: 'source', label: 'Private note', gist: 'secret', onBoard: true, maySend: false }];
  return { W, desk, candidates, viewport: desk.viewport, links: desk.links.map(e => ({ child: 'v' + e.child.slice(-1), parent: 'v' + e.parent.slice(-1), kind: e.kind })) };
}
const REPORT = ['## Delay report', '- Invoice totals show the Q3 amount that was billed.', '- The Delivery log shows the shipment was two days late.', '- The Customer email asks for a refund because of that delay.', '', 'Recommendation: refund the delay fee and ship the replacement.'].join('\n');
const design0 = () => ({ title: 'Why the shipment is late', steps: [
  { text: 'The invoice total of Q3 is the amount billed.', targets: ['T1'], fallback: 'Open the invoice totals.' },
  { text: 'The invoice total was disputed by the customer.', targets: ['T2'], emphasis: 'outline', fallback: 'Open the delivery log.' },
  { text: 'The customer asks for a refund.', targets: ['T3'], fallback: 'Open the customer email.' }] });

// ---------------- 1. facts and options are built from the real board ----------------
test('facts: what the report refers to, whether it exists on the board, size and structure; a card the user may not send is not counted', async () => {
  const b = await board(); const e = enumerateBriefingFacts({ report: REPORT, candidates: b.candidates });
  assert.deepEqual(e.facts, { chars: REPORT.length, lines: 5, listItems: 3, headings: 1, tableRows: 0, referenced: 3, onBoard: 3 });
  assert.equal(e.boardFeasible, true); assert.deepEqual(e.targets.map(t => [t.alias, t.label, t.onBoard, t.referenced]), [['T1', 'Invoice totals', true, true], ['T2', 'Delivery log', true, true], ['T3', 'Customer email', true, true], ['T4', 'Archived memo', false, false]]);
  assert.ok(!JSON.stringify(e).includes('Private note') && !JSON.stringify(e).includes('secret'));
  const none = enumerateBriefingFacts({ report: 'Done. The total is 42.', candidates: b.candidates });
  assert.equal(none.boardFeasible, false); assert.equal(enumerateBriefingFacts({ report: 'Only the Invoice totals matter.', candidates: b.candidates }).boardFeasible, false, 'one referenced item is not a briefing');
  assert.equal(enumerateBriefingFacts({ report: 'Invoice totals and Delivery log.', candidates: b.candidates.map(c => ({ ...c, onBoard: false })) }).boardFeasible, false, 'referenced but not on the board');
});
test('placement judge: counts only, a choice between bubble and board, bubble when unsure', () => {
  const dto = { facts: { chars: 300, lines: 5, listItems: 3, headings: 1, tableRows: 0, referenced: 3, onBoard: 3 } };
  const p = prepareBriefingPlacement({ mode: 'on', binding: 'b', dto });
  assert.deepEqual(p.packet.questions.map(q => [q.name, q.type, q.choices.map(c => c.value)]), [['placement', 'choice', ['bubble', 'board']]]);
  assert.ok(!/Invoice|Delivery|label/.test(JSON.stringify(p.packet)), 'no content in the placement packet');
  const read = (v, pr) => readBriefingPlacement(p, { placement: { type: 'choice', choice: v, confidence: pr, probabilities: [{ value: v, probability: pr }, { value: v === 'board' ? 'bubble' : 'board', probability: 1 - pr }] } }, 'b').status;
  assert.deepEqual([read('board', .9), read('bubble', .9), read('board', .6)], ['board', 'bubble', 'inconclusive']);
  assert.equal(prepareBriefingPlacement({ mode: 'on', binding: 'b', dto: { facts: { ...dto.facts, onBoard: 1, referenced: 1 } } }).status, 'manual', 'the board option does not exist with fewer than two referenced board items');
  assert.equal(normalizePlacementDto({ ...dto, extra: 1 }), null); assert.equal(prepareBriefingPlacement({ mode: 'off', binding: 'b', dto }).status, 'manual');
});

// ---------------- 2. design resolution fits the existing briefing structures ----------------
test('design resolution: only listed on-board targets, existing step shape; the proposal fits egdesk_publish_briefing_multi', async () => {
  const b = await board(); const e = enumerateBriefingFacts({ report: REPORT, candidates: b.candidates });
  const ok = resolveDesign(design0(), e);
  assert.equal(ok.ok, true); fits(publishSchema, ok.publishArgs);
  assert.deepEqual(ok.publishArgs.steps.map(s => s.targets), [[{ sourceId: 'src-invoice' }], [{ sourceId: 'src-delivery' }], [{ sourceId: 'src-email' }]]);
  assert.equal(validBriefing({ id: 'x', title: ok.publishArgs.title, steps: ok.publishArgs.steps }), true);
  for (const [mut, reason] of [[d => { d.steps[0].targets = ['T4']; }, 'off-board-target'], [d => { d.steps[0].targets = ['T9']; }, 'unknown-target'], [d => { d.steps[0].targets = []; }, 'no-targets'],
    [d => { d.steps[0].targets = ['T1', 'T1']; }, 'duplicate-target'], [d => { d.steps[1].text = ''; }, 'empty-text'], [d => { d.steps[1].text = 'x'.repeat(BRIEFING_LIMITS.textMax + 1); }, 'text-too-long'],
    [d => { delete d.steps[2].fallback; }, 'no-fallback'], [d => { d.steps[2].emphasis = 'blink'; }, 'bad-emphasis'], [d => { d.steps = []; }, 'no-steps'], [d => { d.title = ' '; }, 'no-title']]) {
    const d = design0(); mut(d); assert.equal(resolveDesign(d, e).reason, reason, reason);
  }
});

// ---------------- 3. the flow check enumerates per step from the design and the board ----------------
test('check items: per step understandability and explanation-target match, plus uncovered target, step order, far and overlapping targets', async () => {
  const b = await board(); const e = enumerateBriefingFacts({ report: REPORT, candidates: b.candidates });
  const full = resolveDesign(design0(), e);
  const base = enumerateBriefingChecks(full.steps, e, { links: b.links, viewport: b.viewport });
  assert.deepEqual(base.items.map(i => i.key), ['step_unclear_S1', 'explanation_mismatch_S1', 'step_unclear_S2', 'explanation_mismatch_S2', 'step_unclear_S3', 'explanation_mismatch_S3']);
  assert.deepEqual(base.items.find(i => i.key === 'explanation_mismatch_S2').aliases, ['S2', 'T2']);
  const partial = resolveDesign({ title: 'two steps', steps: [{ text: 'Delivery log first.', targets: ['T2'], fallback: 'f' }, { text: 'Then the invoice.', targets: ['T1'], fallback: 'f' }] }, e);
  const some = enumerateBriefingChecks(partial.steps, e, { links: b.links, viewport: b.viewport });
  assert.deepEqual(some.items.find(i => i.name === 'uncovered_target').aliases, ['T3'], 'a referenced board item that no step covers');
  assert.deepEqual(some.items.find(i => i.name === 'step_order').aliases, ['S1', 'S2'], 'the delivery log (child of the invoice) is explained before it');
  const far = resolveDesign({ title: 'far', steps: [{ text: 'Both together.', targets: ['T1', 'T2'], fallback: 'f' }] }, e);
  assert.equal(enumerateBriefingChecks(far.steps, e, { links: [], viewport: r(0, 0, 400, 300) }).items.some(i => i.name === 'targets_far'), true, 'a small view cannot read two distant targets together');
  assert.equal(enumerateBriefingChecks(far.steps, e, { links: [], viewport: r(0, 0, 3000, 2000) }).items.some(i => i.name === 'targets_far'), false);
  const eo = { ...e, targets: e.targets.map(t => t.alias === 'T2' ? { ...t, rect: r(120, 80, 260, 160) } : t) };
  assert.equal(enumerateBriefingChecks(resolveDesign({ title: 'o', steps: [{ text: 'Both.', targets: ['T1', 'T2'], fallback: 'f' }] }, eo).steps, eo, { viewport: b.viewport }).items.some(i => i.name === 'targets_overlap'), true);
});

// ---------------- 4. the whole flow ----------------
test('flow A: a report about three scattered board items -> board -> design -> check finds step 2 does not match its target -> redesign -> passes', async t => {
  const b = await board();
  const R = rig(t, { script: n => n === 0 ? { placement: { value: 'board', p: .93 } } : n === 1 ? { u: .15, issues: { explanation_mismatch_S2: .92 }, where: { value: 'S2', p: .9 } } : { u: .96, issues: {} } });
  const seen = [], engineLog = [];
  const out = await runBriefingFlow({ report: REPORT, candidates: b.candidates, links: b.links, viewport: b.viewport, decide: R.decide, allow: async (kind, preview) => { seen.push([kind, JSON.stringify(preview.packet)]); return true; },
    engine: engineOf(engineLog, (req, i) => i === 0 ? design0() : (() => { const d = design0(); d.steps[1].text = 'The delivery log shows the shipment was two days late.'; return d; })()) });
  assert.equal(out.status, 'presented', JSON.stringify(out)); assert.equal(out.revisions, 1);
  assert.deepEqual(out.stats, { judgeRequests: 3, designRounds: 2 }); assert.equal(R.calls.length, 3, 'one paid request per judgment: placement, check, re-check');
  fits(publishSchema, out.publishArgs); assert.equal(out.publishArgs.steps[1].text, 'The delivery log shows the shipment was two days late.');
  // what the subjective model was told
  assert.deepEqual(engineLog.map(x => x.kind), ['briefing_design', 'briefing_redesign']);
  assert.deepEqual(engineLog[0].targets.map(x => x.alias), ['T1', 'T2', 'T3'], 'only targets that exist on the board are offered'); assert.ok(!JSON.stringify(engineLog[0]).includes('Private'));
  const f = engineLog[1].findings; assert.deepEqual(f.map(x => [x.item, x.scope, x.aliases]), [['explanation_mismatch', 'S2', ['S2', 'T2']]]); assert.deepEqual(engineLog[1].where, { alias: 'S2', p: .9 });
  assert.equal(engineLog[1].revision, 1); assert.equal(engineLog[1].remaining, 1); assert.equal(engineLog[1].previous[1].text, 'The invoice total was disputed by the customer.');
  // what left the machine: counts for the placement; steps/labels/gists for the check; never an id, a path, a coordinate or a card the user may not send
  assert.equal(seen[0][0], 'placement'); assert.ok(!/Invoice|Delivery|Customer/.test(seen[0][1]));
  for (const [, packet] of seen.slice(1)) for (const bad of ['src-invoice', 'src-delivery', 'vA', 'item-A', 'rect', 'Private note', 'secret', KEY, '"x":']) assert.ok(!packet.includes(bad), 'check packet is free of ' + bad);
  assert.ok(seen[1][1].includes('Delivery log') && seen[1][1].includes('The invoice total was disputed'), 'the check judges the explanation against its target');
  // metering and calibration: content-free rows, one per judgment
  assert.equal(R.budget.snapshot().inputTokens, 33);
  const rows = R.calibration.entries(); assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(x => [x.feature, x.mode, x.judgments[0].q + ':' + x.judgments[0].would]), [['board_arrangement', 'on', 'choice:act'], ['board_arrangement', 'on', 'goal_met:act'], ['board_arrangement', 'on', 'goal_met:none']]);
  assert.ok(!/Invoice|Delivery|S2|T2|src-|explanation_mismatch/.test(JSON.stringify(rows)), 'calibration is content-free');
});
test('flow B: a short answer stays a chat bubble; no judge request, no design request', async t => {
  const b = await board(); const R = rig(t, { script: { u: .1 } }); const engineLog = [];
  for (const report of ['Done. The total is 42.', 'Only the Invoice totals matter here.']) {
    const out = await runBriefingFlow({ report, candidates: b.candidates, links: b.links, viewport: b.viewport, decide: R.decide, engine: engineOf(engineLog, () => design0()) });
    assert.deepEqual([out.status, out.reason, out.requested], ['bubble', 'no-board-targets', false]);
  }
  assert.equal(R.calls.length, 0); assert.equal(engineLog.length, 0);
});
test('flow B2: the judge may also keep a report that does reference several board items in the bubble; an unsure answer is a bubble too', async t => {
  const b = await board();
  for (const [placement, reason] of [[{ value: 'bubble', p: .92 }, 'judged-bubble'], [{ value: 'board', p: .55 }, 'placement-undecided']]) {
    const R = rig(t, { script: { placement } }); const engineLog = [];
    const out = await runBriefingFlow({ report: REPORT, candidates: b.candidates, links: b.links, viewport: b.viewport, decide: R.decide, engine: engineOf(engineLog, () => design0()) });
    assert.deepEqual([out.status, out.reason, out.stats.judgeRequests], ['bubble', reason, 1]); assert.equal(engineLog.length, 0); assert.equal(R.calls.length, 1);
  }
});
test('flow C: an inconclusive check falls back to the chat answer after the bound (2 revisions), the subjective model told each time', async t => {
  const b = await board();
  const R = rig(t, { script: n => n === 0 ? { placement: { value: 'board', p: .9 } } : { u: .5, issues: { explanation_mismatch_S2: .6, step_unclear_S2: .55 } } }); const engineLog = [];
  const out = await runBriefingFlow({ report: REPORT, candidates: b.candidates, links: b.links, viewport: b.viewport, decide: R.decide, engine: engineOf(engineLog, () => design0()) });
  assert.deepEqual([out.status, out.reason, out.revisions], ['fallback-chat', 'check-inconclusive', 2]);
  assert.deepEqual(out.stats, { judgeRequests: 4, designRounds: 3 }); assert.equal(R.calls.length, 4, 'bounded: 1 placement + 3 checks');
  assert.deepEqual(engineLog.map(x => x.kind), ['briefing_design', 'briefing_redesign_inconclusive', 'briefing_redesign_inconclusive']); assert.deepEqual(engineLog.map(x => x.remaining), [undefined, 1, 0]);
  assert.equal(R.calibration.entries().filter(x => x.judgments[0].would === 'hold').length, 3);
  // findings that never clear end the same way, with their own reason
  const R2 = rig(t, { script: n => n === 0 ? { placement: { value: 'board', p: .9 } } : { u: .1, issues: { explanation_mismatch_S2: .95 }, where: { value: 'S2', p: .9 } } });
  const out2 = await runBriefingFlow({ report: REPORT, candidates: b.candidates, links: b.links, viewport: b.viewport, decide: R2.decide, engine: async () => design0() });
  assert.deepEqual([out2.status, out2.reason, out2.stats.judgeRequests], ['fallback-chat', 'check-not-passed', 4]);
});
test('flow D: designs that do not resolve are retried within the bound, then the chat answer stays', async t => {
  const b = await board(); const R = rig(t, { script: { placement: { value: 'board', p: .9 } } }); const engineLog = [];
  const bad = [{ title: 't', steps: [{ text: 'x', targets: ['T4'], fallback: 'f' }] }, { title: 't', steps: [{ text: 'x', targets: ['T9'], fallback: 'f' }] }, { title: 't', steps: [] }];
  const out = await runBriefingFlow({ report: REPORT, candidates: b.candidates, decide: R.decide, engine: engineOf(engineLog, (req, i) => bad[i]) });
  assert.deepEqual([out.status, out.reason, out.detail], ['fallback-chat', 'design-invalid', 'no-steps']); assert.equal(R.calls.length, 1, 'no check is paid for a design that does not resolve');
  assert.deepEqual(engineLog.map(x => x.invalid ?? null), [null, 'off-board-target', 'unknown-target']);
});
test('modes, budget and deadline: off never judges, advisory records only, a spent cap sends nothing more, a hung judge ends at the 4 s deadline', { timeout: 20000 }, async t => {
  const b = await board(); const engineLog = [];
  const off = rig(t, { mode: 'off', script: {} });
  assert.deepEqual((({ status, reason, stats }) => [status, reason, stats.judgeRequests])(await runBriefingFlow({ report: REPORT, candidates: b.candidates, decide: off.decide, engine: engineOf(engineLog, () => design0()) })), ['bubble', 'judge-unavailable', 0]); assert.equal(off.calls.length, 0);
  const adv = rig(t, { mode: 'advisory', script: { placement: { value: 'board', p: .93 } } });
  const ao = await runBriefingFlow({ report: REPORT, candidates: b.candidates, decide: adv.decide, engine: engineOf(engineLog, () => design0()) });
  assert.deepEqual([ao.status, ao.verdict], ['advisory-only', 'board']); assert.equal(engineLog.length, 0, 'advisory never starts a design'); assert.equal(adv.calls.length, 1); assert.equal(adv.calibration.entries().length, 1);
  const capped = rig(t, { cap: 5, script: { placement: { value: 'board', p: .9 } } });
  const co = await runBriefingFlow({ report: REPORT, candidates: b.candidates, decide: capped.decide, engine: engineOf(engineLog, () => design0()) });
  assert.deepEqual([co.status, co.reason, co.detail, co.stats.judgeRequests], ['fallback-chat', 'judge-unavailable', 'budget-exceeded', 1]); assert.equal(capped.calls.length, 1);
  const hung = rig(t, { hang: true, script: {} }); const started = Date.now();
  const ho = await runBriefingFlow({ report: REPORT, candidates: b.candidates, decide: hung.decide, engine: engineOf(engineLog, () => design0()) });
  assert.deepEqual([ho.status, ho.reason], ['bubble', 'placement-undecided']); assert.ok(Date.now() - started >= 3900 && Date.now() - started < 6500);
  assert.equal(hung.budget.snapshot().unmeteredRequests, 1); assert.deepEqual(hung.calibration.entries().map(x => x.fallback), ['timeout']);
});
test('closed wire shapes: the check DTO refuses extra fields, unknown items and undeclared aliases', async () => {
  const b = await board(); const e = enumerateBriefingFacts({ report: REPORT, candidates: b.candidates }); const full = resolveDesign(design0(), e);
  const checks = enumerateBriefingChecks(full.steps, e, { links: [], viewport: b.viewport });
  const out = []; await runBriefingFlow({ report: REPORT, candidates: b.candidates, decide: { placement: { prepare: async () => ({ status: 'prepared', preview: {}, ticket: 't' }), run: async () => ({ status: 'board' }), cancel: async () => ({}) },
    check: { prepare: async dto => { out.push(dto); return { status: 'disabled', reason: 'x' }; }, run: async () => ({}), cancel: async () => ({}) } }, engine: async () => design0() });
  const dto = out[0]; assert.ok(normalizeBriefingCheckDto(dto)); assert.ok(prepareBriefingCheck({ mode: 'on', binding: 'b', dto }).packet.questions.length > 3);
  for (const bad of [{ ...dto, extra: 1 }, { ...dto, items: [{ ...dto.items[0], name: 'free' }] }, { ...dto, items: [{ ...dto.items[0], aliases: ['S9'] }] }, { ...dto, steps: [{ ...dto.steps[0], id: 's1' }, ...dto.steps.slice(1)] },
    { ...dto, targets: [{ alias: 'T1', kind: 'source', label: 'ok', sourceId: 'leak' }, ...dto.targets.slice(1)] }]) assert.equal(normalizeBriefingCheckDto(bad), null);
  void checks;
});
test('readBriefingCheck: findings need a flawed flow and an item over the bar; middling is inconclusive; unusable is manual', async () => {
  const b = await board(); const e = enumerateBriefingFacts({ report: REPORT, candidates: b.candidates }); const full = resolveDesign(design0(), e);
  const dto = []; await runBriefingFlow({ report: REPORT, candidates: b.candidates, decide: { placement: { prepare: async () => ({ status: 'prepared', preview: {}, ticket: 't' }), run: async () => ({ status: 'board' }), cancel: async () => ({}) },
    check: { prepare: async d => { dto.push(d); return { status: 'disabled' }; }, run: async () => ({}), cancel: async () => ({}) } }, engine: async () => design0() });
  const p = prepareBriefingCheck({ mode: 'on', binding: 'b', dto: dto[0] }); const names = p.packet.questions.filter(q => q.type === 'predicate').map(q => q.name);
  const answers = (u, issues = {}, where = null) => ({ understandable: { type: 'predicate', probability: u }, ...Object.fromEntries(names.filter(n => n !== 'understandable').map(n => [n, { type: 'predicate', probability: issues[n.replace('issue_', '')] ?? .05 }])),
    where: { type: 'choice', choice: where?.value ?? 'none', confidence: where?.p ?? .5, probabilities: [{ value: where?.value ?? 'none', probability: where?.p ?? .5 }, { value: where ? 'none' : 'S1', probability: 1 - (where?.p ?? .5) }] } });
  const read = a => readBriefingCheck(p, a, 'b');
  assert.deepEqual(read(answers(.1, { explanation_mismatch_S2: .9 }, { value: 'S2', p: .9 })).findings, [{ item: 'explanation_mismatch', scope: 'S2', aliases: ['S2', 'T2'], p: .9 }]);
  assert.equal(read(answers(.95)).status, 'ok'); assert.equal(read(answers(.95, { step_unclear_S1: .9 })).status, 'inconclusive'); assert.equal(read(answers(.5, { step_unclear_S1: .9 })).status, 'inconclusive');
  assert.equal(read(answers(.1, { step_unclear_S1: .4 })).status, 'inconclusive'); assert.equal(read({ ...answers(.1), understandable: { type: 'refusal' } }).status, 'manual'); void full;
});
