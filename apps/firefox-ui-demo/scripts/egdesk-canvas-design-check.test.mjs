// L4 cycle 5: the canvas design check. The Decision model is a system-level judge over items the canvas runtime enumerates; the
// subjective model (a mock engine here) redesigns; the user previews / applies / undoes on their own screen only.
// Mounted: EGDeskCanvasDesignCheck (runtime), the production Board/Decisions HTTP handler with the new canvas-check routes, the Decisions
// client + shared budget, the real calibration log, EGDeskCanvasRedesign (hand-off, validation, orchestration), the real presentation
// controller through WorkbenchArrange, and the surface history (Cmd+Z) via the shared support world. Fakes: DOM, pref store, provider fetch
// (synthetic key egd-synthetic-not-a-key-0004, no network), the subjective model.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as WorkbenchArrange from '../overlay/resources/EGDeskWorkbenchArrange.sys.mjs';
import { enumerateCanvasChecks, checkRequestDto, sceneFromDesk, CANVAS_CHECK_ITEMS, CHECK_ITEM_NAMES } from '../overlay/resources/EGDeskCanvasDesignCheck.sys.mjs';
import { buildRedesignRequest, validateRedesignProposal, runCanvasDesignCheck } from '../overlay/resources/EGDeskCanvasRedesign.sys.mjs';
import { createBoardPresentationHttpHandler } from '../helper/egdesk-board-presentation-http.mjs';
import { createDecisionHttpHandler } from '../helper/egdesk-decision-http.mjs';
import { createDecisionBudget, DECISION_MODEL } from '../helper/egdesk-decision-client.mjs';
import { openCalibrationLog } from '../helper/egdesk-decision-calibration-log.mjs';
import { normalizeCanvasCheckDto, prepareCanvasDesignCheck, readCanvasDesignCheck } from '../helper/egdesk-canvas-design-check.mjs';
import { world } from './egdesk-board-world.support.mjs';

const KEY = 'egd-synthetic-not-a-key-0004';
const r = (x, y, width, height) => ({ x, y, width, height });
const card = (id, rect, extra = {}) => ({ id, rect, kind: '메모', maySend: true, movable: true, inFrame: true, ...extra });

// ---------------- 1. the runtime enumerates items and locations by code ----------------
test('runtime: every item is computable from geometry/relations and carries alias locations', () => {
  const scene = {
    cards: [card('a', r(600, 60, 260, 160), { important: true, inFrame: false }), card('b', r(100, 60, 260, 160)), card('c', r(100, 480, 260, 160)),
      card('d', r(20, 620, 200, 160)), card('e', r(105, 70, 100, 40, ), { kind: '자료' }), card('f', r(900, 60, 600, 400), { kind: '자료' }),
      card('private', r(0, 0, 50, 50), { maySend: false })],
    links: [{ child: 'b', parent: 'a', kind: 'waits' }, { child: 'c', parent: 'b', kind: 'waits' }, { child: 'd', parent: 'a', kind: 'refs' }],
    groups: [{ id: 'g1', viewIds: ['a', 'b'] }, { id: 'g2', viewIds: ['c', 'private'] }],
    capabilities: { groupLabels: true },
  };
  scene.cards[0].refs = ['c'];
  const e = enumerateCanvasChecks(scene);
  const by = n => e.items.find(i => i.name === n);
  assert.deepEqual(e.items.map(i => i.name), ['reading_order', 'related_far', 'overlap', 'unlabeled_group', 'missing_relation', 'size_inconsistent', 'misaligned', 'offscreen_important']);
  assert.deepEqual(by('reading_order').aliases, ['A', 'B'], 'parent a is read after child b');
  assert.deepEqual(by('related_far').aliases, ['A', 'D']);
  assert.ok(by('overlap').aliases.includes('B') && by('overlap').aliases.includes('E'));
  assert.deepEqual(by('unlabeled_group').aliases, ['G1'], 'a group with a private member is not a candidate (one eligible member)');
  assert.deepEqual(by('missing_relation').aliases, ['A', 'C']);
  assert.deepEqual(by('size_inconsistent').aliases.sort(), ['F', 'E'].sort());
  assert.deepEqual(by('offscreen_important').aliases, ['A']);
  for (const i of e.items) { assert.ok(CHECK_ITEM_NAMES.includes(i.name) && CANVAS_CHECK_ITEMS[i.name]); assert.ok(i.aliases.length && i.measure.count === i.aliases.length); }
  const known = new Set([...e.cards.map(c => c.alias), ...e.groups.map(g => g.alias)]);
  assert.ok(e.items.every(i => i.aliases.every(a => known.has(a))), 'locations are aliases of candidates only');
  assert.ok(!e.cards.some(c => c.id === 'private') && !JSON.stringify(e.items).includes('private'), 'a card the user may not send is not even counted');
  assert.deepEqual([...e.idOf.keys()].sort(), e.cards.map(c => c.alias).sort());
});
test('runtime: a clean flow enumerates nothing; group labels are only an item when the canvas can carry one', () => {
  const clean = { cards: [card('a', r(100, 60, 260, 160)), card('b', r(400, 60, 260, 160)), card('c', r(400, 300, 260, 160))],
    links: [{ child: 'b', parent: 'a', kind: 'waits' }, { child: 'c', parent: 'b', kind: 'waits' }], groups: [{ id: 'g', viewIds: ['a', 'b'] }] };
  assert.deepEqual(enumerateCanvasChecks(clean).items, []);
  assert.equal(checkRequestDto(enumerateCanvasChecks(clean), { purpose: 'x' }), null);
  assert.equal(enumerateCanvasChecks({ ...clean, capabilities: { groupLabels: true } }).items.find(i => i.name === 'unlabeled_group')?.aliases[0], 'G1');
});
test('runtime DTO: closed, content-free; a label travels only when the host supplied one for a sendable card', () => {
  const e = enumerateCanvasChecks({ cards: [card('secret-id-1', r(600, 60, 260, 160), { label: 'Quarterly\u0007 report' }), card('secret-id-2', r(100, 60, 260, 160))], links: [{ child: 'secret-id-2', parent: 'secret-id-1', kind: 'waits' }] });
  const dto = checkRequestDto(e, { purpose: '  인계 흐름 점검  ' });
  assert.deepEqual(Object.keys(dto), ['purpose', 'cards', 'groups', 'items']);
  assert.equal(dto.purpose, '인계 흐름 점검');
  assert.deepEqual(dto.cards, [{ alias: 'A', kind: '메모', label: 'Quarterly report' }, { alias: 'B', kind: '메모' }]);
  assert.ok(!JSON.stringify(dto).includes('secret-id') && !/"x"|"y"|rect/.test(JSON.stringify(dto)), 'no id, no coordinates');
  assert.ok(normalizeCanvasCheckDto(dto));
  for (const bad of [{ ...dto, extra: 1 }, { ...dto, items: [{ ...dto.items[0], name: 'free_text' }] }, { ...dto, items: [{ ...dto.items[0], aliases: ['Z'] }] },
    { ...dto, cards: [{ alias: 'a', kind: '메모' }] }, { ...dto, purpose: 'x\u0000y' }, { ...dto, cards: [{ alias: 'A', kind: '메모', label: 'ok', note: 'x' }, dto.cards[1]] }]) assert.equal(normalizeCanvasCheckDto(bad), null);
});

// ---------------- 2. the Decision step reads closed answers by fixed bars ----------------
const answers = (u, issues = {}, where = null) => ({ understandable: { type: 'predicate', probability: u }, ...Object.fromEntries(Object.entries(issues).map(([k, p]) => [`issue_${k}`, { type: 'predicate', probability: p }])),
  ...(where ? { where: { type: 'choice', choice: where.value, confidence: where.p, probabilities: [{ value: where.value, probability: where.p }, { value: 'none', probability: 1 - where.p }] } } : {}) });
function preparedFor(mode = 'on') {
  const e = enumerateCanvasChecks({ cards: [card('a', r(600, 60, 260, 160)), card('b', r(100, 60, 260, 160)), card('c', r(105, 70, 260, 160))], links: [{ child: 'b', parent: 'a', kind: 'waits' }] });
  return prepareCanvasDesignCheck({ mode, binding: 'bind', dto: checkRequestDto(e, { purpose: '인계 점검' }) });
}
test('judge: packet asks one predicate for the flow, one per enumerated item and one choice over the runtime locations (plus none)', () => {
  const p = preparedFor();
  assert.deepEqual(p.packet.questions.map(q => q.name), ['understandable', 'issue_reading_order', 'issue_overlap', 'issue_misaligned', 'where']);
  assert.deepEqual(p.packet.questions.map(q => q.type), ['predicate', 'predicate', 'predicate', 'predicate', 'choice']);
  assert.deepEqual(p.packet.questions.at(-1).choices.map(c => c.value), ['A', 'B', 'C', 'none']);
  assert.equal(JSON.stringify(p.packet).includes('"rect"'), false);
  assert.equal(preparedFor('off').status, 'manual');
  assert.equal(JSON.stringify(p.packet.input).includes('rect'), false);
});
test('judge: findings need a flawed flow AND an item over the bar; understandable & clean is ok; anything middling is inconclusive; unusable is manual', () => {
  const p = preparedFor();
  const read = a => readCanvasDesignCheck(p, { ...a, ...Object.fromEntries(['reading_order', 'overlap', 'misaligned'].filter(k => !a[`issue_${k}`]).map(k => [`issue_${k}`, { type: 'predicate', probability: .1 }])) }, 'bind');
  assert.deepEqual(read(answers(.1, { reading_order: .92, overlap: .2 }, { value: 'A', p: .9 })).findings, [{ item: 'reading_order', aliases: ['A', 'B'], p: .92 }]);
  assert.deepEqual(read(answers(.1, { reading_order: .92, overlap: .2 }, { value: 'A', p: .9 })).where, { alias: 'A', p: .9 });
  assert.equal(read(answers(.1, { reading_order: .92, overlap: .2 }, { value: 'A', p: .6 })).where, null, 'an unsure where stays unnamed, the item aliases remain the locations');
  assert.equal(read(answers(.1, { reading_order: .92 }, { value: 'C', p: .9 })).where, null, 'a location outside the applied findings is not named');
  assert.equal(read(answers(.95, { reading_order: .2, overlap: .1 })).status, 'ok');
  assert.equal(read(answers(.95, { reading_order: .9, overlap: .1 })).status, 'inconclusive', 'contradiction');
  assert.equal(read(answers(.5, { reading_order: .9, overlap: .9 })).status, 'inconclusive', 'middling flow');
  assert.equal(read(answers(.1, { reading_order: .4, overlap: .5 })).status, 'inconclusive', 'flawed but nothing locatable over the bar');
  assert.equal(read({ ...answers(.1, { reading_order: .9, overlap: .9 }), understandable: { type: 'refusal' } }).status, 'manual');
  assert.equal(readCanvasDesignCheck(p, answers(.1, { reading_order: .9, overlap: .9 }), 'other-binding').status, 'manual');
});

// ---------------- 3. host rig: ONE credential store, mode, budget and calibration log ----------------
function answerFor(body, script) {
  return body.questions.map(q => {
    if (q.type === 'predicate') return { name: q.name, type: 'predicate', probability: q.name === 'understandable' ? script.u : (script.issues?.[q.name.replace('issue_', '')] ?? .05) };
    const values = q.choices.map(c => c.value), pick = script.where?.value && values.includes(script.where.value) ? script.where.value : 'none', p = script.where?.p ?? .5;
    const other = values.find(v => v !== pick);
    return { name: q.name, type: 'choice', choice: pick, confidence: p, probabilities: [{ value: pick, probability: p }, { value: other, probability: 1 - p }] };
  });
}
function rig(t, { mode = 'on', script = { u: .1, issues: {} }, cap = 100000, hang = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-canvas-check-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const S = { key: KEY, mode, grant: true, script };
  const store = { status: 'configured', writable: true, getApiKey: () => S.key, savedAt: () => 17, hint: () => null, save: k => { S.key = k; return true; }, clear: () => { S.key = null; return true; } };
  const modeStore = { get mode() { return S.mode; }, saved: true, persisted: true, save: m => { S.mode = m; return true; } };
  const budget = createDecisionBudget({ monthlyInputTokenCap: cap });
  const calibration = openCalibrationLog({ dataDir: path.join(dir, 'settings'), log() {} });
  const calls = [];
  const provider = async (_u, init) => {
    const body = JSON.parse(init.body); calls.push(body);
    if (hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
    return Response.json({ answers: answerFor(body, S.script), usage: { input_tokens: 11 } });
  };
  const board = createBoardPresentationHttpHandler({ credentials: store, getMode: () => modeStore.mode, budget, fetchImpl: provider, calibrationLog: calibration });
  const settings = createDecisionHttpHandler({ store, mode: modeStore, model: DECISION_MODEL, budget, verifyKey: async () => ({ status: 'verified' }), boardPresentation: board });
  const http = async (method, p, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: p, method, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } });
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(s) { this.status = s; }, end(j) { this.body = JSON.parse(j); this.writableEnded = true; } });
    assert.equal(await settings(req, res, new URL(p, 'http://127.0.0.1:39218')) || await board(req, res, new URL(p, 'http://127.0.0.1:39218')), true, p);
    return { status: res.status, body: res.body };
  };
  const decide = { prepare: async dto => (await http('POST', '/decision/canvas-check/prepare', dto)).body, run: async ticket => (await http('POST', '/decision/canvas-check/run', { ticket, confirm: true })).body,
    cancel: async ticket => (await http('POST', '/decision/canvas-check/cancel', { ticket })).body };
  return { S, calls, budget, calibration, http, decide, board };
}
const strictEngine = (log, proposal = null) => async request => { log.push(request); return typeof proposal === 'function' ? proposal(request) : proposal; };

test('handler: one explicit run is one paid request; the answer is metered once; off sends nothing; advisory returns the verdict kind only', async t => {
  const e = enumerateCanvasChecks({ cards: [card('a', r(600, 60, 260, 160)), card('b', r(100, 60, 260, 160))], links: [{ child: 'b', parent: 'a', kind: 'waits' }] });
  const dto = checkRequestDto(e, { purpose: '인계 점검' });
  const on = rig(t, { mode: 'on', script: { u: .1, issues: { reading_order: .9 }, where: { value: 'A', p: .9 } } });
  await on.http('GET', '/decision/status');
  const prepared = await on.decide.prepare(dto);
  assert.equal(prepared.status, 'prepared'); assert.equal(on.calls.length, 0, 'prepare is local');
  assert.equal(prepared.preview.packet.questions.length, 3);
  const reply = await on.decide.run(prepared.ticket);
  assert.deepEqual([reply.status, reply.findings, reply.where], ['findings', [{ item: 'reading_order', aliases: ['A', 'B'], p: .9 }], { alias: 'A', p: .9 }]);
  assert.equal(on.calls.length, 1); assert.equal(on.budget.snapshot().inputTokens, 11);
  assert.equal((await on.decide.run(prepared.ticket)).status, 'manual', 'a ticket is single use');
  assert.equal(on.calls.length, 1);
  const off = rig(t, { mode: 'off' }); assert.equal((await off.decide.prepare(dto)).status, 'disabled'); assert.equal(off.calls.length, 0);
  const adv = rig(t, { mode: 'advisory', script: { u: .1, issues: { reading_order: .9 }, where: { value: 'A', p: .9 } } });
  const ap = await adv.decide.prepare(dto); const ar = await adv.decide.run(ap.ticket);
  assert.deepEqual(ar, { status: 'advisory-only', verdict: 'findings' }, 'advisory records only: no findings leave the judge');
  assert.equal(adv.calls.length, 1);
  const cal = adv.calibration.entries(); assert.equal(cal.length, 1);
  assert.deepEqual([cal[0].feature, cal[0].mode, cal[0].judgments.map(j => j.q + ':' + j.would)], ['board_arrangement', 'advisory', ['goal_met:act', 'relevance:accept', 'choice:accept']]);
  assert.ok(!/purpose|인계|"A"|reading_order|kind/.test(JSON.stringify(cal).replace(/"kind":"board"/g, '')), 'calibration is content-free');
});
test('handler: the local monthly cap refuses before sending; a spend limit is named and adds nothing; mode/key change while pending aborts and estimates', async t => {
  const e = enumerateCanvasChecks({ cards: [card('a', r(600, 60, 260, 160)), card('b', r(100, 60, 260, 160))], links: [{ child: 'b', parent: 'a', kind: 'waits' }] });
  const dto = checkRequestDto(e, { purpose: '인계 점검' });
  const capped = rig(t, { cap: 1 }); capped.budget.record({ inputTokens: 5 });
  assert.deepEqual(await capped.decide.prepare(dto), { status: 'disabled', mode: 'on', reason: 'budget-exceeded' }); assert.equal(capped.calls.length, 0);
  const hung = rig(t, { hang: true }); await hung.http('GET', '/decision/status');
  const pr = await hung.decide.prepare(dto); const pending = hung.decide.run(pr.ticket);
  while (!hung.calls.length) await new Promise(res => setTimeout(res, 5));
  await hung.http('POST', '/decision/mode', { mode: 'advisory' });
  assert.equal((await pending).status, 'manual'); assert.equal(hung.calls.length, 1);
  const snap = hung.budget.snapshot(); assert.equal(snap.inputTokens, 0); assert.equal(snap.unmeteredRequests, 1); assert.ok(snap.estimatedInputTokens > 0, 'sent-then-cancelled is counted as an estimate');
});
test('handler: a request that never answers stops at the 4 s foreground deadline with a named timeout and an estimate', { timeout: 15000 }, async t => {
  const e = enumerateCanvasChecks({ cards: [card('a', r(600, 60, 260, 160)), card('b', r(100, 60, 260, 160))], links: [{ child: 'b', parent: 'a', kind: 'waits' }] });
  const dto = checkRequestDto(e, { purpose: '인계 점검' });
  const slow = rig(t, { hang: true }); const pr = await slow.decide.prepare(dto);
  const started = Date.now(); const reply = await slow.decide.run(pr.ticket); const ms = Date.now() - started;
  assert.deepEqual(reply, { status: 'manual', reason: 'timeout' }); assert.ok(ms >= 3900 && ms < 6000, 'deadline ' + ms);
  assert.equal(slow.budget.snapshot().unmeteredRequests, 1);
  assert.deepEqual(slow.calibration.entries().map(x => x.fallback), ['timeout']);
});

// ---------------- 4. proposal validation: the subjective model's redesign must fit the live canvas ----------------
test('redesign validation: listed movable aliases only, inside the view, no collisions, no no-ops', () => {
  const desk = { viewport: r(0, 0, 1000, 700), camera: { x: 0, y: 0, zoom: 1 }, obstacles: [r(420, 300, 160, 120)],
    cards: [{ id: 'a', rect: r(600, 60, 260, 160), movable: true, pinned: false, minWidth: 230, minHeight: 150 }, { id: 'b', rect: r(100, 60, 260, 160), movable: true, pinned: false, minWidth: 230, minHeight: 150 },
      { id: 'x', rect: r(100, 480, 260, 160), movable: true, pinned: false }] };
  const e = enumerateCanvasChecks({ cards: [card('a', desk.cards[0].rect), card('b', desk.cards[1].rect)] });
  const ok = p => validateRedesignProposal({ targets: p }, { enumeration: e, desk });
  assert.deepEqual(ok([{ alias: 'A', rect: r(100, 60, 260, 160) }, { alias: 'B', rect: r(400, 60, 260, 160) }]), { ok: true, targets: [{ id: 'a', rect: r(100, 60, 260, 160) }, { id: 'b', rect: r(400, 60, 260, 160) }] });
  for (const [bad, reason] of [[[], 'no-targets'], [[{ alias: 'Z', rect: r(0, 0, 300, 200) }], 'unknown-alias'], [[{ alias: 'A', rect: r(0, 0, 300, 200) }, { alias: 'A', rect: r(0, 300, 300, 200) }], 'duplicate'],
    [[{ alias: 'A', rect: { x: 1, y: 1, width: 'x', height: 3 } }], 'bad-rect'], [[{ alias: 'A', rect: r(0, 0, 100, 100) }], 'too-small'], [[{ alias: 'A', rect: r(900, 60, 260, 160) }], 'out-of-bounds'],
    [[{ alias: 'A', rect: r(300, 150, 260, 160) }], 'collision'], [[{ alias: 'A', rect: r(430, 310, 240, 160) }], 'collision'], [[{ alias: 'A', rect: desk.cards[0].rect }], 'no-change']]) assert.equal(ok(bad).reason, reason, reason);
  assert.equal(validateRedesignProposal({ targets: [{ alias: 'A', rect: r(100, 300, 260, 160) }] }, { enumeration: e, desk: { ...desk, cards: desk.cards.map(c => ({ ...c, movable: false })) } }).reason, 'immovable');
});

// ---------------- 5. three synthetic boards through the whole chain ----------------
const SPEC = (cards, links = []) => ({ cards, others: [{ id: 'O', rect: r(420, 300, 160, 120), z: 1 }], links });
const jc = (id, item, rect, z) => ({ id, item, rect, z, kind: 'note' });
async function session(t, spec, rigOptions) {
  const R = rig(t, rigOptions);
  const W = world({ WorkbenchArrange, http: R.http, grant: () => R.S.grant, spec });
  await R.http('GET', '/decision/status');
  await W.real.arrange().open('proj1', null);
  const ui = W.real.arrange();
  const desk = () => ui.designScene('proj1');
  return { R, W, ui, desk };
}
const stepApply = async (W) => { W.control('apply').fire('click'); for (let i = 0; i < 400 && W.control('apply'); i++) await new Promise(res => setTimeout(res, 5)); assert.equal(!!W.control('apply'), false, 'panel closed after apply'); };

test('board (a) clean flow: nothing enumerated, no judge request, no redesign request', async t => {
  const { R, W, ui, desk } = await session(t, SPEC([jc('vA', 'item-A', r(100, 60, 260, 160), 3), jc('vB', 'item-B', r(400, 60, 260, 160), 4), jc('vC', 'item-C', r(400, 480, 260, 160), 5)],
    [{ child: 'item-B', parent: 'item-A', kind: 'waits' }, { child: 'item-C', parent: 'item-B', kind: 'waits' }]), { script: { u: .1, issues: { reading_order: .99 } } });
  const engineLog = [], s0 = W.seen();
  const out = await runCanvasDesignCheck({ desk: desk(), purpose: '인계 흐름 점검', decide: R.decide, engine: strictEngine(engineLog), review: async () => true });
  assert.deepEqual([out.status, out.requested], ['clean', false]);
  assert.equal(W.control('redesign'), undefined, 'the panel shows no extra choice unless a redesign is on offer');
  assert.equal(R.calls.length, 0); assert.equal(engineLog.length, 0); assert.deepEqual(W.seen(), s0); assert.deepEqual(W.state.canvasLayoutHistory.size(), { undo: 0, redo: 0 });
  // a mild issue is enumerated, the judge says the flow is understandable: ok, still no redesign request
  const mild = await session(t, SPEC([jc('vA', 'item-A', r(100, 60, 260, 160), 3), jc('vB', 'item-B', r(110, 300, 260, 160), 4)], [{ child: 'item-B', parent: 'item-A', kind: 'waits' }]), { script: { u: .96, issues: { misaligned: .1 } } });
  const log2 = [];
  const ok = await runCanvasDesignCheck({ desk: mild.desk(), purpose: '인계 흐름 점검', decide: mild.R.decide, engine: strictEngine(log2), review: async () => true });
  assert.deepEqual([ok.status, ok.requested], ['ok', true]); assert.equal(mild.R.calls.length, 1); assert.equal(log2.length, 0);
});

test('board (b) broken order + scattered relation: findings -> redesign preview -> apply -> Cmd+Z -> redo -> reload', async t => {
  const cards = [jc('vA', 'item-A', r(600, 60, 260, 160), 1), jc('vB', 'item-B', r(100, 60, 260, 160), 2), jc('vC', 'item-C', r(100, 480, 260, 160), 3), jc('vD', 'item-D', r(10, 620, 240, 160), 4)];
  const links = [{ child: 'item-B', parent: 'item-A', kind: 'waits' }, { child: 'item-C', parent: 'item-B', kind: 'waits' }, { child: 'item-D', parent: 'item-A', kind: 'refs' }];
  const { R, W, ui, desk } = await session(t, SPEC(cards, links), { script: { u: .1, issues: { reading_order: .93, related_far: .86 }, where: { value: 'A', p: .9 } } });
  const s0 = W.seen(), engineLog = [], reviews = [];
  const engine = strictEngine(engineLog, request => ({ targets: [{ alias: 'A', rect: r(100, 60, 260, 160) }, { alias: 'B', rect: r(400, 60, 260, 160) }, { alias: 'D', rect: r(100, 260, 240, 160) }] }));
  const out = await runCanvasDesignCheck({ desk: desk(), purpose: '인계 흐름 점검', decide: R.decide, engine, review: async preview => { reviews.push(preview); return true; } });
  assert.equal(out.status, 'preview', JSON.stringify(out));
  // the user saw the exact packet before anything was sent; it holds aliases and closed names only
  assert.equal(reviews.length, 1); const shown = JSON.stringify(reviews[0].packet);
  for (const bad of ['vA', 'item-A', 'proj1', KEY, '"rect"']) assert.ok(!shown.includes(bad), 'review packet is content-free: ' + bad);
  assert.equal(R.calls.length, 1, 'one paid request for the one explicit check');
  // the subjective model got closed findings + alias cards (numbers only), no raw text
  assert.equal(engineLog.length, 1); const req = engineLog[0];
  assert.equal(req.kind, 'canvas_design_findings'); assert.deepEqual(req.findings.map(f => [f.item, f.aliases]), [['reading_order', ['A', 'B']], ['related_far', ['A', 'D']]]); assert.deepEqual(req.where, { alias: 'A', p: .9 });
  assert.deepEqual(req.cards.map(c => [c.alias, c.rect]), [['A', r(600, 60, 260, 160)], ['B', r(100, 60, 260, 160)], ['D', r(10, 620, 240, 160)]]);
  assert.ok(!/title|text|label|vA|item-/.test(JSON.stringify(req)), 'no raw text or ids in the hand-off');
  assert.deepEqual(W.seen(), s0, 'nothing moved yet: preview only');
  // preview on the user's own screen, then Apply through the existing path (authority re-checked at apply time)
  assert.equal(ui.offerRedesign(out.plan), true);
  assert.ok(W.control('redesign')?.checked, 'the redesign is the selected preview'); assert.deepEqual(W.seen(), s0);
  await stepApply(W); const s1 = W.seen();
  assert.deepEqual(s1.cards.map(c => c.slice(0, 3)).slice(0, 4), [['vA', 100, 60], ['vB', 400, 60], ['vC', 100, 480], ['vD', 100, 260]], 'only the three listed cards moved; vC and the obstacle are where they were');
  assert.deepEqual(s1.cards.at(-1), s0.cards.at(-1));
  assert.ok(W.persistedMatchesScreen(), 'saved personal pose == applied layout'); assert.equal(W.fetches.length, 0, 'no shared-board network');
  assert.deepEqual(W.state.canvasLayoutHistory.size(), { undo: 1, redo: 0 });
  W.key(); assert.deepEqual(W.seen(), s0); assert.ok(W.persistedMatchesScreen());
  W.key(true); assert.deepEqual(W.seen(), s1); assert.ok(W.persistedMatchesScreen());
  W.key(); assert.deepEqual(W.seen(), s0);
  const calib = R.calibration.entries(); assert.equal(calib.length, 1); assert.equal(calib[0].attached, true);
  assert.deepEqual(R.budget.snapshot().inputTokens, 11);
});
test('board (b) apply-time authority: a grant revoked between preview and Apply refuses it; a bad proposal never previews', async t => {
  const cards = [jc('vA', 'item-A', r(600, 60, 260, 160), 1), jc('vB', 'item-B', r(100, 60, 260, 160), 2)];
  const spec = SPEC(cards, [{ child: 'item-B', parent: 'item-A', kind: 'waits' }]);
  const script = { u: .1, issues: { reading_order: .93 }, where: { value: 'A', p: .9 } };
  const { R, W, ui, desk } = await session(t, spec, { script }); const s0 = W.seen();
  const good = async () => ({ targets: [{ alias: 'A', rect: r(100, 60, 260, 160) }, { alias: 'B', rect: r(400, 60, 260, 160) }] });
  const out = await runCanvasDesignCheck({ desk: desk(), purpose: '점검', decide: R.decide, engine: good, review: async () => true });
  assert.equal(ui.offerRedesign(out.plan), true);
  R.S.grant = false; W.control('apply').fire('click'); await new Promise(res => setTimeout(res, 60));
  assert.deepEqual(W.seen(), s0, 'revoked: nothing applied'); assert.deepEqual(W.state.canvasLayoutHistory.size(), { undo: 0, redo: 0 });
  const second = await session(t, spec, { script });
  const bad = await runCanvasDesignCheck({ desk: second.desk(), purpose: '점검', decide: second.R.decide, engine: async () => ({ targets: [{ alias: 'A', rect: r(420, 300, 260, 160) }] }), review: async () => true });
  assert.deepEqual([bad.status, bad.reason], ['proposal-rejected', 'collision']); assert.equal(second.ui.offerRedesign({ option: 'nope', targets: [] }), false);
  assert.deepEqual(second.W.seen(), second.W.seen()); assert.equal(second.W.control('redesign')?.checked ?? false, false);
});

test('board (c) ambiguous: the judge is uncertain -> nothing applied, the subjective model is told it was inconclusive', async t => {
  const cards = [jc('vA', 'item-A', r(600, 60, 260, 160), 1), jc('vB', 'item-B', r(100, 60, 260, 160), 2), jc('vC', 'item-C', r(120, 80, 260, 160), 3)];
  const { R, W, ui, desk } = await session(t, SPEC(cards, [{ child: 'item-B', parent: 'item-A', kind: 'waits' }]), { script: { u: .5, issues: { reading_order: .6, overlap: .55 }, where: { value: 'A', p: .5 } } });
  const s0 = W.seen(), engineLog = [];
  const pushy = strictEngine(engineLog, { targets: [{ alias: 'A', rect: r(100, 60, 260, 160) }] }); // an engine that proposes anyway must not cause a preview
  const out = await runCanvasDesignCheck({ desk: desk(), purpose: '인계 흐름 점검', decide: R.decide, engine: pushy, review: async () => true });
  assert.deepEqual([out.status, out.told], ['inconclusive', true]); assert.equal(R.calls.length, 1);
  assert.equal(engineLog.length, 1); assert.equal(engineLog[0].kind, 'canvas_design_inconclusive'); assert.equal(engineLog[0].findings, undefined); assert.match(engineLog[0].note, /Make no layout change/);
  assert.deepEqual(W.seen(), s0); assert.deepEqual(W.state.canvasLayoutHistory.size(), { undo: 0, redo: 0 }); assert.equal(W.control('redesign')?.checked ?? false, false);
  assert.equal(R.calibration.entries()[0].judgments[0].would, 'hold');
});
test('modes: off never judges, advisory records without a hand-off, on hands findings over', async t => {
  const spec = SPEC([jc('vA', 'item-A', r(600, 60, 260, 160), 1), jc('vB', 'item-B', r(100, 60, 260, 160), 2)], [{ child: 'item-B', parent: 'item-A', kind: 'waits' }]);
  const script = { u: .1, issues: { reading_order: .93 }, where: { value: 'A', p: .9 } };
  for (const [mode, expect, calls, engineCalls] of [['off', 'disabled', 0, 0], ['advisory', 'advisory-only', 1, 0], ['on', 'proposal-rejected', 1, 1]]) {
    const s = await session(t, spec, { mode, script }); const engineLog = [];
    const out = await runCanvasDesignCheck({ desk: s.desk(), purpose: '점검', decide: s.R.decide, engine: strictEngine(engineLog, null), review: async () => true });
    assert.equal(out.status, expect, mode); assert.equal(s.R.calls.length, calls, mode); assert.equal(engineLog.length, engineCalls, mode);
  }
});
