import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.deepEqual(focus, { chromeMode: 'briefing', emphasis: 'spotlight', targetIds: ['card-a', 'card-b'], dimOthers: true });
});

test('an outline step rings its windows without dimming the others', () => {
  const focus = BriefingState.briefingStepFocus(begin(1), [available('card-a')]);
  assert.deepEqual(focus, { chromeMode: 'briefing', emphasis: 'outline', targetIds: ['card-a'], dimOthers: false });
});

test('a step with no open window emphasizes nothing and never dims the whole Canvas', () => {
  for (const resolved of [[], undefined, [{ status: 'missing', view: { id: 'card-a' } }, { status: 'available', view: {} }, { status: 'stale' }]]) {
    assert.deepEqual(BriefingState.briefingStepFocus(begin(2), resolved),
      { chromeMode: 'briefing', emphasis: null, targetIds: [], dimOthers: false });
  }
});

test('the whole-briefing overview keeps every briefing window clear, whatever one step asked for', () => {
  const focus = BriefingState.briefingStepFocus(begin(1), [available('card-a'), available('card-c')], { overview: true });
  assert.deepEqual(focus, { chromeMode: 'briefing', emphasis: 'spotlight', targetIds: ['card-a', 'card-c'], dimOthers: true });
});

test('without a briefing there is no chrome mode and nothing to emphasize', () => {
  assert.deepEqual(BriefingState.briefingStepFocus(null, [available('card-a')]),
    { chromeMode: null, emphasis: null, targetIds: [], dimOthers: false });
});

test('a briefing left in the middle offers that step again, by number', () => {
  const memory = new Map();
  assert.equal(BriefingState.briefingResumeOffer(memory, briefing), null);
  BriefingState.rememberBriefingStep(memory, begin(2));
  assert.deepEqual(BriefingState.briefingResumeOffer(memory, briefing), { index: 2, number: 3, stepId: 'three', total: 4 });
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
    resolveLabel: '해결됨으로 표시', resolveTitle: '의견 #3을 해결됨으로 표시', collapsed: false });
  const done = BriefingState.briefingCommentRow({ id: 'c1', seq: 3, text: '확인 필요', resolved: true, included: true }, { targetText: '' });
  assert.deepEqual(done, { number: '#3', title: '의견 #3', target: '이 단계의 설명', state: 'resolved', stateLabel: '해결됨',
    resolveLabel: '다시 열기', resolveTitle: '의견 #3을 다시 열기', collapsed: true });
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
