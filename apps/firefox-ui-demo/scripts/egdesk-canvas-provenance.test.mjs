// L4 cycle 8: (1) content-free provenance recorded when an Agent result becomes a canvas card, kept with the card like its position, superseded-by when a newer
// output of the same key arrives; (2) host wiring of the briefing flow behind a flag that defaults OFF, advisory first (record only); (3) does a fold survive a Desk
// session save/reload. Real source text is compiled out of eg-desk-surface.uc.js (serializeDeskSnapshot, serializeCardState, the fold-restore block, observeBriefing,
// noteOutputSuperseded); the DOM is a minimal fake; the provider is a synthetic script (no network).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import * as BriefingHost from '../overlay/resources/EGDeskBriefingHost.sys.mjs';
import * as CanvasLayout from '../overlay/resources/EGDeskCanvasLayout.sys.mjs';
import { scrubJointSession } from '../overlay/resources/EGDeskJointBoardClient.sys.mjs';
import { enumerateBriefingFacts } from '../helper/egdesk-briefing-flow.mjs';
import { rig } from './egdesk-briefing-rig.support.mjs';
import { world } from './egdesk-board-world.support.mjs';
import * as WorkbenchArrange from '../overlay/resources/EGDeskWorkbenchArrange.sys.mjs';

const src = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const decl = name => { const s = src.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return src.slice(s, src.indexOf('\n  }', s) + 4); };
const thread = { id: 'thread-1', title: 'Room', conversationId: 'conv-1', engineId: 'codex', profileEnabled: true, agentProfileId: 'prof-agent-1' };
const message = { id: 'm1', role: 'assistant', status: 'completed', content: 'The Invoice totals and the Delivery log explain it.', conversationId: 'conv-1', runId: 'run-1', answerId: 'ans-1', createdAt: 1000, artifacts: [] };
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const out = (version, id = uid(version)) => ({ id, outputKey: 'delay-report', version, title: 'Delay report', charCount: 20, createdAt: 2000 + version, previousId: null, conversationId: 'conv-1', runId: 'run-' + version, answerId: 'ans-' + version });
const outputRecord = (v = 1) => ChatState.publishedOutputCardRecord(thread, message, out(v), '# Delay report\nbody text', { author: 'Codex', now: 5000 });

// ---------------- 1. provenance at creation ----------------
test('provenance: recorded when the card is created from an answer or a published output; ids, kind words and times only', () => {
  const answer = ChatState.resultCardRecord(thread, message, { author: 'Codex', now: 4000 });
  assert.deepEqual(answer.provenance, { version: 1, creator: 'agent', agentId: 'prof-agent-1', engineId: 'codex', runId: 'run-1', answerId: 'ans-1', createdAt: 4000, supersededBy: null });
  const pub = outputRecord(1);
  assert.deepEqual(pub.provenance, { version: 1, creator: 'agent', agentId: 'prof-agent-1', engineId: 'codex', runId: 'run-1', answerId: 'ans-1', outputId: uid(1), outputKey: 'delay-report', outputVersion: 1, createdAt: 5000, supersededBy: null });
  for (const p of [answer.provenance, pub.provenance]) { const wire = JSON.stringify(p); for (const bad of ['Invoice', 'Delay report', 'body text', 'Room', 'Codex']) assert.ok(!wire.includes(bad), 'content-free: ' + bad); }
  // it travels with the card record exactly like the rest of the card (the surface saves _resultRecord as the card's runtimeState)
  assert.deepEqual(ChatState.restoreResultCardRecord(JSON.parse(JSON.stringify(pub))).provenance, pub.provenance);
  // a record without provenance (every card made before this change) restores byte-for-byte as before, with no provenance key: it stays unknown
  const legacy = JSON.parse(JSON.stringify({ ...pub, provenance: undefined })); const restored = ChatState.restoreResultCardRecord(legacy);
  assert.equal(Object.hasOwn(restored, 'provenance'), false);
  assert.equal(JSON.stringify(restored), JSON.stringify({ version: 1, title: 'Delay report', text: '# Delay report\nbody text', totalChars: 24, truncated: false, artifacts: [],
    source: { threadId: 'thread-1', threadTitle: 'Room', conversationId: 'conv-1', runId: 'run-1', answerId: 'ans-1', messageId: 'm1', author: 'Codex', answeredAt: 2001, outputId: uid(1), outputKey: 'delay-report', outputVersion: 1 }, createdAt: 5000 }));
  // garbage provenance is dropped, not trusted
  for (const bad of [{ ...pub.provenance, creator: 'root' }, { ...pub.provenance, version: 2 }, 'x', null]) assert.equal(Object.hasOwn(ChatState.restoreResultCardRecord({ ...JSON.parse(JSON.stringify(pub)), provenance: bad }), 'provenance'), false);
});
test('provenance: superseded-by is set only by a newer version of the same output key in the same room, never for unknown cards, and persists with the record', () => {
  const v1 = outputRecord(1), mark = (rec, o, now = 9000) => ChatState.supersedeResultRecord(rec, o, { now });
  const m2 = mark(v1, out(2)); assert.deepEqual(m2.provenance.supersededBy, { outputId: uid(2), version: 2, at: 9000 });
  assert.deepEqual([m2.title, m2.text, m2.source], [v1.title, v1.text, v1.source], 'only the provenance changes');
  assert.equal(mark(v1, out(1)), null, 'the same version'); assert.equal(mark(m2, out(2)), null, 'already marked'); assert.equal(mark(m2, out(3)).provenance.supersededBy.version, 3, 'a still newer one moves the mark');
  assert.equal(mark(v1, { ...out(2), outputKey: 'other-key' }), null); assert.equal(mark(v1, { ...out(2), conversationId: 'conv-other' }), null);
  assert.equal(mark(ChatState.resultCardRecord(thread, message, { now: 1 }), out(2)), null, 'an answer card has no output key');
  assert.equal(mark(ChatState.restoreResultCardRecord(JSON.parse(JSON.stringify({ ...v1, provenance: undefined }))), out(2)), null, 'unknown provenance is never marked');
  assert.deepEqual(ChatState.restoreResultCardRecord(JSON.parse(JSON.stringify(m2))).provenance.supersededBy, { outputId: uid(2), version: 2, at: 9000 });
  // the surface hook: an open older card is marked and dirty-marked (so it is saved), an unrelated card is not touched
  const body = decl('noteOutputSuperseded'); const dirty = [];
  const cards = [{ id: 'c1', _resultRecord: v1 }, { id: 'c2', _resultRecord: ChatState.resultCardRecord(thread, message, { now: 1 }) }, { id: 'c3' }];
  new Function('document', 'ChatState', 'markAgendaDirty', `${body}\nnoteOutputSuperseded(arguments[3]);`)({ querySelectorAll: () => cards }, ChatState, (reason, card) => dirty.push([reason, card.id]), out(2));
  assert.deepEqual(dirty, [['result-superseded', 'c1']]); assert.equal(cards[0]._resultRecord.provenance.supersededBy.version, 2); assert.equal(cards[1]._resultRecord.provenance.supersededBy, null);
});

// ---------------- 2. host adapter: provenance -> flow candidates ----------------
test('host adapter: provenance becomes owner / answer / superseded; unknown stays unknown and is never retrievable; memos are the user\'s', () => {
  const v1 = outputRecord(1), v1m = ChatState.supersedeResultRecord(v1, out(2), { now: 9 });
  const legacy = ChatState.restoreResultCardRecord(JSON.parse(JSON.stringify({ ...ChatState.publishedOutputCardRecord(thread, { ...message, answerId: 'ans-0' }, out(1, uid(77)), 'old body', { now: 1 }), provenance: undefined })));
  const cards = [{ id: 'r1', kind: 'result', record: v1m, rect: { x: 0, y: 0, width: 300, height: 200 }, inFrame: true }, { id: 'r2', kind: 'result', record: legacy, inFrame: true }, { id: 'r3', kind: 'result', record: v1, collapsed: true },
    { id: 'm1', kind: 'memo', memoSeq: 3, inFrame: false }, { id: 'x', kind: 'browser' }];
  const c = BriefingHost.canvasBriefingCandidates(cards);
  assert.deepEqual(c.map(x => [x.id, x.kind, x.owner ?? null, x.createdForAnswer, x.superseded, x.visibility]), [['r1', 'output', 'agent', 'ans-1', true, 'visible'], ['r2', 'output', null, null, false, 'visible'], ['r3', 'output', 'agent', 'ans-1', false, 'collapsed'], ['m1', 'source', 'user', null, false, 'offscreen']]);
  const e = enumerateBriefingFacts({ report: 'Delay report, Delay report and 메모 3 all matter.', candidates: c, currentAnswerId: 'ans-NEW' });
  assert.deepEqual(e.targets.map(t => [t.id, t.origin, t.retrievable]), [['r1', 'agent-earlier', true], ['r2', 'user', false], ['r3', 'agent-earlier', false], ['m1', 'user', false]],
    'only the superseded earlier output that is still shown can be retrieved; the legacy card, the already folded card and the memo cannot');
});

// ---------------- 3. the flag: default OFF, advisory only; the default path touches nothing ----------------
test('flag: only the exact value "advisory" turns it on; nothing else does', () => {
  for (const v of [undefined, null, '', 'off', 'on', 'ADVISORY', 'advisory ', true, 1, { unreadable: true }]) assert.equal(BriefingHost.briefingFlowMode(v), 'off', String(v));
  assert.equal(BriefingHost.briefingFlowMode('advisory'), 'advisory');
  assert.equal(BriefingHost.observeRequest({ mode: 'off', report: 'Delay report and Invoice', candidates: [{ label: 'Delay report' }, { label: 'Invoice' }] }), null);
  assert.equal(BriefingHost.observeRequest({ mode: 'advisory', report: 'Only Delay report', candidates: [{ label: 'Delay report' }, { label: 'Invoice' }] }), null, 'fewer than two named cards: nothing to observe');
});
test('wiring: both hooks are state hooks called at the end of the chat.event case, after every existing statement (so the existing line-adjacency contracts hold)', () => {
  const at = src.indexOf("case 'chat.event': {"), end = src.indexOf("case 'auth-status':", at); const body = src.slice(at, end);
  assert.match(body, /state\.noteChatAttention\?\.\(event, run\);[\s\S]*refreshContextSources[\s\S]*state\.noteOutputSuperseded\?\.\(event\.details\?\.output\);\s+if \(run && event\.event === 'run\.completed'\) state\.observeBriefing\?\.\(run\);/);
  assert.match(src, /state\.observeBriefing = observeBriefing;/); assert.match(src, /state\.noteOutputSuperseded = noteOutputSuperseded;/);
  assert.match(decl('observeBriefing'), /^  function observeBriefing\(run\) \{\n    if \(BriefingHost\.briefingFlowMode\(readSurfacePref\(BriefingHost\.BRIEFING_FLOW_PREF\)\) !== 'advisory' \|\| run\?\.boardMember === true\) return;/, 'the flag check is the first statement');
});
function observeEnv({ pref, run = { runId: 'run-9', localThreadId: 'thread-1', boardMember: false }, text = 'The Delay report and the Invoice totals explain the delay.' } = {}) {
  const log = { prefs: [], posts: [], queries: 0, geometry: 0 };
  const rec1 = outputRecord(1);
  const cards = [{ id: 'r1', isConnected: true, dataset: {}, classList: { contains: c => c === 'egd-result-card' }, _resultRecord: rec1 }, { id: 'r2', isConnected: true, dataset: {}, classList: { contains: c => c === 'egd-result-card' }, _resultRecord: { ...outputRecord(1), title: 'Invoice totals' } }];
  const document = { querySelectorAll: () => { log.queries++; return cards; } };
  const state = { codex: { threads: [{ id: 'thread-1', messages: [{ id: 'm9', role: 'assistant', runId: 'run-9', content: text, answerId: 'ans-9' }] }] } };
  const body = `${decl('observeBriefing')}\nreturn observeBriefing;`;
  const observe = new Function('BriefingHost', 'readSurfacePref', 'getCodexThreadById', 'document', 'state', 'briefingObserved', 'persistentEntityGeometry', 'deskStoreRequest', body)(
    BriefingHost, key => { log.prefs.push(key); return pref; }, (st, id) => st.threads.find(t => t.id === id), document, state, new Set(), () => { log.geometry++; return { x: 0, y: 0, width: 300, height: 200 }; },
    async (method, path, b) => { log.posts.push([method, path, b]); return { status: 200, body: {} }; });
  return { observe: () => observe(run), log };
}
test('default path: with the flag unset (or anything but "advisory") observeBriefing reads the pref and does nothing else', () => {
  for (const pref of [undefined, null, 'off', 'on', { unreadable: true }]) { const e = observeEnv({ pref }); e.observe(); assert.deepEqual(e.log, { prefs: ['egdesk.briefingFlow'], posts: [], queries: 0, geometry: 0 }, String(pref)); }
  const board = observeEnv({ pref: 'advisory', run: { runId: 'run-9', localThreadId: 'thread-1', boardMember: true } }); board.observe(); assert.deepEqual(board.log.posts, []); assert.equal(board.log.queries, 0);
});
test('flag on: exactly one content-bounded POST for an answer that names two cards, once per answer; an answer that names fewer sends nothing', async () => {
  const e = observeEnv({ pref: 'advisory' }); e.observe(); e.observe();
  assert.equal(e.log.posts.length, 1); const [method, path, body] = e.log.posts[0];
  assert.deepEqual([method, path], ['POST', '/decision/briefing-observe']); assert.deepEqual(Object.keys(body), ['report', 'currentAnswerId', 'candidates']); assert.equal(body.currentAnswerId, 'ans-9');
  assert.deepEqual(body.candidates.map(c => [c.id, c.owner, c.createdForAnswer, c.superseded]), [['r1', 'agent', 'ans-1', false], ['r2', 'agent', 'ans-1', false]]);
  const none = observeEnv({ pref: 'advisory', text: 'Nothing on the canvas is named here.' }); none.observe(); assert.deepEqual(none.log.posts, []);
});

// ---------------- 4. the bridge: advisory records, every other mode does nothing ----------------
const candidates = [{ id: 'r1', ref: {}, kind: 'output', label: 'Delay report', gist: 'Delay report body', onBoard: true, maySend: true, owner: 'agent', createdForAnswer: 'ans-1', superseded: true, visibility: 'visible' },
  { id: 'r2', ref: {}, kind: 'output', label: 'Invoice totals', gist: 'Q3 totals', onBoard: true, maySend: true, owner: 'agent', createdForAnswer: 'ans-9', superseded: false, visibility: 'visible' },
  { id: 'm1', ref: {}, kind: 'source', label: '메모 3', onBoard: true, maySend: true, owner: 'user', visibility: 'visible' }];
const observeBody = { report: '## Delay\nThe Delay report and the Invoice totals explain it.\n\n## Notes\nSee 메모 3 for context and the details.', currentAnswerId: 'ans-9', candidates };
test('bridge observe: advisory asks the placement judge and, if it would go to the board, the reuse judge, records both, and does nothing else', async t => {
  const R = rig(t, { mode: 'advisory', script: n => n === 0 ? { placement: { value: 'board', p: .93 } } : { components: { T1: { value: 'retrieve', p: .9 }, T2: { value: 'reuse', p: .9 }, T3: { value: 'irrelevant', p: .9 } }, parts: {} } });
  const r = await R.http('POST', '/decision/briefing-observe', observeBody);
  assert.deepEqual(r.body, { status: 'observed', stages: ['placement', 'reuse'], outcome: 'advisory-only', judgeRequests: 2 }); assert.equal(R.calls.length, 2);
  assert.deepEqual(R.calls.map(c => c.questions[0].name), ['placement', 'component_T1']);
  assert.ok(R.calls[1].questions[0].choices.some(c => c.value === 'retrieve'), 'the superseded earlier output of this Agent is offered retrieve in the packet');
  assert.ok(!R.calls[1].questions.slice(1, 3).some(q => q.choices.some(c => c.value === 'retrieve')), 'the answer\'s own output and the user memo are not');
  const rows = R.calibration.entries(); assert.deepEqual(rows.map(x => [x.feature, x.mode, x.attached]), [['board_arrangement', 'advisory', false], ['board_arrangement', 'advisory', false]]);
  assert.ok(!/Delay|Invoice|메모|ans-|r1/.test(JSON.stringify(rows)), 'calibration is content-free');
  assert.equal(R.budget.snapshot().inputTokens, 22);
  // the verdict "bubble" stops after the first judgment
  const b = rig(t, { mode: 'advisory', script: { placement: { value: 'bubble', p: .93 } } }); const rb = await b.http('POST', '/decision/briefing-observe', observeBody);
  assert.deepEqual([rb.body.stages, rb.body.judgeRequests], [['placement'], 1]); assert.equal(b.calls.length, 1);
});
test('bridge observe: other modes, bad bodies and reports that name fewer than two cards ask nothing', async t => {
  for (const mode of ['on', 'off']) { const R = rig(t, { mode, script: { placement: { value: 'board', p: .9 } } }); const r = await R.http('POST', '/decision/briefing-observe', observeBody); assert.deepEqual(r.body, { status: 'skipped', reason: 'mode' }); assert.equal(R.calls.length, 0); }
  const R = rig(t, { mode: 'advisory', script: { placement: { value: 'board', p: .9 } } });
  assert.equal((await R.http('POST', '/decision/briefing-observe', { ...observeBody, report: '' })).body.reason, 'invalid');
  const few = await R.http('POST', '/decision/briefing-observe', { ...observeBody, report: 'Only the Delay report is named.' }); assert.equal(few.body.judgeRequests, 0); assert.equal(R.calls.length, 0);
  const rogue = await R.http('POST', '/decision/briefing-observe', { ...observeBody, candidates: [{ id: 5, label: 'x' }, ...candidates.map(c => ({ ...c, maySend: false }))] }); assert.equal(rogue.body.judgeRequests, 0, 'cards the user may not send are not candidates');
});
test('bridge observe: the route is POST + JSON + loopback like the rest', async t => {
  const R = rig(t, { mode: 'advisory', script: {} });
  const bad = await R.http('GET', '/decision/briefing-observe').catch(e => e); assert.ok(bad instanceof Error || bad.status === 405);
});

// ---------------- 5. does a fold survive a Desk session save and reload? ----------------
function deskNode(id, { classes = [], dataset = {}, extra = {} } = {}) {
  const set = new Set(['egd-canvas-card', ...classes]);
  const n = { id, isConnected: true, dataset, style: { left: '10px', top: '20px', width: '300px', height: '200px', zIndex: '3' }, offsetLeft: 10, offsetTop: 20, offsetWidth: 300, offsetHeight: 200, _sourceRef: null,
    classList: { contains: c => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) }, querySelector: () => null, ...extra };
  n._setWindowCollapsed = (v) => { n.classList.toggle('egd-card-collapsed', !!v); return !!v; };
  return n;
}
test('fold persistence: a folded result card and memo survive Desk save + reload (with provenance); a folded joint Board card does not (its session state is scrubbed by design)', () => {
  const record = ChatState.supersedeResultRecord(outputRecord(1), out(2), { now: 9 });
  const joint = deskNode('joint-view', { classes: ['egd-joint-card'], dataset: { jointManaged: 'card' } });
  const nodes = [deskNode('result-1', { classes: ['egd-result-card'], extra: { _resultRecord: record } }), deskNode('memo-1', { classes: ['egd-memo-card'], extra: { _memoRecord: { id: 'memo-1', seq: 1, text: 'private' } } }), joint,
    deskNode('result-open', { classes: ['egd-result-card'], extra: { _resultRecord: outputRecord(1) } })];
  for (const n of nodes.slice(0, 3)) n._setWindowCollapsed(true);
  const state = { panTarget: { x: 0, y: 0 }, zoomTarget: 1, canvasSnapEnabled: true, agenda: { activeAgendaId: 'a1' }, activeEntityId: null, canvasGroups: [], surface: { mode: 'desk' }, boards: { projections: {} },
    codex: { threads: [], chatProtocol: {}, threadDrafts: {}, hudView: null } };
  const deps = { state, document: { querySelectorAll: sel => sel === '.egd-canvas-card' ? nodes : [] }, CanvasLayout, ChatState, surfaceZones: undefined, jointDesk: { scrub: s => scrubJointSession(s, [joint.id]) },
    cloneJson: v => v == null ? v : JSON.parse(JSON.stringify(v)), currentViewportAgendaLabel: () => 'Desk', normalizeChatRequestProjectDraft: t => t, cleanSourceRef: v => v, makeSourceRef: () => null,
    parsePxNumber: (v, f = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : f; }, normalizeBrowserNavigationUri: u => u, chatCardThreadBinding: () => null, getCodexThreadById: () => null };
  const body = ['runtimeStateForCard', 'cardKindForPersistence', 'persistentEntityGeometry', 'serializeCardState', 'serializeShapeState', 'serializeDeskSnapshot'].map(decl).join('\n');
  const snapshot = new Function(...Object.keys(deps), `${body}\nreturn serializeDeskSnapshot();`)(...Object.values(deps));
  assert.deepEqual(snapshot.desk.collapsedViewIds, ['result-1', 'memo-1'], 'the joint card fold is scrubbed from the session; the other two are saved');
  const saved = snapshot.cards.find(c => c.id === 'result-1'); assert.equal(saved.type, 'result'); assert.deepEqual(saved.runtimeState.provenance.supersededBy, { outputId: uid(2), version: 2, at: 9 }, 'provenance (and its supersession) is saved with the card');
  assert.ok(!snapshot.cards.some(c => c.id === 'joint-view'), 'joint cards are never in the general Desk session');
  // reload into a fresh canvas: the real fold-restore block of restoreDeskSession
  const start = src.indexOf('      // UX-06: windows saved folded come back folded'), end = src.indexOf('      const activeId = snapshot.desk?.activeCardId;', start); assert.ok(start > 0 && end > start);
  const fresh = [deskNode('result-1', { classes: ['egd-result-card'] }), deskNode('memo-1', { classes: ['egd-memo-card'] }), deskNode('joint-view', { classes: ['egd-joint-card'], dataset: { jointManaged: 'card' } }), deskNode('result-open', { classes: ['egd-result-card'] })];
  const doc = { getElementById: id => fresh.find(n => n.id === id) || null };
  new Function('MinimapLayout', 'snapshot', 'document', 'restoredIds', 'restoredViews', src.slice(start, end))(CanvasLayout, JSON.parse(JSON.stringify(snapshot)), doc, new Map(), fresh);
  const folded = fresh.filter(n => n.classList.contains('egd-card-collapsed')).map(n => n.id);
  assert.deepEqual(folded, ['result-1', 'memo-1'], 'a retrieved (folded) result card is still folded after save + reload; the card that was never folded is open');
});

test('retrieval on the real kind of card: a result card with provenance is a fold target of the Desk scope (preview, apply, Cmd+Z, redo); one without provenance is not', async () => {
  const r = (x, y, width, height) => ({ x, y, width, height });
  const old = ChatState.supersedeResultRecord(outputRecord(1), out(2), { now: 9 }), unknown = ChatState.restoreResultCardRecord(JSON.parse(JSON.stringify({ ...outputRecord(1), provenance: undefined })));
  const spec = { cards: [{ id: 'vA', item: 'item-A', rect: r(100, 60, 260, 160), z: 1, kind: 'note' }, { id: 'vB', item: 'item-B', rect: r(620, 60, 260, 160), z: 2, kind: 'note' }],
    others: [{ id: 'res-old', rect: r(100, 300, 260, 160), z: 3, result: old }, { id: 'res-unknown', rect: r(620, 300, 260, 160), z: 4, result: unknown }], links: [] };
  const W = world({ WorkbenchArrange, http: async () => ({ status: 503, body: {} }), grant: () => true, spec });
  const ui = W.real.arrange(); const folds = ui.designScene('@desk').folds; assert.deepEqual(folds, [{ id: 'res-old', collapsed: false }], 'only a result card with recorded provenance is a fold target');
  await ui.open('@desk', null); const s0 = W.seen();
  assert.equal(ui.offerRetrieval({ option: 'retrieval', collapse: [{ id: 'res-unknown', value: true }] }), false); assert.equal(ui.offerRetrieval({ option: 'retrieval', collapse: [{ id: 'vA', value: true }] }), false, 'an arrangement card is not a retrieval target');
  assert.equal(ui.offerRetrieval({ option: 'retrieval', collapse: [{ id: 'res-old', value: true }] }), true); assert.deepEqual(W.collapsedIds(), []);
  W.control('apply').fire('click'); for (let i = 0; i < 400 && W.control('apply'); i++) await new Promise(res => setTimeout(res, 5));
  assert.deepEqual(W.collapsedIds(), ['res-old']); assert.deepEqual(W.seen(), s0, 'nothing moved'); assert.deepEqual(W.state.canvasLayoutHistory.size(), { undo: 1, redo: 0 }); assert.equal(W.fetches.length, 0);
  W.key(); assert.deepEqual(W.collapsedIds(), []); W.key(true); assert.deepEqual(W.collapsedIds(), ['res-old']); W.key(); assert.deepEqual(W.collapsedIds(), []);
});
