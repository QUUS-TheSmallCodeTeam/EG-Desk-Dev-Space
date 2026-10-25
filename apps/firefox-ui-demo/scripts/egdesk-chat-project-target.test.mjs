import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  normalizeRequestProjectTarget,
  snapshotRequestProjectTarget,
  requestProjectTargetsMatch,
  applyRequestProjectTarget,
  snapshotChatDraft,
  chatDraftMatches,
  buildChatRequest,
  submissionFailureStatus,
} from '../overlay/resources/EGDeskChatState.sys.mjs';

const ids = (suffix = 'a') => ({ boardId: `board-${suffix}`, projectId: `project-${suffix}`, rootId: `root-${suffix}` });
const target = (suffix = 'a') => ({ ...ids(suffix), title: `Project ${suffix}`, displayPath: `/display-only/${suffix}` });
const plainWire = '{"message":"hello","requestId":"request-1","clientThreadId":"room-1","profileEnabled":false}';
const plainThread = () => ({ id: 'room-1' });

test('no request target preserves plain-chat JSON bytes, including old callers', () => {
  assert.equal(JSON.stringify(buildChatRequest(plainThread(), 'hello', 'request-1')), plainWire);
  for (const runtime of [{}, { projectTarget: undefined }, { projectTarget: null }]) {
    const body = buildChatRequest(plainThread(), 'hello', 'request-1', runtime);
    assert.equal(JSON.stringify(body), plainWire);
    assert.equal(Object.hasOwn(body, 'projectTarget'), false);
  }
});

test('existing request fields and insertion order remain byte-compatible', () => {
  const thread = { id: 'room-1', clientBindingId: 'binding-1', conversationId: 'native-1', cwd: '/legacy/thread', profileEnabled: false };
  const runtime = { cwd: '/legacy/override', model: 'chosen-model', effort: 'high', engineId: 'claude', engineProfileId: 'engine-profile',
    contextSnapshotIds: ['snapshot-1', 'snapshot-1'], expectedContextScope: 'scope-1', contextCapabilities: { reader: false },
    contextResolution: { resolutionId: 'resolution-1', chosen: ['source-1'] }, systemPrompt: 'not-enabled' };
  assert.equal(JSON.stringify(buildChatRequest(thread, 'hello', 'request-1', runtime)),
    '{"message":"hello","requestId":"request-1","clientThreadId":"binding-1","profileEnabled":false,"conversationId":"native-1","cwd":"/legacy/override","model":"chosen-model","effort":"high","engineId":"claude","engineProfileId":"engine-profile","contextSnapshotIds":["snapshot-1"],"expectedContextScope":"scope-1","contextCapabilities":{"read":true,"reader":false,"publishBriefing":false},"contextResolution":{"resolutionId":"resolution-1","chosen":["source-1"]}}');
  assert.equal(JSON.stringify(buildChatRequest({ id: 'room-1', profileEnabled: true }, 'hello', 'request-1',
    { agentProfile: 'legacy-profile', systemPrompt: 'legacy-prompt', toolMode: 'legacy-mode' })),
  '{"message":"hello","requestId":"request-1","clientThreadId":"room-1","profileEnabled":true,"agentProfile":"legacy-profile","systemPrompt":"legacy-prompt","toolMode":"legacy-mode"}');
});

test('Board references, active Board, room association and card position never select a request target', () => {
  const thread = { ...plainThread(), boardId: 'board-a', projectId: 'project-a', rootId: 'root-a',
    board: { projectTarget: target() }, activeBoardId: 'board-a', projectTarget: target(),
    inputSources: [{ kind: 'board', boardId: 'board-a', projectTarget: target() }],
    briefingInputs: [{ boardId: 'board-a' }], card: { boardId: 'board-a', x: 50, y: 70 } };
  const runtime = { boardId: 'board-a', activeBoard: { projectTarget: target() }, project: target() };
  assert.equal(JSON.stringify(buildChatRequest(thread, 'hello', 'request-1', runtime)), plainWire);
  assert.equal(snapshotChatDraft(thread, 'hello').requestProjectTarget, null);
});

test('buildChatRequest reads only the submitted runtime target, never the current draft', () => {
  const thread = Object.defineProperty(plainThread(), 'requestProjectTarget', {
    get() { throw new Error('Must not read the live request draft at request-build time'); },
  });
  assert.equal(JSON.stringify(buildChatRequest(thread, 'hello', 'request-1')), plainWire);
  assert.deepEqual(buildChatRequest(thread, 'hello', 'request-1', { projectTarget: target('submitted') }).projectTarget, ids('submitted'));
});

test('an applied target alone is not serialized until its submitted snapshot is passed', () => {
  const thread = applyRequestProjectTarget(plainThread(), target());
  assert.equal(JSON.stringify(buildChatRequest(thread, 'hello', 'request-1')), plainWire);
  const submitted = snapshotChatDraft(thread, 'hello');
  assert.deepEqual(buildChatRequest(thread, submitted.text, 'request-1', { projectTarget: submitted.requestProjectTarget }), {
    message: 'hello', requestId: 'request-1', clientThreadId: 'room-1', profileEnabled: false, projectTarget: ids(),
  });
});

test('the wire contains exactly the three IDs and no presentation, path or authority fields', () => {
  const body = buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: target() });
  assert.deepEqual(Object.keys(body.projectTarget), ['boardId', 'projectId', 'rootId']);
  assert.equal(JSON.stringify(body.projectTarget), '{"boardId":"board-a","projectId":"project-a","rootId":"root-a"}');
  for (const key of ['boardId', 'projectId', 'rootId', 'title', 'displayPath', 'path', 'cwd', 'permissions', 'capabilities']) {
    assert.equal(Object.hasOwn(body, key), false, key);
  }
  assert.equal(JSON.stringify(body).includes('/display-only/'), false);
  assert.equal(JSON.stringify(body).includes('Project a'), false);
});

test('opaque IDs follow the backend contract, not a new ASCII or path syntax policy', () => {
  for (const value of ['한글 Board', ' board:1 ', 'a'.repeat(512), 'symbol/@?#.%', '../opaque-id', 'C:\\opaque\\id', 'line\nbreak']) {
    for (const key of ['boardId', 'projectId', 'rootId']) {
      const selected = { ...ids(), [key]: value };
      assert.deepEqual(normalizeRequestProjectTarget(selected), selected);
      const body = buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: selected });
      assert.equal(body.projectTarget[key], value, 'IDs are preserved, never trimmed, parsed or resolved as paths');
      assert.equal(Object.hasOwn(body, 'cwd'), false);
    }
  }
});

test('missing or malformed IDs are refused rather than becoming a plain request', () => {
  const invalidValues = [undefined, null, '', ' \t\n ', 'a'.repeat(513), 'id\0suffix', 1, false, [], {}];
  for (const key of ['boardId', 'projectId', 'rootId']) {
    const missing = ids();
    delete missing[key];
    for (const selected of [missing, ...invalidValues.map(value => ({ ...ids(), [key]: value }))]) {
      assert.throws(() => normalizeRequestProjectTarget(selected), TypeError);
      assert.throws(() => snapshotRequestProjectTarget(selected), TypeError);
      assert.throws(() => buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: selected }), TypeError);
      assert.equal(requestProjectTargetsMatch(selected, selected), false);
    }
  }
});

test('unknown fields cannot extend target authority, including hidden and symbol fields', () => {
  const foreign = {
    cwd: '/not-authorized', path: '/not-authorized', absolutePath: '/not-authorized', workspaceRoot: '/not-authorized',
    permissions: ['write'], capabilities: { write: true }, allowedRoots: ['/'], root: { path: '/' },
    approvalPolicy: 'never', sandbox: 'none', authority: true, allowExecution: true, command: 'do-not-run',
    toJSON() { throw new Error('Target data must not execute toJSON'); },
  };
  for (const [key, value] of Object.entries(foreign)) {
    const selected = { ...ids(), [key]: value };
    assert.throws(() => normalizeRequestProjectTarget(selected), TypeError, key);
    assert.throws(() => applyRequestProjectTarget(plainThread(), selected), TypeError, key);
    assert.throws(() => buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: selected }), TypeError, key);
  }
  const hidden = Object.defineProperty(ids(), 'permissions', { value: ['write'] });
  const symbol = { ...ids(), [Symbol('authority')]: true };
  const inherited = Object.assign(Object.create({ permissions: ['write'] }), ids());
  const poisoned = JSON.parse('{"boardId":"board-a","projectId":"project-a","rootId":"root-a","__proto__":{"authority":true}}');
  for (const selected of [hidden, symbol, inherited, poisoned]) assert.throws(() => normalizeRequestProjectTarget(selected), TypeError);
});

test('non-record values and accessors are refused without reading executable target fields', () => {
  for (const selected of [false, 0, 'board-a', [], new Date(), () => ids()]) {
    assert.throws(() => normalizeRequestProjectTarget(selected), TypeError);
  }
  let reads = 0;
  for (const key of ['boardId', 'projectId', 'rootId', 'title', 'displayPath']) {
    const selected = Object.defineProperty(ids(), key, { enumerable: true, get() { reads++; return 'do-not-read'; } });
    assert.throws(() => normalizeRequestProjectTarget(selected), TypeError);
    assert.throws(() => snapshotRequestProjectTarget(selected), TypeError);
    assert.equal(requestProjectTargetsMatch(selected, selected), false);
    assert.throws(() => applyRequestProjectTarget(plainThread(), selected), TypeError);
    assert.throws(() => buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: selected }), TypeError);
  }
  assert.equal(reads, 0);
  assert.deepEqual(normalizeRequestProjectTarget(Object.assign(Object.create(null), ids())), ids());
});

test('presentation text uses bounded one-line labels but never changes the opaque IDs', () => {
  const selected = { ...ids(), title: '  Project\0\n\tA\u2028\u007f  ', displayPath: '/display\nonly\t/a' };
  assert.deepEqual(normalizeRequestProjectTarget(selected), { ...ids(), title: 'Project A', displayPath: '/display only /a' });
  const long = normalizeRequestProjectTarget({ ...ids(), title: 't'.repeat(121), displayPath: 'p'.repeat(1001) });
  assert.equal(long.title.length, 120);
  assert.equal(long.displayPath.length, 1000);
  assert.deepEqual(buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: long }).projectTarget, ids());
  for (const key of ['title', 'displayPath']) {
    for (const value of [null, undefined, {}, [], 1, false]) {
      assert.throws(() => normalizeRequestProjectTarget({ ...ids(), [key]: value }), TypeError);
    }
  }
});

test('normalization and snapshots copy rather than mutate their input', () => {
  const selected = Object.freeze(target());
  const normalized = normalizeRequestProjectTarget(selected);
  const snapshot = snapshotRequestProjectTarget(selected);
  assert.deepEqual(normalized, selected);
  assert.deepEqual(snapshot, selected);
  assert.notEqual(normalized, selected);
  assert.notEqual(snapshot, selected);
  assert.equal(Object.isFrozen(snapshot), true);
  normalized.rootId = 'edited-root';
  assert.equal(selected.rootId, 'root-a');
  assert.equal(snapshot.rootId, 'root-a');
  assert.throws(() => { snapshot.rootId = 'edited-root'; }, TypeError);
  for (const empty of [null, undefined]) {
    assert.equal(normalizeRequestProjectTarget(empty), null);
    assert.equal(snapshotRequestProjectTarget(empty), null);
  }
});

test('cross-realm plain records normalize and snapshot without a local Object.prototype identity', () => {
  for (const expression of [
    '({ boardId: "board-a", projectId: "project-a", rootId: "root-a", title: "Project a", displayPath: "/display-only/a" })',
    'JSON.parse(\'{"boardId":"board-a","projectId":"project-a","rootId":"root-a","title":"Project a","displayPath":"/display-only/a"}\')',
    'Object.freeze({ boardId: "board-a", projectId: "project-a", rootId: "root-a", title: "Project a", displayPath: "/display-only/a" })',
    'Object.assign(Object.create(null), { boardId: "board-a", projectId: "project-a", rootId: "root-a", title: "Project a", displayPath: "/display-only/a" })',
  ]) {
    const selected = runInNewContext(expression);
    assert.notEqual(Object.getPrototypeOf(selected), Object.prototype);
    const normalized = normalizeRequestProjectTarget(selected);
    const snapshot = snapshotRequestProjectTarget(selected);
    assert.deepEqual(normalized, target());
    assert.deepEqual(snapshot, target());
    assert.notEqual(normalized, selected);
    assert.notEqual(snapshot, selected);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(requestProjectTargetsMatch(selected, target()), true);
    assert.deepEqual(buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: selected }).projectTarget, ids());
  }
});

test('all imported draft helpers accept window-realm targets and callers', () => {
  const result = runInNewContext(`(() => {
    const selected = { boardId: 'board-a', projectId: 'project-a', rootId: 'root-a', title: 'Project a', displayPath: '/display-only/a' };
    const original = { id: 'room-1', requestProjectTarget: selected };
    const submitted = snapshotChatDraft(original, 'hello', 7);
    const sameBeforeEdit = chatDraftMatches(original, 'hello', 7, submitted);
    const editor = normalizeRequestProjectTarget(selected);
    editor.rootId = 'root-edited';
    const applied = applyRequestProjectTarget(original, editor);
    const changedAfterApply = !chatDraftMatches(applied, 'hello', 7, submitted);
    const sameAfterCancel = requestProjectTargetsMatch(original.requestProjectTarget, submitted.requestProjectTarget);
    const removed = applyRequestProjectTarget(applied, null);
    selected.rootId = 'root-mutated-after-submit';
    const request = buildChatRequest(original, submitted.text, 'request-1', { projectTarget: submitted.requestProjectTarget });
    const plain = buildChatRequest(removed, 'hello', 'request-1', { projectTarget: snapshotChatDraft(removed, 'hello').requestProjectTarget });
    return { submitted, sameBeforeEdit, changedAfterApply, sameAfterCancel, applied, removed, request, plain,
      directSnapshot: snapshotRequestProjectTarget({ boardId: 'board-a', projectId: 'project-a', rootId: 'root-a' }) };
  })()`, { normalizeRequestProjectTarget, snapshotRequestProjectTarget, requestProjectTargetsMatch,
    applyRequestProjectTarget, snapshotChatDraft, chatDraftMatches, buildChatRequest });
  assert.deepEqual(result.submitted.requestProjectTarget, target());
  assert.equal(result.sameBeforeEdit, true);
  assert.equal(result.changedAfterApply, true);
  assert.equal(result.sameAfterCancel, true);
  assert.equal(result.applied.requestProjectTarget.rootId, 'root-edited');
  assert.equal(Object.hasOwn(result.removed, 'requestProjectTarget'), false);
  assert.deepEqual(result.request.projectTarget, ids());
  assert.deepEqual(result.directSnapshot, ids());
  assert.equal(JSON.stringify(result.plain), plainWire);
});

test('cross-realm arrays, accessors, unknown fields and non-record prototypes remain refused', () => {
  const fixtures = runInNewContext(`(() => {
    const ids = { boardId: 'board-a', projectId: 'project-a', rootId: 'root-a' };
    let reads = 0;
    const invalid = [Object.assign([], ids), { ...ids, permissions: ['write'] },
      Object.defineProperty({ ...ids }, 'path', { value: '/not-authorized' }),
      { ...ids, [Symbol('authority')]: true }, Object.assign(new Date(), ids),
      Object.assign(Object.create({ permissions: ['write'] }), ids),
      Object.assign(new (class Target {})(), ids)];
    for (const key of ['boardId', 'projectId', 'rootId', 'title', 'displayPath', Symbol.toStringTag]) {
      invalid.push(Object.defineProperty({ ...ids }, key, { get() { reads++; return 'do-not-read'; } }));
    }
    return { invalid, getReads: () => reads };
  })()`);
  for (const selected of fixtures.invalid) {
    assert.throws(() => normalizeRequestProjectTarget(selected), TypeError);
    assert.throws(() => snapshotRequestProjectTarget(selected), TypeError);
    assert.equal(requestProjectTargetsMatch(selected, selected), false);
    assert.throws(() => applyRequestProjectTarget(plainThread(), selected), TypeError);
    assert.throws(() => snapshotChatDraft({ ...plainThread(), requestProjectTarget: selected }, 'hello'), TypeError);
    assert.throws(() => buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: selected }), TypeError);
  }
  assert.equal(fixtures.getReads(), 0, 'shape validation must not invoke target accessors or Symbol.toStringTag');
});

test('applying returns only a new per-thread draft and does not execute anything', () => {
  let executions = 0;
  const original = Object.freeze({ ...plainThread(), boardId: 'room-location', activeBoardId: 'active-board',
    messages: Object.freeze([]), inputSources: Object.freeze([]), execute() { executions++; } });
  const selected = Object.freeze(target());
  const applied = applyRequestProjectTarget(original, selected);
  assert.notEqual(applied, original);
  assert.deepEqual(applied.requestProjectTarget, selected);
  assert.notEqual(applied.requestProjectTarget, selected);
  assert.equal(Object.hasOwn(original, 'requestProjectTarget'), false);
  assert.deepEqual(Object.keys(applied), [...Object.keys(original), 'requestProjectTarget']);
  for (const key of Object.keys(original)) assert.equal(applied[key], original[key], key);
  assert.equal(executions, 0);
});

test('editing and cancelling a local selection leave the applied draft unchanged', () => {
  const applied = applyRequestProjectTarget(plainThread(), target());
  const submitted = snapshotChatDraft(applied, 'hello');
  const localEditor = normalizeRequestProjectTarget(applied.requestProjectTarget);
  localEditor.boardId = 'board-edited';
  localEditor.title = 'Not applied';
  assert.deepEqual(applied.requestProjectTarget, target());
  assert.equal(chatDraftMatches(applied, 'hello', 0, submitted), true);
  // Cancel discards localEditor; opening the editor again reads a fresh copy.
  assert.deepEqual(normalizeRequestProjectTarget(applied.requestProjectTarget), target());
  const edited = applyRequestProjectTarget(applied, localEditor);
  assert.equal(edited.requestProjectTarget.boardId, 'board-edited');
  assert.deepEqual(applied.requestProjectTarget, target());
  assert.equal(chatDraftMatches(edited, 'hello', 0, submitted), false);
});

test('removing an applied target is immutable and restores plain-chat wire omission', () => {
  const original = Object.freeze({ ...plainThread(), requestProjectTarget: Object.freeze(target()), cwd: '/legacy/thread' });
  for (const removal of [null, undefined]) {
    const cleared = applyRequestProjectTarget(original, removal);
    assert.equal(Object.hasOwn(cleared, 'requestProjectTarget'), false);
    assert.deepEqual(original.requestProjectTarget, target());
    assert.equal(cleared.cwd, original.cwd);
    const submitted = snapshotChatDraft(cleared, 'hello');
    assert.equal(submitted.requestProjectTarget, null);
    assert.equal(Object.hasOwn(buildChatRequest(cleared, 'hello', 'request-1', { projectTarget: submitted.requestProjectTarget }), 'projectTarget'), false);
  }
});

test('room drafts and target copies remain independent even when they share the original selection object', () => {
  const selected = target();
  const roomA = applyRequestProjectTarget({ id: 'room-a' }, selected);
  const roomB = applyRequestProjectTarget({ id: 'room-b' }, selected);
  const submittedB = snapshotChatDraft(roomB, 'hello');
  roomA.requestProjectTarget.rootId = 'root-a-edited';
  assert.deepEqual(roomB.requestProjectTarget, target());
  assert.deepEqual(selected, target());
  const clearedA = applyRequestProjectTarget(roomA, null);
  assert.equal(snapshotChatDraft(clearedA, 'hello').requestProjectTarget, null);
  assert.equal(chatDraftMatches(roomB, 'hello', 0, submittedB), true);
  assert.equal(buildChatRequest(roomA, 'hello', 'a', { projectTarget: snapshotChatDraft(roomA, 'hello').requestProjectTarget }).projectTarget.rootId, 'root-a-edited');
  assert.deepEqual(buildChatRequest(roomB, 'hello', 'b', { projectTarget: submittedB.requestProjectTarget }).projectTarget, ids());
});

test('the submitted draft includes a detached target together with existing draft inputs', () => {
  const thread = { ...plainThread(), requestProjectTarget: target(), inputSources: [{ ref: 'source-1' }], briefingInputs: [{ id: 'briefing-1' }] };
  const submitted = snapshotChatDraft(thread, ' hello ', 7);
  assert.deepEqual(submitted, { text: ' hello ', revision: 7, inputSources: [{ ref: 'source-1' }], briefingInputs: [{ id: 'briefing-1' }], requestProjectTarget: target() });
  thread.requestProjectTarget.title = 'Changed';
  thread.inputSources[0].ref = 'changed-source';
  thread.briefingInputs[0].id = 'changed-briefing';
  assert.deepEqual(submitted.requestProjectTarget, target());
  assert.deepEqual(submitted.inputSources, [{ ref: 'source-1' }]);
  assert.deepEqual(submitted.briefingInputs, [{ id: 'briefing-1' }]);
});

test('changes to any target ID or presentation field during submission prevent draft clearing', () => {
  const thread = applyRequestProjectTarget(plainThread(), target());
  const submitted = snapshotChatDraft(thread, 'hello', 3);
  assert.equal(chatDraftMatches(thread, 'hello', 3, submitted), true);
  for (const key of ['boardId', 'projectId', 'rootId', 'title', 'displayPath']) {
    const edited = applyRequestProjectTarget(thread, { ...target(), [key]: `changed-${key}` });
    assert.equal(chatDraftMatches(edited, 'hello', 3, submitted), false, key);
  }
  assert.equal(chatDraftMatches(applyRequestProjectTarget(thread, null), 'hello', 3, submitted), false);
  assert.equal(chatDraftMatches(thread, 'hello', 4, submitted), false, 'A to B to A still needs the existing draft revision fence');
});

test('target comparison is order independent and fails closed on malformed values', () => {
  assert.equal(requestProjectTargetsMatch(target(), { displayPath: '/display-only/a', title: 'Project a', rootId: 'root-a', projectId: 'project-a', boardId: 'board-a' }), true);
  assert.equal(requestProjectTargetsMatch(null, undefined), true);
  assert.equal(requestProjectTargetsMatch(target(), ids()), false, 'presentation edits are part of the applied draft');
  assert.equal(requestProjectTargetsMatch({}, {}), false);
  assert.equal(requestProjectTargetsMatch({ ...ids(), permissions: ['write'] }, null), false);
});

test('legacy draft snapshots without a target still compare correctly', () => {
  const submitted = { text: 'hello', revision: 0, inputSources: [], briefingInputs: [] };
  assert.equal(chatDraftMatches(plainThread(), 'hello', 0, submitted), true);
  assert.equal(chatDraftMatches(applyRequestProjectTarget(plainThread(), target()), 'hello', 0, submitted), false);
});

test('existing text, revision, attachment and briefing fences remain effective', () => {
  const thread = { ...plainThread(), requestProjectTarget: target(), inputSources: ['source-1'], briefingInputs: ['briefing-1'] };
  const submitted = snapshotChatDraft(thread, 'hello', 2);
  assert.equal(chatDraftMatches(thread, 'changed text', 2, submitted), false);
  assert.equal(chatDraftMatches(thread, 'hello', 3, submitted), false);
  assert.equal(chatDraftMatches({ ...thread, inputSources: [] }, 'hello', 2, submitted), false);
  assert.equal(chatDraftMatches({ ...thread, briefingInputs: [] }, 'hello', 2, submitted), false);
});

test('an invalid JSON-restored target is retained for reselect/remove, never treated as none', () => {
  const restored = JSON.parse('{"id":"room-1","requestProjectTarget":{"boardId":"board-a","projectId":"project-a","cwd":"/untrusted"}}');
  const before = JSON.stringify(restored);
  assert.throws(() => normalizeRequestProjectTarget(restored.requestProjectTarget), TypeError);
  assert.throws(() => snapshotChatDraft(restored, 'hello'), TypeError);
  assert.throws(() => buildChatRequest(restored, 'hello', 'request-1', { projectTarget: restored.requestProjectTarget }), TypeError);
  assert.equal(chatDraftMatches(restored, 'hello', 0, snapshotChatDraft(plainThread(), 'hello')), false);
  assert.equal(JSON.stringify(restored), before, 'the invalid persisted value remains available for UI correction');
  const corrected = applyRequestProjectTarget(restored, target('corrected'));
  assert.deepEqual(corrected.requestProjectTarget, target('corrected'));
  const removed = applyRequestProjectTarget(restored, null);
  assert.equal(snapshotChatDraft(removed, 'hello').requestProjectTarget, null);
  assert.equal(JSON.stringify(restored), before);
});

test('a malformed target introduced while a request is in flight cannot clear the draft', () => {
  const thread = applyRequestProjectTarget(plainThread(), target());
  const submitted = snapshotChatDraft(thread, 'hello');
  thread.requestProjectTarget = { ...ids(), authority: 'write' };
  assert.equal(chatDraftMatches(thread, 'hello', 0, submitted), false);
  assert.throws(() => snapshotChatDraft(thread, 'hello'), TypeError);
  assert.deepEqual(buildChatRequest(thread, 'hello', 'request-1', { projectTarget: submitted.requestProjectTarget }).projectTarget, ids());
});

test('async edits cannot replace the selected target frozen at submission', async () => {
  const thread = applyRequestProjectTarget(plainThread(), target());
  const selected = thread.requestProjectTarget;
  const submitted = snapshotChatDraft(thread, 'hello');
  await Promise.resolve().then(() => {
    selected.rootId = 'root-mutated';
    thread.requestProjectTarget = target('later');
  });
  const body = buildChatRequest(thread, submitted.text, 'request-1', { projectTarget: submitted.requestProjectTarget });
  assert.deepEqual(body.projectTarget, ids());
  assert.deepEqual(submitted.requestProjectTarget, target());
  assert.equal(chatDraftMatches(thread, 'hello', 0, submitted), false);
});

test('a plain submission cannot acquire a target applied during an await', async () => {
  let thread = plainThread();
  const submitted = snapshotChatDraft(thread, 'hello');
  await Promise.resolve().then(() => { thread = applyRequestProjectTarget(thread, target('later')); });
  const body = buildChatRequest(thread, submitted.text, 'request-1', { projectTarget: submitted.requestProjectTarget });
  assert.equal(JSON.stringify(body), plainWire);
  assert.equal(chatDraftMatches(thread, 'hello', 0, submitted), false);
});

test('the request body also owns its target copy independently of runtime and submission objects', () => {
  const runtime = { projectTarget: target() };
  const body = buildChatRequest(plainThread(), 'hello', 'request-1', runtime);
  runtime.projectTarget.rootId = 'changed-after-build';
  assert.deepEqual(body.projectTarget, ids());
  const submitted = snapshotChatDraft(applyRequestProjectTarget(plainThread(), target()), 'hello');
  const submittedBody = buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: submitted.requestProjectTarget });
  submittedBody.projectTarget.rootId = 'changed-body';
  assert.equal(submitted.requestProjectTarget.rootId, 'root-a');
});

test('legacy runtime.cwd and thread.cwd behavior is neither removed nor broadened by targets', () => {
  for (const selected of [undefined, target()]) {
    for (const cwd of ['/legacy/thread', '', null, false, 0, 'relative-directory', [], {}]) {
      const thread = { ...plainThread(), cwd };
      assert.deepEqual(buildChatRequest(thread, 'hello', 'request-1', { projectTarget: selected }).cwd, cwd);
      assert.deepEqual(buildChatRequest(thread, 'hello', 'request-1', { cwd, projectTarget: selected }).cwd, cwd);
    }
    assert.equal(buildChatRequest({ ...plainThread(), cwd: '/legacy/thread' }, 'hello', 'request-1',
      { cwd: '/legacy/runtime', projectTarget: selected }).cwd, '/legacy/runtime');
    assert.equal(Object.hasOwn(buildChatRequest(plainThread(), 'hello', 'request-1', { projectTarget: selected }), 'cwd'), false);
  }
});

test('a backend binding mismatch remains a definite refusal, not an unconfirmed submission', () => {
  assert.equal(submissionFailureStatus({ code: 'PROJECT_TARGET_CHANGED', status: 409, accepted: false, dispatchStatus: 'rejected' }), 'failed');
});
