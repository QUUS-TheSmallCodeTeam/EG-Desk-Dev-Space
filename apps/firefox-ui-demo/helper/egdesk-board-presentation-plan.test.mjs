import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareBoardPresentation as prepare,
  readBoardPresentation as read,
} from './egdesk-board-presentation-plan.mjs';
import { validateDecisionRequest } from './egdesk-decision-client.mjs';
const item = (id, kind) => ({
  id,
  approvedKind: kind,
  renderable: true,
  canRead: true,
  movable: true,
  maySendDescriptor: true,
});
const input = {
  mode: 'on',
  requestText: '담당자에게 배송을 인계하기 좋게 보여줘',
  selection: [
    item('PRIVATE_ID_A', '업무 전표'),
    item('PRIVATE_ID_B', '메모'),
    { ...item('PRIVATE_ID_C', '비공개 원가표'), maySendDescriptor: false },
  ],
  focusId: 'PRIVATE_ID_A',
  viewport: { width: 1100, height: 620 },
  binding: 'local-only-version',
  authority: {
    approved: true,
    reviewedCue: '담당자에게 배송을 인계하기 좋게 보여줘',
    revision: 'local-only-version',
  },
};
const answer = (p = 0.91, q = 0.09) => ({
  board_view: {
    type: 'choice',
    choice: '선택한 두 장 나란히 비교',
    confidence: p,
    probabilities: [
      { value: '선택한 두 장 나란히 비교', probability: p },
      { value: '현재 배치 유지', probability: q },
    ],
  },
});
test('off, resize, denial, stale approval or absent cue makes no model request', () => {
  for (const diff of [
    { mode: 'off' },
    { trigger: 'resize' },
    { authority: {} },
    { authority: { ...input.authority, revision: 'old' } },
    { requestText: '' },
    { requestText: '승인 뒤 끼어든 원가 17000' },
  ])
    assert.equal(prepare({ ...input, ...diff }).packet, null);
});
test('explicit feasible control is local even when a Decisions connection is enabled', () => {
  assert.deepEqual(
    prepare({ ...input, selection: input.selection.slice(0, 2), trigger: 'command', explicit: 'pair' }),
    { status: 'local', plan: 'pair', packet: null },
  );
});
test('host builds a valid single choice from approved descriptors, without object ids or restricted neighbours', () => {
  const p = prepare(input);
  validateDecisionRequest(p.packet);
  assert.equal(p.packet.questions.length, 1);
  assert.equal(p.packet.questions[0].type, 'choice');
  assert.doesNotMatch(JSON.stringify(p.packet), /PRIVATE_ID_|비공개 원가표|local-only-version/);
  assert.deepEqual(p.options, ['keep', 'overview', 'focus', 'pair']);
  assert.deepEqual(
    p.packet.input[0].content[1].data.selected.map((c) => c.slot),
    ['A', 'B'],
  );
});
test('no pair for one card, narrow screen or locked member; hidden focus has no candidate', () => {
  for (const diff of [
    { viewport: { width: 640, height: 500 } },
    { selection: [input.selection[0]] },
    { selection: [{ ...input.selection[0], movable: false }, input.selection[1]] },
  ])
    assert.ok(!prepare({ ...input, ...diff }).options.includes('pair'));
  assert.ok(!prepare({ ...input, focusId: 'PRIVATE_ID_C' }).options.includes('focus'));
});
test('advisory cannot preview automatically; on yields an enum preview, not geometry or a write', () => {
  assert.deepEqual(read(prepare(input), answer(), input.binding), {
    status: 'preview',
    preview: 'pair',
    reasoningCalls: 0,
  });
  const r = read(prepare({ ...input, mode: 'advisory' }), answer(), input.binding);
  assert.equal(r.status, 'advisory-only');
  assert.equal(r.preview, null);
});
test('late, tied, missing, injected, invalid, or refused choice stays manual and never starts reasoning', () => {
  const p = prepare(input);
  for (const [rev, a] of [
    ['old', answer()],
    [input.binding, answer(0.51, 0.49)],
    [input.binding, {}],
    [input.binding, { board_view: { type: 'refusal' } }],
    [input.binding, { board_view: { ...answer().board_view, choice: 'grant-admin' } }],
    [input.binding, { board_view: { ...answer().board_view, probabilities: [] } }],
  ])
    assert.deepEqual(read(p, a, rev), { status: 'manual', preview: null, reasoningCalls: 0 });
});

const sampled = { overlap: 'selected', frame: 'inside', clip: 'inside', target: 'reply', reach: 'miss', obscured: true };
const withScenes = (scene = {}, focusItem = {}) => [
  { ...input.selection[0], ...focusItem, scene: { ...sampled, ...scene } },
  { ...input.selection[1], scene: { ...sampled, target: 'title', reach: 'hit', obscured: false } },
  { ...input.selection[2], scene: { blocker: 'PRIVATE_ID_C' } },
];
test('front needs sampled obscuration and viewport/clip access on the movable designated focus only', () => {
  const allowed = ['keep', 'overview', 'focus', 'pair', 'front'];
  for (const scene of [{}, { reach: 'partial', frame: 'partial', clip: 'partial' }, { overlap: 'none' }, { overlap: 'unknown' }]) {
    const p = prepare({ ...input, selection: withScenes(scene) });
    assert.deepEqual(p.options, allowed);
    assert.doesNotMatch(JSON.stringify(p.packet), /PRIVATE_ID_|비공개 원가표|blocker/);
  }
  for (const scene of [{ obscured: false }, { reach: 'hit' }, { reach: 'unknown' }, { frame: 'offscreen' },
    { frame: 'unknown' }, { clip: 'clipped' }, { clip: 'unknown' }]) {
    assert.deepEqual(prepare({ ...input, selection: withScenes(scene) }).options, allowed.slice(0, -1));
  }
  assert.deepEqual(prepare({ ...input, focusId: null, selection: withScenes() }).options, ['keep', 'overview', 'pair']);
  assert.deepEqual(prepare({ ...input, focusId: input.selection[1].id, selection: withScenes() }).options, allowed.slice(0, -1));
  assert.deepEqual(prepare({ ...input, selection: withScenes({}, { movable: false }) }).options, ['keep', 'overview', 'focus']);
  assert.equal(prepare({ ...input, selection: [withScenes()[0], input.selection[1]] }).packet, null);
  assert.equal(prepare({ ...input, selection: withScenes({ obscured: 'true' }) }).packet, null);
});
