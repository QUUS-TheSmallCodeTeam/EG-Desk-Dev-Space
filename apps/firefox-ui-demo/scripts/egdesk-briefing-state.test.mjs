// 1-O: multi-evidence Answer Briefing, dim-layer geometry, minimap step marks
// and saved step comments (overlay/resources/EGDeskBriefingState.sys.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Briefing from '../overlay/resources/EGDeskBriefingState.sys.mjs';
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs';
import { BRIEFING_COMMENT_MAX, BRIEFING_MAX_TARGETS } from '../helper/egdesk-context-runtime.mjs';

const reference = (sourceId, hash = `hash-${sourceId}`) => ({ sourceId, hash, localSource: { sourceRef: { viewId: `live-${sourceId}` } } });
const requestId = '10000000-0000-4000-8000-000000000001';
const evidenceView = (ref, geometry, extra = {}) => ({ id: `card-${ref.sourceId}`, sourceId: ref.sourceId, hash: ref.hash,
  evidenceKey: InputContext.inputEvidenceKey(ref), sourceMatches: true, revisionMatches: true, geometry, ...extra });

// The shape egdesk_publish_briefing_multi stores: target is targets[0].
const multiBriefing = () => {
  const a = { sourceId: 'source-a', hash: 'hash-source-a' }, b = { sourceId: 'source-b', hash: 'hash-source-b' };
  return { id: 'brief-multi', title: '두 자료 비교', steps: [
    { id: 'both', text: '두 자료가 같은 합계를 말합니다', target: a, targets: [a, b], emphasis: 'spotlight', fallback: '두 자료 열기' },
    { id: 'only-b', text: 'B만 다릅니다', target: b, targets: [b], emphasis: 'outline', fallback: 'B 열기' },
    { id: 'old', text: '예전 한 개 대상 단계', target: { sourceId: 'source-c' }, fallback: 'C 열기' },
  ] };
};

test('helper and screen agree on the target and comment limits', () => {
  assert.equal(Briefing.BRIEFING_MAX_TARGETS, BRIEFING_MAX_TARGETS);
  assert.equal(Briefing.BRIEFING_COMMENT_MAX, BRIEFING_COMMENT_MAX);
});

test('a step reads targets[] when present and its single target otherwise', () => {
  const [both, onlyB, old] = multiBriefing().steps;
  assert.deepEqual(Briefing.briefingStepTargets(both).map(target => target.sourceId), ['source-a', 'source-b']);
  assert.deepEqual(Briefing.briefingStepTargets(onlyB).map(target => target.sourceId), ['source-b']);
  assert.deepEqual(Briefing.briefingStepTargets(old), [{ sourceId: 'source-c' }]);
  assert.deepEqual(Briefing.briefingStepTargets({}), []);
  assert.equal(Briefing.briefingEmphasis(both), 'spotlight');
  assert.equal(Briefing.briefingEmphasis(onlyB), 'outline');
  assert.equal(Briefing.briefingEmphasis(old), 'spotlight', 'spotlight is the default');
});

test('validBriefing accepts multi-target and older steps, and refuses malformed target lists', () => {
  assert.equal(Briefing.validBriefing(multiBriefing()), true);
  const withStep = step => ({ id: 'b', steps: [{ id: 's', text: 'T', ...step }] });
  assert.equal(Briefing.validBriefing(withStep({ target: { sourceId: 'x' } })), true);
  assert.equal(Briefing.validBriefing(withStep({ targets: [] })), false);
  assert.equal(Briefing.validBriefing(withStep({ targets: Array.from({ length: 7 }, (_, i) => ({ sourceId: `s${i}` })) })), false);
  assert.equal(Briefing.validBriefing(withStep({ targets: ['not-an-object'] })), false);
  assert.equal(Briefing.validBriefing(withStep({ target: { sourceId: 'x' }, emphasis: 'blink' })), false);
  assert.equal(Briefing.validBriefing(withStep({})), false);
});

test('every target of the current step resolves on its own; missing evidence never borrows another view', () => {
  const a = reference('source-a'), b = reference('source-b');
  const viewA = evidenceView(a, { x: 0, y: 0, width: 100, height: 80 });
  const step = multiBriefing().steps[0];
  const partial = Briefing.resolveBriefingTargets(step, { references: [a, b], views: [viewA] });
  assert.deepEqual(partial.map(item => item.status), ['available', 'missing']);
  const viewB = evidenceView(b, { x: 300, y: 200, width: 50, height: 40 });
  const full = Briefing.resolveBriefingTargets(step, { references: [a, b], views: [viewA, viewB] });
  assert.deepEqual(full.map(item => item.status), ['available', 'available']);
  assert.deepEqual(Briefing.briefingBounds(full), { x: 0, y: 0, width: 350, height: 240 });
  const stale = Briefing.resolveBriefingTargets(step, { references: [a, b], views: [viewA, { ...viewB, revisionMatches: false }] });
  assert.equal(stale[1].status, 'stale');
});

test('evidence identity distinguishes an omitted end from an explicit default without changing explicit keys', () => {
  const ref = reference('source-a');
  const key = range => InputContext.inputEvidenceKey({ ...ref, presentationRange: range });
  assert.equal(key({ startLine: 500, endLine: 699 }), JSON.stringify([ref.sourceId, ref.hash, 500, 699]));
  assert.notEqual(key({ startLine: 500 }), key({ startLine: 500, endLine: 699 }));
  assert.notEqual(key(undefined), key({ startLine: 1, endLine: 200 }));
  assert.equal(key(undefined), key({}));
  assert.equal(key({ startLine: 500 }), key({ startLine: 500, endLine: undefined }));
  assert.equal(key({ startLine: 500, endLine: null }), key({ startLine: 500, endLine: 699 }),
    'the reader treats a present null end as an explicit normalized end');
  assert.notEqual(key({ startLine: 1, endLine: 4 }), key({ startLine: 5, endLine: 8 }));
  assert.notEqual(key({ startLine: 1, endLine: 4 }), InputContext.inputEvidenceKey({
    ...reference('source-b'), presentationRange: { startLine: 1, endLine: 4 },
  }));
  for (const range of [{ startLine: 0 }, { startLine: 9, endLine: 8 }, { startLine: 1, endLine: 501 }, { page: 1 }]) {
    assert.throws(() => key(range), /지원하지 않는 캡처 행 범위/);
  }
  const persisted = JSON.parse(JSON.stringify({ reference: { ...ref, presentationRange: { startLine: 500 } } }));
  assert.equal(InputContext.inputEvidenceKey(persisted.reference), key({ startLine: 500 }),
    'a restored reference recomputes its own intent, rather than migrating an ambiguous old key');
});

test('short captures do not satisfy a distinct explicit range in either multi-target order', () => {
  const ref = reference('source-a'), geometry = { x: 0, y: 0, width: 100, height: 80 };
  const open = { sourceId: ref.sourceId, range: { startLine: 500 } };
  const explicit = { sourceId: ref.sourceId, range: { startLine: 500, endLine: 699 } };
  const page = { capture: { sourceId: ref.sourceId, hash: ref.hash, capturedAt: 1 },
    source: { role: 'source', hash: ref.hash, rangeHash: 'range-500-610', mime: 'text/plain',
      text: Array.from({ length: 111 }, (_, index) => `fixed line ${500 + index}`).join('\n'),
      range: { startLine: 500, endLine: 610, totalLines: 610 } } };
  const ranged = target => ({ ...ref, presentationRange: target.range });
  const shortSnapshot = InputContext.inputEvidenceSnapshot(page, ranged(open));
  assert.deepEqual(shortSnapshot.range, { startLine: 500, endLine: 610, totalLines: 610 });
  assert.equal(shortSnapshot.content.text.split('\n').length, 111);
  assert.throws(() => InputContext.inputEvidenceSnapshot(page, ranged(explicit)), /요청 행 범위/);
  assert.throws(() => InputContext.inputEvidenceSnapshot(page, ranged({ ...open, range: { startLine: 500, endLine: null } })), /요청 행 범위/);
  const fullPage = { ...page, source: { ...page.source, rangeHash: 'range-500-699',
    text: Array.from({ length: 200 }, (_, index) => `fixed line ${500 + index}`).join('\n'),
    range: { startLine: 500, endLine: 699, totalLines: 700 } } };
  assert.equal(InputContext.inputEvidenceSnapshot(fullPage, ranged(explicit)).content.text.split('\n').length, 200);
  for (const targets of [[open, explicit, open], [explicit, open, explicit]]) {
    const keys = targets.map(target => InputContext.inputEvidenceKey(ranged(target)));
    assert.equal(new Set(keys).size, 2, 'only exact duplicate requests share a materialization');
    const seen = new Set(), attempts = [], views = [];
    for (const target of targets) {
      const requested = ranged(target), key = InputContext.inputEvidenceKey(requested);
      if (seen.has(key)) continue;
      seen.add(key); attempts.push(target);
      try {
        InputContext.inputEvidenceSnapshot(page, requested);
        views.push(evidenceView(requested, geometry));
      } catch (error) { assert.match(error.message, /요청 행 범위/); }
    }
    assert.deepEqual(attempts, targets.slice(0, 2), 'a failed first explicit read must not suppress the later open read');
    assert.equal(views.length, 1);
    const step = { id: 's', text: 'T', targets };
    const resolved = Briefing.resolveBriefingTargets(step, { references: [ref], views });
    assert.deepEqual(resolved.map(item => item.status), targets.map(target => target === open ? 'available' : 'missing'));
    assert.ok(resolved.filter(item => item.status === 'available').every(item => item.view === views[0]));
  }
  const explicitlyLoaded = evidenceView(ranged(explicit), geometry);
  const reversed = Briefing.resolveBriefingTargets({ id: 's', text: 'T', targets: [open, explicit] },
    { references: [ref], views: [explicitlyLoaded] });
  assert.deepEqual(reversed.map(item => item.status), ['missing', 'available'],
    'an explicit view is not substituted for an omitted-end request either');
});

test('exact duplicate evidence ranges deduplicate while separate sources and ranges retain distinct keys', () => {
  const a = reference('source-a'), b = reference('source-b');
  const a1 = { ...a, presentationRange: { startLine: 1, endLine: 4 } };
  const a5 = { ...a, presentationRange: { startLine: 5, endLine: 8 } };
  const b1 = { ...b, presentationRange: { startLine: 1, endLine: 4 } };
  const keys = [a1, a5, b1, { ...a1 }, { ...a5 }, { ...b1 }].map(InputContext.inputEvidenceKey);
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(keys.slice(0, 3), keys.slice(3));
});

test('Canvas geometry maps to viewport pixels with the layer camera', () => {
  const a = reference('source-a');
  const resolved = Briefing.resolveBriefingTargets({ id: 's', text: 'T', target: { sourceId: 'source-a' } },
    { references: [a], views: [evidenceView(a, { x: 10, y: 20, width: 100, height: 50 })] });
  assert.deepEqual(Briefing.briefingScreenRects(resolved, { pan: { x: 5, y: -10 }, zoom: 2 }), [{ x: 25, y: 30, width: 200, height: 100 }]);
  assert.deepEqual(Briefing.briefingScreenRects(resolved, { pan: { x: 0, y: 0 }, zoom: 0 }), []);
  assert.deepEqual(Briefing.briefingScreenRects([{ status: 'missing' }], { pan: { x: 0, y: 0 }, zoom: 1 }), []);
});

test('dim-layer cutouts are padded, clipped to the viewport and merged where they overlap', () => {
  const viewport = { width: 400, height: 300 };
  assert.deepEqual(Briefing.briefingStageHoles([{ x: 10, y: 20, width: 100, height: 50 }], viewport, { padding: 8 }),
    [{ x: 2, y: 12, width: 116, height: 66 }]);
  // Two overlapping targets become one cutout (evenodd would otherwise re-dim the overlap).
  assert.deepEqual(Briefing.briefingStageHoles([{ x: 10, y: 10, width: 100, height: 100 }, { x: 60, y: 60, width: 100, height: 100 }], viewport, { padding: 0 }),
    [{ x: 10, y: 10, width: 150, height: 150 }]);
  // A chain A–B–C where only neighbours overlap still collapses into one.
  assert.equal(Briefing.briefingStageHoles([{ x: 0, y: 0, width: 50, height: 50 }, { x: 200, y: 0, width: 50, height: 50 }, { x: 40, y: 0, width: 170, height: 20 }], viewport, { padding: 0 }).length, 1);
  // Separate targets stay separate, ordered top-to-bottom.
  assert.deepEqual(Briefing.briefingStageHoles([{ x: 200, y: 200, width: 20, height: 20 }, { x: 10, y: 10, width: 20, height: 20 }], viewport, { padding: 0 }).map(hole => hole.y), [10, 200]);
  assert.deepEqual(Briefing.briefingStageHoles([{ x: 390, y: 290, width: 50, height: 50 }], viewport, { padding: 0 }), [{ x: 390, y: 290, width: 10, height: 10 }]);
  assert.deepEqual(Briefing.briefingStageHoles([{ x: 900, y: 900, width: 50, height: 50 }], viewport), [], 'off-screen evidence makes no cutout');
  assert.deepEqual(Briefing.briefingStageHoles([{ x: 0, y: 0, width: 10, height: 10 }], { width: 0, height: 300 }), []);
  assert.deepEqual(Briefing.briefingStageHoles([{ x: 0, y: 0, width: NaN, height: 10 }], viewport), []);
});

test('the dim layer is one evenodd path: the viewport plus one rounded cutout per target', () => {
  const viewport = { width: 400, height: 300 };
  assert.equal(Briefing.briefingStagePath([], viewport), null, 'nothing visible means no dimming at all');
  assert.equal(Briefing.briefingStagePath([{ x: 10, y: 20, width: 100, height: 50 }], viewport, { padding: 0, radius: 0 }),
    'M400,0L0,0L0,300L400,300ZM10,20h100v50h-100z');
  // Same numbers as driver.js generateStageSvgPathString for padding 8 / radius 8.
  assert.equal(Briefing.briefingStagePath([{ x: 10, y: 20, width: 100, height: 50 }], viewport, { padding: 8, radius: 8 }),
    'M400,0L0,0L0,300L400,300ZM10,12h100a8,8 0 0 1 8,8v50a8,8 0 0 1 -8,8h-100a8,8 0 0 1 -8,-8v-50a8,8 0 0 1 8,-8z');
  const two = Briefing.briefingStagePath([{ x: 10, y: 10, width: 40, height: 40 }, { x: 200, y: 100, width: 40, height: 40 }], viewport);
  assert.equal(two.match(/M/g).length, 3);
  // A tiny target clamps the corner radius so the cutout never folds over.
  assert.match(Briefing.briefingStagePath([{ x: 50, y: 50, width: 4, height: 4 }], viewport, { padding: 0, radius: 20 }), /a2,2 /);
  // An offset viewport (the canvas area below a toolbar) frames its own rectangle.
  assert.match(Briefing.briefingStagePath([{ x: 60, y: 60, width: 10, height: 10 }], { x: 50, y: 40, width: 100, height: 80 }, { padding: 0, radius: 0 }),
    /^M150,40L50,40L50,120L150,120Z/);
});

test('step marks give the main view and the minimap the same numbers, places and evidence state', () => {
  const a = reference('source-a'), b = reference('source-b');
  const viewA = evidenceView(a, { x: 0, y: 0, width: 100, height: 80 }), viewB = evidenceView(b, { x: 300, y: 200, width: 50, height: 40 });
  const session = Briefing.selectBriefingStep(Briefing.beginBriefing(multiBriefing(), { pan: { x: 0, y: 0 }, zoom: 1 }), 1);
  const resolvedSteps = session.briefing.steps.map(step => Briefing.resolveBriefingTargets(step, { references: [a, b], views: [viewA] }));
  const marks = Briefing.briefingStepMarks(session, resolvedSteps);
  assert.deepEqual(marks.map(mark => [mark.number, mark.current, mark.status, mark.targetCount, mark.availableCount]),
    [[1, false, 'partial', 2, 1], [2, true, 'missing', 1, 0], [3, false, 'missing', 1, 0]]);
  assert.deepEqual(marks[0].bounds, viewA.geometry);
  assert.equal(marks[1].bounds, null);
  assert.equal(marks[1].emphasis, 'outline');
  const complete = Briefing.briefingStepMarks(session, session.briefing.steps.map(step => Briefing.resolveBriefingTargets(step, { references: [a, b], views: [viewA, viewB] })));
  assert.equal(complete[0].status, 'available');
  assert.ok(Array.isArray(marks), 'marks are a list, never keyed by a model-written step ID');
});

test('the screen enters its briefing chrome mode only while a briefing is open', () => {
  assert.equal(Briefing.briefingChromeMode(null), null);
  assert.equal(Briefing.briefingChromeMode(Briefing.beginBriefing(multiBriefing(), {})), 'briefing');
});

test('a step comment is saved first and the draft then points at it by number', () => {
  const session = Briefing.beginBriefing(multiBriefing(), { pan: { x: 0, y: 0 }, zoom: 1 });
  assert.deepEqual(Briefing.briefingCommentRequest(session, '  합계를 비교해줘  ', requestId), { briefingId: 'brief-multi', body: { stepId: 'both', text: '합계를 비교해줘', clientRequestId: requestId } });
  assert.throws(() => Briefing.briefingCommentRequest(session, '   '), /단계 의견/);
  assert.throws(() => Briefing.briefingCommentRequest(session, 'x'.repeat(2001)), /2000자/);
  assert.throws(() => Briefing.briefingCommentRequest(session, 'valid'), /요청 ID/);
  const saved = { id: 'comment-1', briefingId: 'brief-multi', stepId: 'both', seq: 3, text: '합계를 비교해줘', resolved: false };
  const resolved = [{ reference: { sourceId: 'source-a' }, status: 'available' }, { reference: { sourceId: 'source-b' }, status: 'missing' }];
  const draft = Briefing.briefingCommentDraft(session, '합계를 비교해줘', resolved, saved);
  assert.equal(draft.commentId, 'comment-1');
  assert.equal(draft.commentSeq, 3);
  assert.match(draft.text, /^\[두 자료 비교 · 1단계 · 의견 #3\]\n의견: 합계를 비교해줘$/);
  assert.ok(!draft.text.includes('두 자료가 같은 합계를 말합니다'), 'the draft no longer copies the step text');
  assert.deepEqual(draft.contextSnapshotIds, ['source-a', 'source-b']);
  assert.throws(() => Briefing.briefingCommentDraft(session, 'x', resolved, { ...saved, stepId: 'only-b' }), /저장된 단계 의견/);
  assert.throws(() => Briefing.briefingCommentDraft(session, 'x', resolved, { ...saved, briefingId: 'other' }), /저장된 단계 의견/);
  // Without a saved record the older inline form is unchanged.
  const inline = Briefing.briefingCommentDraft(session, 'Compare this', resolved);
  assert.match(inline.text, /의견: Compare this/);
  assert.equal(inline.commentId, undefined);
  assert.equal(inline.autoSend, undefined);
});

test('a draft refers to each saved comment once', () => {
  const draft = { commentId: 'c1', commentSeq: 1, briefingId: 'b', stepId: 's', text: 'ignored' };
  const once = Briefing.addBriefingCommentRef([], draft);
  assert.deepEqual(once, [{ commentId: 'c1', commentSeq: 1, briefingId: 'b', stepId: 's' }]);
  assert.equal(Briefing.addBriefingCommentRef(once, draft).length, 1);
  assert.equal(Briefing.addBriefingCommentRef(once, { ...draft, commentId: 'c2', commentSeq: 2 }).length, 2);
  assert.deepEqual(Briefing.addBriefingCommentRef(once, { text: 'inline only' }), once);
});

test('saved comments load in number order and become per-step badge counts', () => {
  const session = Briefing.beginBriefing(multiBriefing(), {});
  const response = { briefingId: 'brief-multi', comments: [
    { id: 'c2', briefingId: 'brief-multi', stepId: 'both', seq: 2, text: 'second', resolved: true },
    { id: 'c1', briefingId: 'brief-multi', stepId: 'both', seq: 1, text: 'first', resolved: false },
    { id: 'c3', briefingId: 'brief-multi', stepId: 'only-b', seq: 3, text: 'third', resolved: false },
    { id: 'c1', briefingId: 'brief-multi', stepId: 'both', seq: 1, text: 'duplicate', resolved: false },
    { id: 'x', briefingId: 'another-briefing', stepId: 'both', seq: 9, text: 'other', resolved: false },
    { id: 'bad', briefingId: 'brief-multi', stepId: 'both', seq: 0, text: 'bad seq', resolved: false },
  ] };
  const comments = Briefing.normalizeBriefingComments(response, 'brief-multi');
  assert.deepEqual(comments.map(item => item.id), ['c1', 'c2', 'c3']);
  assert.equal(comments[0].text, 'first');
  const summary = Briefing.briefingCommentSummary(session, comments);
  assert.ok(Array.isArray(summary));
  assert.deepEqual(summary.map(row => [row.stepId, row.number, row.open, row.resolved, row.latestSeq]),
    [['both', 1, 1, 1, 2], ['only-b', 2, 1, 0, 3], ['old', 3, 0, 0, null]]);
  assert.deepEqual(Briefing.normalizeBriefingComments(null, 'brief-multi'), []);
});

const savedSession = () => Briefing.beginBriefing({ ...multiBriefing(), conversationId: 'native-a', runId: 'run-a', answerId: 'native-a/run-a' }, {});
const savedRow = (extra = {}) => ({ id: '20000000-0000-4000-8000-000000000001', briefingId: 'brief-multi', stepId: 'both', stepIndex: 0,
  seq: 1, text: '의견', resolved: false, sourceIds: ['source-a', 'source-b'], clientRequestId: requestId,
  conversationId: 'native-a', runId: 'run-a', answerId: 'native-a/run-a', ...extra });
const savedList = (...comments) => ({ briefingId: 'brief-multi', comments });
const deferComment = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function commentsHarness({ record = {}, transport, includeError = null } = {}) {
  let active = true, ids = 0;
  const calls = [], inserted = [], updates = [];
  const controller = Briefing.createBriefingComments({ session: savedSession(), record,
    current: () => active, makeId: () => { ids++; return requestId; },
    request: async (method, body) => { calls.push({ method, body }); return transport ? transport(method, body) : method === 'GET' ? savedList() : { comment: savedRow() }; },
    included: row => inserted.some(item => item.id === row.id),
    include: row => { if (includeError) throw includeError; inserted.push(row); }, changed: value => updates.push(value),
  });
  return { controller, calls, inserted, updates, record, idCount: () => ids, deactivate: () => { active = false; controller.dispose(); } };
}

test('saved comment receipt validates every original identity and the exact target set before draft use', () => {
  const session = savedSession(), body = Briefing.briefingCommentRequest(session, '의견', requestId).body;
  assert.deepEqual(Briefing.verifiedBriefingComment(savedRow(), session, body), savedRow());
  for (const bad of [{ id: 'not-an-id' }, { seq: 0 }, { seq: 1.5 }, { briefingId: 'other' }, { stepId: 'only-b' }, { stepIndex: 1 },
    { conversationId: 'other' }, { runId: 'other' }, { answerId: 'other' }, { sourceIds: ['other'] }, { sourceIds: ['source-a'] },
    { sourceIds: ['source-a', 'source-a'] }, { clientRequestId: undefined }, { clientRequestId: '30000000-0000-4000-8000-000000000001' }, { text: '' }]) {
    assert.throws(() => Briefing.verifiedBriefingComment(savedRow(bad), session, body), /연결/, JSON.stringify(bad));
  }
  const legacy = savedRow(); delete legacy.clientRequestId;
  assert.equal(Briefing.verifiedBriefingComment(legacy, session).id, legacy.id, 'legacy record can be read, not matched to an unknown save');
  assert.throws(() => Briefing.verifiedBriefingComment(legacy, session, body));
});

test('saved comments GET distinguishes verified empty, unavailable, wrong envelope and ambiguous identity', () => {
  const session = savedSession();
  assert.deepEqual(Briefing.verifiedBriefingComments(savedList(), session), []);
  for (const value of [null, {}, [], { briefingId: 'other', comments: [] }, savedList(savedRow(), savedRow()),
    savedList(savedRow(), savedRow({ id: '20000000-0000-4000-8000-000000000002', seq: 2 })),
    savedList(savedRow(), savedRow({ id: '20000000-0000-4000-8000-000000000002', clientRequestId: undefined }))]) {
    assert.throws(() => Briefing.verifiedBriefingComments(value, session));
  }
});

test('saved comments controller creates a UUID only for save, blocks pending clicks and inserts a receipt once', async () => {
  const pending = deferComment(), h = commentsHarness({ transport: method => method === 'POST' ? pending.promise : savedList() });
  h.controller.edit('의견'); await h.controller.refresh(); assert.equal(h.idCount(), 0);
  const saving = h.controller.submit('의견');
  assert.equal(h.controller.view().pending, true); assert.equal(h.controller.view().clientRequestId, requestId);
  await h.controller.submit('의견'); assert.equal(h.calls.filter(item => item.method === 'POST').length, 1);
  pending.resolve({ comment: savedRow() }); await saving;
  assert.equal(h.controller.view().phase, 'included'); assert.equal(h.inserted.length, 1);
  await h.controller.submit('의견'); h.controller.include(savedRow().id);
  assert.equal(h.calls.filter(item => item.method === 'POST').length, 1); assert.equal(h.inserted.length, 1); assert.equal(h.idCount(), 1);
});

test('lost POST recovery uses GET exact UUID only, never a same-text comment or a second POST', async () => {
  let found = false;
  const h = commentsHarness({ transport: method => {
    if (method === 'POST') throw new Error('response lost');
    const other = savedRow({ id: '20000000-0000-4000-8000-000000000002', seq: 2, clientRequestId: '30000000-0000-4000-8000-000000000001' });
    return found ? savedList(savedRow(), other) : savedList(other);
  } });
  await h.controller.submit('의견');
  assert.equal(h.controller.view().phase, 'unknown'); assert.equal(h.inserted.length, 0);
  await h.controller.submit('new text');
  assert.deepEqual(h.calls.map(item => item.method), ['POST', 'GET', 'GET']); assert.equal(h.idCount(), 1);
  found = true; await h.controller.refresh();
  assert.equal(h.controller.view().phase, 'saved'); assert.equal(h.inserted.length, 0, 'recovery does not silently modify a draft');
  h.controller.include(savedRow().id); assert.equal(h.inserted.length, 1);
});

test('saved comment draft failure is separately retryable without posting again', async () => {
  const record = {}, first = commentsHarness({ record, includeError: new Error('draft busy') });
  await first.controller.submit('의견');
  assert.equal(first.controller.view().phase, 'saved'); assert.match(first.controller.view().comments[0].draftError, /#1 저장됐지만 초안에 넣지 못함/);
  first.deactivate();
  const reopened = commentsHarness({ record, transport: () => savedList(savedRow()) });
  await reopened.controller.refresh(); reopened.controller.include(savedRow().id);
  assert.deepEqual(reopened.calls.map(item => item.method), ['GET']); assert.equal(reopened.inserted.length, 1);
  assert.equal(reopened.controller.view().comments[0].draftError, null);
});

test('definitive rejection is failed, unknown post-commit authority/transport is unconfirmed, GET failure is not empty', async () => {
  for (const error of [Object.assign(new Error('invalid'), { status: 400 }), Object.assign(new Error('conflict'), { status: 409, code: 'BRIEFING_COMMENT_CONFLICT' })]) {
    const h = commentsHarness({ transport: () => { throw error; } }); await h.controller.submit('의견');
    assert.equal(h.controller.view().phase, 'failed'); assert.deepEqual(h.calls.map(item => item.method), ['POST']);
  }
  const h = commentsHarness({ transport: () => { throw Object.assign(new Error('changed after write'), { status: 403, code: 'ACCOUNT_CHANGED' }); } });
  await h.controller.submit('의견');
  assert.equal(h.controller.view().unconfirmed, true); assert.equal(h.controller.view().listState, 'failed');
  assert.equal(h.inserted.length, 0); assert.deepEqual(h.calls.map(item => item.method), ['POST', 'GET']);
});

test('late save resolve/reject cannot mutate retained receipts or UI after dispose; reopen retains UUID for GET', async () => {
  for (const reject of [false, true]) {
    const pending = deferComment(), record = {}, h = commentsHarness({ record, transport: () => pending.promise });
    const saving = h.controller.submit('의견'); h.deactivate();
    const before = JSON.stringify(record), updates = h.updates.length;
    if (reject) pending.reject(new Error('late')); else pending.resolve({ comment: savedRow() });
    await saving;
    assert.equal(JSON.stringify(record), before); assert.equal(h.updates.length, updates); assert.equal(h.inserted.length, 0);
    const fresh = commentsHarness({ record, transport: () => savedList(savedRow()) }); await fresh.controller.refresh();
    assert.equal(fresh.controller.view().phase, 'saved'); assert.equal(fresh.controller.view().clientRequestId, requestId);
    assert.deepEqual(fresh.calls.map(item => item.method), ['GET']); assert.equal(fresh.idCount(), 0);
  }
});

test('late initial GET cannot erase a successfully saved receipt and failed GET retains readable history', async () => {
  const pending = deferComment(), h = commentsHarness({ transport: method => method === 'GET' ? pending.promise : { comment: savedRow() } });
  const reading = h.controller.refresh(); await h.controller.submit('의견'); pending.resolve(savedList()); await reading;
  assert.equal(h.controller.view().comments.length, 1); assert.equal(h.controller.view().comments[0].included, true);
  const failed = commentsHarness({ record: h.record, transport: () => { throw new Error('offline'); } }); await failed.controller.refresh();
  assert.equal(failed.controller.view().comments.length, 1); assert.equal(failed.controller.view().listState, 'failed');
});

test('manual retry replays the captured request, saves only and leaves the edited new attempt for an explicit primary action', async () => {
  let posts = 0;
  const h = commentsHarness({ transport: (method, body) => {
    if (method === 'GET') throw new Error('GET offline');
    posts++; if (posts === 1) throw new Error('response lost');
    return { comment: savedRow({ text: body.text, clientRequestId: body.clientRequestId }) };
  } });
  h.controller.edit('의견'); await h.controller.submit('의견'); const captured = JSON.stringify(h.record.attempt.body);
  h.controller.edit('현재 다른 입력'); assert.equal(h.controller.view().originalText, '의견'); assert.equal(h.controller.view().canRetry, true);
  await h.controller.retry();
  assert.equal(JSON.stringify(h.calls.filter(call => call.method === 'POST')[1].body), captured);
  assert.equal(h.controller.view().text, '현재 다른 입력'); assert.equal(h.controller.view().phase, 'saved'); assert.equal(h.inserted.length, 0);
  assert.equal(h.controller.view().originalText, null); assert.equal(h.idCount(), 1);
  h.controller.include(savedRow().id); assert.equal(h.inserted.length, 1); assert.equal(posts, 2);
});

test('a retained retry never borrows a newly presented step target even under the same briefing/step IDs', async () => {
  const h = commentsHarness({ transport: () => { throw new Error('offline'); } });
  await h.controller.submit('의견'); h.deactivate(); const before = JSON.stringify(h.record.attempt.body);
  const session = savedSession(); session.briefing.steps[0].targets[0].hash = 'replacement-hash';
  let requests = 0;
  const changed = Briefing.createBriefingComments({ session, record: h.record, current: () => true,
    makeId: () => { throw new Error('never allocate a new retry ID'); }, request: () => { requests++; },
    include: () => { throw new Error('no draft write'); }, included: () => false });
  assert.equal(changed.view().canRetry, false); assert.match(changed.view().message, /원래 단계·근거/);
  await changed.retry(); assert.equal(requests, 0); assert.equal(JSON.stringify(h.record.attempt.body), before);
});
