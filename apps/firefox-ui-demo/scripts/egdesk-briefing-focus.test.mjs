import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as BriefingState from '../overlay/resources/EGDeskBriefingState.sys.mjs';

const identity = { conversationId: 'conversation-a', runId: 'run-a', answerId: 'answer-a' };
const briefing = { id: 'brief-a', ...identity, steps: [
  { id: 'one', text: '첫 단계', target: { sourceId: 'source-1' } },
  { id: 'two', text: '둘째 단계', targets: [{ sourceId: 'source-1' }, { sourceId: 'source-2' }], emphasis: 'outline' },
  { id: 'three', text: '셋째 단계', target: { sourceId: 'source-3' } },
  { id: 'four', text: '넷째 단계', target: { sourceId: 'source-4' } },
] };
const begin = index => BriefingState.selectBriefingStep(BriefingState.beginBriefing(briefing, { zoom: 1, pan: { x: 0, y: 0 } }), index);
const available = id => ({ status: 'available', view: { id } });

test('the current step names the windows to keep clear and whether the rest recedes', () => {
  const focus = BriefingState.briefingStepFocus(begin(0), [available('card-a'), { status: 'missing' }, available('card-a'), available('card-b')]);
  assert.deepEqual(focus, { chromeMode: 'briefing', emphasis: 'spotlight', targetIds: ['card-a', 'card-b'], dimOthers: true, regions: [], annotationSetIds: [] });
});

test('an outline step rings its windows without dimming the others', () => {
  const focus = BriefingState.briefingStepFocus(begin(1), [available('card-a')]);
  assert.deepEqual(focus, { chromeMode: 'briefing', emphasis: 'outline', targetIds: ['card-a'], dimOthers: false, regions: [], annotationSetIds: [] });
});

test('a step with no open window emphasizes nothing and never dims the whole Canvas', () => {
  for (const resolved of [[], undefined, [{ status: 'missing', view: { id: 'card-a' } }, { status: 'available', view: {} }, { status: 'stale' }]]) {
    assert.deepEqual(BriefingState.briefingStepFocus(begin(2), resolved),
      { chromeMode: 'briefing', emphasis: null, targetIds: [], dimOthers: false, regions: [], annotationSetIds: [] });
  }
});

test('the whole-briefing overview keeps every briefing window clear, whatever one step asked for', () => {
  const focus = BriefingState.briefingStepFocus(begin(1), [available('card-a'), available('card-c')], { overview: true });
  assert.deepEqual(focus, { chromeMode: 'briefing', emphasis: 'spotlight', targetIds: ['card-a', 'card-c'], dimOthers: true, regions: [], annotationSetIds: [] });
});

test('without a briefing there is no chrome mode and nothing to emphasize', () => {
  assert.deepEqual(BriefingState.briefingStepFocus(null, [available('card-a')]),
    { chromeMode: null, emphasis: null, targetIds: [], dimOthers: false, regions: [], annotationSetIds: [] });
});

// CNV-07 Canvas areas (canvasRect targets). Fields added above: regions[] (intentional).
test('a Canvas area keeps the windows it overlaps clear and is outlined; over empty Canvas nothing is dimmed', () => {
  const area = { status: 'available', target: { canvasRect: { x: 0, y: 0, width: 100, height: 100 }, label: ' 왼쪽 묶음 ' }, region: { x: 0, y: 0, width: 100, height: 100 } };
  const cards = [{ id: 'inside', geometry: { x: 50, y: 50, width: 200, height: 200 } }, { id: 'outside', geometry: { x: 300, y: 0, width: 50, height: 50 } },
    { id: 'touching', geometry: { x: 100, y: 0, width: 20, height: 20 } }, { id: 'bad', geometry: { x: 0, y: 0, width: 0, height: 5 } }];
  assert.deepEqual(BriefingState.briefingStepFocus(begin(0), [area], { cards }),
    { chromeMode: 'briefing', emphasis: 'spotlight', targetIds: ['inside'], dimOthers: true, regions: [{ x: 0, y: 0, width: 100, height: 100, label: '왼쪽 묶음' }], annotationSetIds: [] });
  assert.deepEqual(BriefingState.briefingStepFocus(begin(0), [area], { cards: [cards[1]] }),
    { chromeMode: 'briefing', emphasis: 'outline', targetIds: [], dimOthers: false, regions: [{ x: 0, y: 0, width: 100, height: 100, label: '왼쪽 묶음' }], annotationSetIds: [] },
    'an area over empty Canvas never dims every window');
  assert.deepEqual(BriefingState.briefingStepFocus(begin(0), [available('card-a'), area], { cards }).targetIds, ['card-a', 'inside']);
});

test('target kinds: evidence, artifact, Canvas area, and an annotation set that needs the screen annotation layer', () => {
  assert.equal(BriefingState.briefingTargetKind({ sourceId: 's' }), 'source');
  assert.equal(BriefingState.briefingTargetKind({ artifactId: 'a' }), 'artifact');
  assert.equal(BriefingState.briefingTargetKind({ canvasRect: { x: 0, y: 0, width: 1, height: 1 } }), 'canvasRect');
  assert.equal(BriefingState.briefingTargetKind({ annotationSetId: 'set', canvasRect: {} }), 'annotationSet');
  assert.equal(BriefingState.briefingTargetKind('x'), null);
  assert.deepEqual(BriefingState.BRIEFING_TARGET_KINDS, ['source', 'artifact', 'canvasRect', 'annotationSet']);
  const step = { id: 's', text: 'T', targets: [{ canvasRect: { x: -5, y: 2, width: 40, height: 30 } }, { annotationSetId: 'set-1' },
    { canvasRect: { x: 0, y: 0, width: 0, height: 3 } }, { canvasRect: { x: 0, y: 0, width: 3, height: 3 }, sourceId: 'mixed' }] };
  const resolved = BriefingState.resolveBriefingTargets(step);
  assert.deepEqual(resolved.map(item => item.status), ['available', 'unsupported', 'unsupported', 'unsupported']);
  assert.deepEqual(resolved[0].region, { x: -5, y: 2, width: 40, height: 30 });
  // Without the screen's annotation layer (no `annotations` reader) a set stays unsupported.
  assert.match(resolved[1].reason, /표식 묶음 대상은 이 화면에서 지원하지 않습니다/);
  assert.deepEqual(BriefingState.briefingBounds(resolved), { x: -5, y: 2, width: 40, height: 30 }, 'the camera fits Canvas areas too');
  assert.deepEqual(BriefingState.briefingScreenRects(resolved, { zoom: 2, pan: { x: 10, y: 0 } }), [{ x: 0, y: 4, width: 80, height: 60 }]);
  assert.deepEqual(BriefingState.briefingRegionLabel({ canvasRect: {}, label: ' 표 ' }, 0), { name: '표', rangeText: 'Canvas 영역' });
  assert.deepEqual(BriefingState.briefingRegionLabel({ canvasRect: {} }, 2), { name: 'Canvas 영역 3', rangeText: 'Canvas 영역' });
  assert.equal(BriefingState.validBriefing({ id: 'b', steps: [step] }), true);
});

test('CNV-07: an annotation set target resolves through annotationTarget — region for focus and camera fit, missing as 찾을 수 없음', () => {
  const sets = new Map([['ann-1', { setId: 'ann-1', rect: { x: 100, y: 50, width: 200, height: 100 }, summary: ' 로그인  버튼 ' }],
    ['ann-norect', { setId: 'ann-norect', rect: null }]]);
  const asked = [];
  const annotations = { annotationTarget: id => { asked.push(id); return sets.get(id) || null; } };
  const step = { id: 's', text: 'T', targets: [{ annotationSetId: 'ann-1' }, { annotationSetId: 'ann-gone' }, { annotationSetId: 'ann-norect' },
    { annotationSetId: '../bad id' }, { annotationSetId: 'ann-1', label: 'x' }, { canvasRect: { x: 400, y: 0, width: 10, height: 10 } }] };
  const resolved = BriefingState.resolveBriefingTargets(step, { annotations });
  assert.deepEqual(resolved.map(item => item.status), ['available', 'missing', 'missing', 'unsupported', 'unsupported', 'available']);
  assert.deepEqual(asked, ['ann-1', 'ann-gone', 'ann-norect'], 'an id outside the bounded format is never looked up');
  assert.deepEqual(resolved[0].region, { x: 100, y: 50, width: 200, height: 100 });
  assert.equal(resolved[1].annotationMissing, true);
  assert.match(resolved[1].reason, /표식 묶음을 찾을 수 없습니다/);
  assert.deepEqual(BriefingState.briefingBounds(resolved), { x: 100, y: 0, width: 310, height: 150 }, 'the camera fits the set with the other targets');
  assert.deepEqual(BriefingState.briefingAnnotationLabel(step.targets[0], resolved[0], 0), { name: '로그인 버튼', rangeText: '표식 묶음' });
  assert.deepEqual(BriefingState.briefingAnnotationLabel(step.targets[1], resolved[1], 1), { name: '표식 묶음 2', rangeText: '표식 묶음' });
  assert.equal(BriefingState.briefingAnnotationSetIdValid('x'.repeat(129)), false);
  assert.equal(BriefingState.resolveBriefingTargets(step, { annotations: { annotationTarget: () => { throw new Error('boom'); } } })[0].status, 'missing');
  const session = { briefing: { id: 'b', steps: [step] }, index: 0 };
  const regions = BriefingState.briefingMinimapRegions(session, [resolved]);
  assert.deepEqual(regions.map(region => [region.kind ?? 'canvasRect', region.label, region.areaNumber]),
    [['annotationSet', '로그인 버튼', 1], ['canvasRect', 'Canvas 영역 6', 6]], 'annotation sets get minimap marks too');
  assert.equal(regions[0].annotationSetId, 'ann-1');
});

test('CNV-07: the step emphasizes its annotation sets; a card set marks its window, a free set gets the area outline', () => {
  const cardSet = { target: { annotationSetId: 'ann-card' }, status: 'available', annotation: { setId: 'ann-card', cardId: 'card-x', summary: '버튼' },
    region: { x: 0, y: 0, width: 50, height: 50 } };
  const freeSet = { target: { annotationSetId: 'ann-free' }, status: 'available', annotation: { setId: 'ann-free', cardId: null, summary: '정리할 곳' },
    region: { x: 500, y: 0, width: 30, height: 30 } };
  const gone = { target: { annotationSetId: 'ann-gone' }, status: 'missing', annotationMissing: true };
  const focus = BriefingState.briefingStepFocus(begin(0), [cardSet, freeSet, gone]);
  assert.deepEqual(focus.annotationSetIds, ['ann-card', 'ann-free']);
  assert.deepEqual(focus.targetIds, ['card-x']);
  assert.deepEqual(focus.regions, [{ x: 500, y: 0, width: 30, height: 30, label: '정리할 곳' }]);
  assert.deepEqual(BriefingState.briefingStepFocus(null, [cardSet]).annotationSetIds, [], 'no emphasis once the briefing ends');
});

test('a briefing left in the middle offers that step again, by number', () => {
  const memory = new Map();
  assert.equal(BriefingState.briefingResumeOffer(memory, briefing), null);
  BriefingState.rememberBriefingStep(memory, begin(2));
  assert.deepEqual(BriefingState.briefingResumeOffer(memory, briefing), { index: 2, number: 3, stepId: 'three', total: 4 });
});

// The window keeps this memory (`closeAnswerBriefing._stepMemory ||= new Map()` in eg-desk-surface.uc.js) while the module is
// imported into Firefox's shared module global: two JS globals, so the window's Map fails `instanceof Map` in the module. A Map
// from a vm context is the same situation in Node.
test('the step memory the window keeps (a Map from another JS global) is remembered, offered and forgotten', () => {
  const windowMap = vm.runInNewContext('new Map()');
  assert.equal(windowMap instanceof Map, false, 'the Map really comes from another global');
  assert.equal(BriefingState.briefingResumeOffer(windowMap, briefing), null);
  BriefingState.rememberBriefingStep(windowMap, begin(2));
  assert.equal(windowMap.size, 1);
  assert.deepEqual(BriefingState.briefingResumeOffer(windowMap, briefing), { index: 2, number: 3, stepId: 'three', total: 4 });
  BriefingState.forgetBriefingStep(windowMap, briefing);
  assert.equal(windowMap.size, 0);
  assert.equal(BriefingState.briefingResumeOffer(windowMap, briefing), null);
});

test('step memory that is not a Map from any global keeps nothing and offers nothing', () => {
  const lookalike = { size: 1, get: () => ({ index: 2, stepIds: ['one', 'two', 'three', 'four'] }), set() {}, delete() {}, keys: () => [][Symbol.iterator]() };
  for (const memory of [undefined, null, {}, [], lookalike, new Set(), vm.runInNewContext('new Set()'), vm.runInNewContext('new WeakMap()')]) {
    assert.doesNotThrow(() => BriefingState.rememberBriefingStep(memory, begin(2)));
    assert.doesNotThrow(() => BriefingState.forgetBriefingStep(memory, briefing));
    assert.equal(BriefingState.briefingResumeOffer(memory, briefing), null);
  }
});

test('leaving at the first or the last step reopens from the start without asking', () => {
  const memory = new Map();
  BriefingState.rememberBriefingStep(memory, begin(2));
  BriefingState.rememberBriefingStep(memory, begin(0));
  assert.equal(BriefingState.briefingResumeOffer(memory, briefing), null);
  BriefingState.rememberBriefingStep(memory, begin(2));
  BriefingState.rememberBriefingStep(memory, begin(3));
  assert.equal(BriefingState.briefingResumeOffer(memory, briefing), null);
});

test('closing while the resume choice is still unanswered keeps the remembered step', () => {
  const memory = new Map();
  BriefingState.rememberBriefingStep(memory, begin(2));
  BriefingState.rememberBriefingStep(memory, { ...begin(0), resumeOffer: { index: 2, number: 3, stepId: 'three', total: 4 } });
  assert.equal(BriefingState.briefingResumeOffer(memory, briefing)?.index, 2);
});

test('the remembered step belongs to one answer and one unchanged step list', () => {
  const memory = new Map();
  BriefingState.rememberBriefingStep(memory, begin(2));
  assert.equal(BriefingState.briefingResumeOffer(memory, { ...briefing, answerId: 'answer-b' }), null);
  assert.equal(BriefingState.briefingResumeOffer(memory, { ...briefing, id: 'brief-b' }), null);
  const reordered = { ...briefing, steps: [briefing.steps[0], briefing.steps[2], briefing.steps[1], briefing.steps[3]] };
  assert.equal(BriefingState.briefingResumeOffer(memory, reordered), null);
  assert.equal(BriefingState.briefingResumeOffer(memory, { ...briefing, steps: briefing.steps.slice(0, 2) }), null);
  assert.equal(BriefingState.briefingResumeOffer(null, briefing), null);
});

test('forgetting a briefing removes its offer, and the memory stays bounded', () => {
  const memory = new Map();
  BriefingState.rememberBriefingStep(memory, begin(2));
  BriefingState.forgetBriefingStep(memory, briefing);
  assert.equal(BriefingState.briefingResumeOffer(memory, briefing), null);
  for (let index = 0; index < BriefingState.BRIEFING_RESUME_MAX + 5; index++) {
    const other = { ...briefing, id: `brief-${index}` };
    BriefingState.rememberBriefingStep(memory, BriefingState.selectBriefingStep(BriefingState.beginBriefing(other, {}), 1));
  }
  assert.equal(memory.size, BriefingState.BRIEFING_RESUME_MAX);
  assert.equal(BriefingState.briefingResumeOffer(memory, { ...briefing, id: 'brief-0' }), null, 'the oldest entry was dropped');
  assert.equal(BriefingState.briefingResumeOffer(memory, { ...briefing, id: `brief-${BriefingState.BRIEFING_RESUME_MAX + 4}` })?.index, 1);
});

test('a comment row model carries number, state and the actions that are really available', () => {
  const open = BriefingState.briefingCommentRow({ id: 'c1', seq: 3, text: '확인 필요', resolved: false, included: false }, { targetText: '주문 표 · 2–5행' });
  assert.deepEqual(open, { number: '#3', title: '의견 #3', target: '주문 표 · 2–5행', state: 'open', stateLabel: '',
    resolveLabel: '해결됨으로 표시', resolveTitle: '의견 #3을 해결됨으로 표시', collapsed: false, edited: false, editedLabel: '수정됨',
    editLabel: '편집', editTitle: '의견 #3 편집', deleteLabel: '삭제', deleteTitle: '의견 #3 삭제',
    excludeLabel: '초안에서 빼기', excludeTitle: '의견 #3을 Chat 초안에서 빼기' });
  // Edit, delete and take-out-of-draft are offered too (CHAT-05); a rewritten comment says so.
  const done = BriefingState.briefingCommentRow({ id: 'c1', seq: 3, text: '확인 필요', resolved: true, included: true, revision: 2 }, { targetText: '' });
  assert.deepEqual(done, { number: '#3', title: '의견 #3', target: '이 단계의 설명', state: 'resolved', stateLabel: '해결됨',
    resolveLabel: '다시 열기', resolveTitle: '의견 #3을 다시 열기', collapsed: true, edited: true, editedLabel: '수정됨',
    editLabel: '편집', editTitle: '의견 #3 편집', deleteLabel: '삭제', deleteTitle: '의견 #3 삭제',
    excludeLabel: '초안에서 빼기', excludeTitle: '의견 #3을 Chat 초안에서 빼기' });
});

// ----------------------------------------------------- comment resolve / reopen

const commentBriefing = { id: 'brief-multi', conversationId: 'native-a', runId: 'run-a', answerId: 'native-a/run-a', steps: [
  { id: 'both', text: '두 근거', targets: [{ sourceId: 'source-a' }, { sourceId: 'source-b' }] },
  { id: 'only-b', text: '한 근거', target: { sourceId: 'source-b' } }] };
const commentId = '20000000-0000-4000-8000-000000000001';
const savedRow = (extra = {}) => ({ id: commentId, briefingId: 'brief-multi', stepId: 'both', stepIndex: 0,
  seq: 1, text: '의견', resolved: false, sourceIds: ['source-a', 'source-b'],
  conversationId: 'native-a', runId: 'run-a', answerId: 'native-a/run-a', ...extra });
function commentsHarness(transport) {
  let active = true;
  const calls = [], updates = [], record = { text: '', comments: [savedRow()] };
  const controller = BriefingState.createBriefingComments({ session: BriefingState.beginBriefing(commentBriefing, {}), record,
    current: () => active, makeId: () => assert.fail('a state change never creates a save request'),
    request: async (method, body, id) => { calls.push({ method, body, id }); return transport(method, body, id); },
    included: () => false, include: () => assert.fail('a state change never touches the Chat draft'),
    changed: value => updates.push(value) });
  return { controller, calls, updates, record, deactivate: () => { active = false; } };
}

test('resolving a saved comment posts only its new state and keeps the helper receipt', async () => {
  const h = commentsHarness((_method, body) => ({ comment: savedRow({ resolved: body.resolved }) }));
  assert.equal(await h.controller.setResolved(commentId, true), true);
  assert.deepEqual(h.calls, [{ method: 'POST', body: { resolved: true }, id: commentId }]);
  assert.equal(h.controller.view().comments[0].resolved, true);
  assert.equal(h.updates.some(view => view.comments[0].stateBusy === true), true, 'the row shows that the change is in flight');
  assert.equal(h.controller.view().comments[0].stateBusy, undefined);
  assert.equal(await h.controller.setResolved(commentId, false), true);
  assert.equal(h.controller.view().comments[0].resolved, false);
});

test('a failed or mismatched state change leaves the comment as it was and says so on its row', async () => {
  for (const transport of [() => { throw new Error('offline'); }, () => ({ comment: savedRow({ resolved: false }) }),
    () => ({ comment: savedRow({ resolved: true, id: '20000000-0000-4000-8000-000000000002' }) }), () => ({})]) {
    const h = commentsHarness(transport);
    assert.equal(await h.controller.setResolved(commentId, true), false);
    const row = h.controller.view().comments[0];
    assert.equal(row.resolved, false);
    assert.match(row.stateError, /해결됨으로 바꾸지 못했습니다/);
    assert.equal(row.stateBusy, undefined);
  }
});

test('a state change needs a saved comment of this step, a boolean, and one request at a time', async () => {
  let release;
  const h = commentsHarness((_method, body) => new Promise(resolve => { release = () => resolve({ comment: savedRow({ resolved: body.resolved }) }); }));
  assert.equal(await h.controller.setResolved('20000000-0000-4000-8000-000000000009', true), false);
  assert.equal(await h.controller.setResolved(commentId, 'yes'), false);
  const first = h.controller.setResolved(commentId, true);
  assert.equal(await h.controller.setResolved(commentId, true), false, 'a second click while saving is ignored');
  await Promise.resolve(); release();
  assert.equal(await first, true);
  assert.equal(h.calls.length, 1);
});

test('a late receipt after the briefing connection changed does not edit the record', async () => {
  let release;
  const h = commentsHarness((_method, body) => new Promise(resolve => { release = () => resolve({ comment: savedRow({ resolved: body.resolved }) }); }));
  const pending = h.controller.setResolved(commentId, true);
  await Promise.resolve(); h.deactivate(); release();
  assert.equal(await pending, false);
  assert.equal(h.record.comments[0].resolved, false);
  assert.equal(h.record.resolving?.[commentId], undefined, 'the in-flight mark never outlives its request');
});

// ------------------------------------------- comment edit / delete / discard (CHAT-05)

function changeHarness(transport, { inDraft = false } = {}) {
  const calls = [], excluded = [], record = { text: '', comments: [savedRow()] };
  let draft = inDraft;
  const controller = BriefingState.createBriefingComments({ session: BriefingState.beginBriefing(commentBriefing, {}), record,
    current: () => true, makeId: () => '10000000-0000-4000-8000-000000000001',
    request: async (method, body, id, action) => { calls.push({ method, body, id, action }); return transport(method, body, id, action); },
    included: () => draft, include: () => { draft = true; },
    exclude: row => { excluded.push(row.id); draft = false; return true; }, changed: () => {} });
  return { controller, calls, excluded, record };
}

test('editing a saved comment sends its revision, keeps number and step, and takes the old text out of the Chat draft', async () => {
  const h = changeHarness((_m, body) => ({ comment: savedRow({ text: body.text, revision: 2, editedAt: 5 }) }), { inDraft: true });
  assert.equal(await h.controller.editComment(commentId, '  고친 의견  '), true);
  assert.deepEqual(h.calls, [{ method: 'POST', body: { text: '고친 의견', revision: 1 }, id: commentId, action: 'edit' }]);
  const row = h.controller.view().comments[0];
  assert.equal(row.text, '고친 의견');
  assert.equal(row.revision, 2);
  assert.equal(row.seq, 1);
  assert.deepEqual(h.excluded, [commentId], 'the unsent old text is never left to be sent as if current');
  assert.match(h.controller.view().message, /수정 전 의견은 뺐습니다/);
  assert.equal(await h.controller.editComment(commentId, '고친 의견'), true, 'an unchanged text sends nothing');
  assert.equal(h.calls.length, 1);
  assert.equal(await h.controller.editComment(commentId, ' '), false);
  assert.match(h.controller.view().comments[0].stateError, /입력해 주세요/);
  assert.equal(h.calls.length, 1);
});

test('a stale edit or delete keeps the row, says so, and reads the list again', async () => {
  const conflict = Object.assign(new Error('changed'), { code: 'BRIEFING_COMMENT_CONFLICT', status: 409 });
  const h = changeHarness((method, _body, _id, action) => {
    if (method === 'GET') return { briefingId: 'brief-multi', comments: [savedRow({ text: '다른 창에서 고침', revision: 2 })] };
    throw conflict;
  });
  assert.equal(await h.controller.editComment(commentId, '내 수정'), false);
  assert.match(h.controller.view().comments[0].stateError, /다른 곳에서 먼저 바뀌었습니다/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.calls.at(-1).method, 'GET');
  assert.equal(h.controller.view().comments[0].text, '다른 창에서 고침', 'the newer revision from the list wins');
  assert.equal(h.controller.view().comments[0].changeBusy, undefined);
});

test('deleting removes the row only after the receipt, also from the Chat draft, and a later list read cannot bring it back', async () => {
  const h = changeHarness((method, body, id, action) => method === 'GET'
    ? { briefingId: 'brief-multi', comments: [savedRow()] }
    : { deleted: { id, briefingId: 'brief-multi', stepId: 'both', seq: 1, deleted: true, deletedAt: 9 } }, { inDraft: true });
  const pending = h.controller.deleteComment(commentId);
  assert.equal(h.controller.view().comments[0].changeBusy, 'delete', 'the row shows the delete in flight');
  assert.equal(await h.controller.setResolved(commentId, true), false, 'no other change while deleting');
  assert.equal(await pending, true);
  assert.deepEqual(h.calls[0], { method: 'POST', body: { revision: 1 }, id: commentId, action: 'delete' });
  assert.deepEqual(h.controller.view().comments, []);
  assert.deepEqual(h.excluded, [commentId]);
  assert.match(h.controller.view().message, /삭제했습니다\. Chat 초안에서도 뺐습니다/);
  await h.controller.refresh();
  assert.deepEqual(h.controller.view().comments, [], 'a list read that raced the delete does not resurrect it');
});

test('a list read never drops a known comment; one deleted elsewhere leaves when the helper says so for it', async () => {
  const deleted = Object.assign(new Error('gone'), { code: 'BRIEFING_COMMENT_DELETED', status: 404 });
  const h = changeHarness(method => { if (method === 'GET') return { briefingId: 'brief-multi', comments: [] }; throw deleted; });
  await h.controller.refresh();
  assert.equal(h.controller.view().comments.length, 1, 'an empty or partial list is not a delete receipt');
  assert.equal(await h.controller.editComment(commentId, '고침'), false);
  assert.deepEqual(h.controller.view().comments, []);
  assert.match(h.controller.view().message, /이미 삭제되었습니다/);
  const resolve = changeHarness(() => { throw deleted; });
  assert.equal(await resolve.controller.setResolved(commentId, true), false);
  assert.deepEqual(resolve.controller.view().comments, []);
});

test('a refused or unknown delete keeps the row; an already deleted comment is simply gone', async () => {
  const offline = changeHarness(() => { throw new Error('offline'); });
  assert.equal(await offline.controller.deleteComment(commentId), false);
  assert.match(offline.controller.view().comments[0].stateError, /삭제하지 못했습니다/);
  const mismatched = changeHarness((_m, _b, id) => ({ deleted: { id, briefingId: 'brief-multi', seq: 7, deleted: true } }));
  assert.equal(await mismatched.controller.deleteComment(commentId), false, 'a receipt for another number is not this delete');
  assert.equal(mismatched.controller.view().comments.length, 1);
  const gone = changeHarness(() => { throw Object.assign(new Error('gone'), { code: 'BRIEFING_COMMENT_DELETED', status: 404 }); });
  assert.equal(await gone.controller.deleteComment(commentId), true);
  assert.deepEqual(gone.controller.view().comments, []);
});

test('taking a comment out of the Chat draft leaves the saved comment; discarding throws away only the comment being written', async () => {
  const h = changeHarness(() => assert.fail('no request'), { inDraft: true });
  assert.equal(h.controller.exclude(commentId), true);
  assert.equal(h.controller.view().comments.length, 1);
  assert.match(h.controller.view().message, /Chat 초안에서 뺐습니다\. 저장된 의견은 그대로입니다/);
  assert.equal(h.controller.exclude(commentId), false, 'nothing to take out any more');
  assert.equal(h.controller.view().canDiscard, false);
  assert.equal(h.controller.discardDraft(), false);
  h.controller.edit('쓰던 의견');
  assert.equal(h.controller.view().canDiscard, true);
  assert.equal(h.controller.discardDraft(), true);
  assert.equal(h.controller.view().text, '');
  assert.equal(h.record.comments.length, 1, 'saved comments are untouched');
  assert.match(h.controller.view().message, /쓰던 의견을 버렸습니다/);
});

test('discarding an unconfirmed save drops the attempt, never while a save is in flight', async () => {
  let release;
  const h = changeHarness(method => method === 'GET' ? { briefingId: 'brief-multi', comments: [savedRow()] }
    : new Promise((resolve, reject) => { release = () => reject(new Error('lost')); }));
  h.controller.edit('미확정 의견');
  const saving = h.controller.submit('미확정 의견');
  assert.equal(h.controller.discardDraft(), false, 'a save in flight is not thrown away');
  release(); await saving;
  assert.equal(h.controller.view().unconfirmed, true);
  assert.equal(h.controller.discardDraft(), true);
  assert.equal(h.record.attempt, null);
  assert.equal(h.controller.view().unconfirmed, false);
  assert.match(h.controller.view().message, /저장 여부를 확인하지 못한 의견을 버렸습니다/);
});

// ------------------------------------------------------------------- styles

const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const cssBetween = (start, end) => {
  const from = css.indexOf(start), to = css.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} … ${end}`);
  return css.slice(from, to);
};

test('step focus styles: sage ring on the step windows, the rest recede, and nothing takes pointer input', () => {
  const focus = cssBetween('/* CNV-07 step focus.', '.egd-semantic-cluster {');
  assert.doesNotMatch(focus, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, 'approved tokens only');
  assert.doesNotMatch(focus, /pointer-events|display:\s*none|visibility/, 'the other windows and the Dock stay usable');
  assert.match(focus, /\[data-egd-briefing-target="true"\]:not\(\.egd-card-fullscreen\) \{\s*box-shadow: 0 0 0 calc\(3px \/ var\(--egd-camera-zoom, 1\)\) var\(--egd-primary\)/,
    'the ring keeps its on-screen width at any zoom and leaves the selection outline alone');
  assert.match(focus, /\[data-egd-briefing-focus="spotlight"\] \.egd-canvas-card:not\(\[data-egd-briefing-target="true"\]\):not\(\.egd-card-fullscreen, \.egd-entity-active, :hover, :focus-within\) \{\s*opacity: 0\.5;/,
    'a window the reader points at, works in or has selected is never dimmed');
  assert.match(focus, /\[data-egd-chrome-mode="briefing"\] :is\(#egd-dock, #egd-preset-bag\):not\(:hover, :focus-within\) \{ opacity: 0\.55; \}/);
  const wide = focus.slice(focus.indexOf('@media (min-width: 56.0625rem)'), focus.indexOf('@media (prefers-contrast: more)'));
  assert.match(wide, /#egd-dock:not\(:hover, :focus-within\) \{ scale: 0\.9; transform-origin: 0 100%; \}/, 'the centred Dock shrinks in place');
  assert.equal((focus.match(/scale:/g) || []).length, 2, 'only the wide layout shrinks the Dock and the rail');
  const forced = focus.slice(focus.indexOf('@media (forced-colors: active)'));
  assert.equal((forced.match(/opacity: 1;/g) || []).length, 2, 'forced colours never fade a window or the Dock');
});

test('resume and comment card styles use approved tokens only', () => {
  const panel = cssBetween('/* Re-entry: the step last read', '#egd-answer-briefing .egd-briefing-body[hidden]');
  assert.doesNotMatch(panel, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  for (const selector of ['.egd-briefing-resume', '.egd-briefing-comment', '.egd-briefing-comment-head', '.egd-briefing-comment-number',
    '.egd-briefing-comment-target', '.egd-briefing-comment-state', '.egd-briefing-comment-body', '.egd-briefing-comment-status',
    '.egd-briefing-comment-actions', '.egd-briefing-comment[data-state="resolved"]']) {
    assert.ok(panel.includes(`#egd-answer-briefing ${selector}`), selector);
  }
});
