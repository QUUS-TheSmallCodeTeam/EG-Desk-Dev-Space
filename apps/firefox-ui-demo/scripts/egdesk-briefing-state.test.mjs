// 1-O: multi-evidence Answer Briefing, dim-layer geometry, minimap step marks
// and saved step comments (overlay/resources/EGDeskBriefingState.sys.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Briefing from '../overlay/resources/EGDeskBriefingState.sys.mjs';
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs';
import { BRIEFING_COMMENT_MAX, BRIEFING_MAX_TARGETS } from '../helper/egdesk-context-runtime.mjs';

const reference = (sourceId, hash = `hash-${sourceId}`) => ({ sourceId, hash, localSource: { sourceRef: { viewId: `live-${sourceId}` } } });
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
  assert.deepEqual(Briefing.briefingCommentRequest(session, '  합계를 비교해줘  '), { briefingId: 'brief-multi', body: { stepId: 'both', text: '합계를 비교해줘' } });
  assert.throws(() => Briefing.briefingCommentRequest(session, '   '), /단계 의견/);
  assert.throws(() => Briefing.briefingCommentRequest(session, 'x'.repeat(2001)), /2000자/);
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
