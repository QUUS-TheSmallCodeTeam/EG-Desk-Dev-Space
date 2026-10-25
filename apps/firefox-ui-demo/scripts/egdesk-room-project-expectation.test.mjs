import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction } from 'node:vm';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs';

// Actual host helpers and backend validation, without a provider, socket, OS
// picker or room mutation. Full send/lifecycle tests remain in surface-state.
const source = readSurfaceSource();
const declaration = name => {
  const start = source.indexOf(`  function ${name}(`), end = source.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start); return source.slice(start, end + 4);
};
const names = ['normalizeChatRoomProjectDefault', 'snapshotChatRoomProjectExpectation', 'chatRoomProjectExpectation'];
const helpers = compileFunction(names.map(declaration).join('\n') + `\nreturn { ${names.join(',')} };`,
  ['CHAT_ROOM_PROJECT_UNAVAILABLE'])('기본 프로젝트 연결을 확인하세요.');
const snapshot = helpers.snapshotChatRoomProjectExpectation;
const observe = helpers.chatRoomProjectExpectation;
const roomId = 'actual-client-thread-binding';
const none = () => ({ roomId, status: 'none', source: null, boardId: null, projectId: null, rootId: null });
const connected = (kind = 'board') => ({ roomId, status: 'connected', source: kind,
  boardId: kind === 'board' ? 'opaque-board' : null, projectId: 'opaque-project', rootId: 'opaque-root' });
const dto = (kind = 'board') => ({ roomId, status: 'connected', source: kind,
  inheritance: { boardId: 'opaque-board' }, override: kind === 'room' ? { projectId: 'opaque-project' } : null,
  project: { projectId: 'opaque-project', rootId: 'opaque-root', source: kind, status: 'connected',
    title: 'Display only', displayPath: '/display/is-not-authority' } });
const backend = body => CodexChatRuntime.prototype.expectedRoomProject.call({}, body);

test('room expectation: board inheritance, room override and explicit none carry exactly six immutable fields', () => {
  for (const kind of ['board', 'room']) {
    const actual = observe(dto(kind), roomId);
    assert.deepEqual(actual, connected(kind)); assert.equal(Object.isFrozen(actual), true);
    assert.deepEqual(backend({ expectedRoomProject: actual }), actual);
    assert.doesNotMatch(JSON.stringify(actual), /display|title|inheritance|override|cwd/);
  }
  const actual = observe({ roomId, status: 'none', source: null, inheritance: null, override: null, project: null }, roomId);
  assert.deepEqual(actual, none()); assert.equal(Object.isFrozen(actual), true);
  assert.deepEqual(backend({ expectedRoomProject: actual }), actual);
});

test('room expectation: observations and prepared expectations are copied, not shared across awaits', () => {
  const original = dto(), observed = observe(original, roomId);
  original.inheritance.boardId = 'different-board'; original.project.projectId = 'different-project'; original.project.rootId = 'different-root';
  assert.deepEqual(observed, connected());
  const prepared = { ...observed }, wire = snapshot(prepared, roomId);
  Object.assign(prepared, none()); assert.deepEqual(wire, connected()); assert.notEqual(wire, prepared);
  assert.throws(() => { wire.rootId = 'retarget'; }, TypeError);
});

test('room expectation: normalized UI observations can be safely snapshotted again without dropping source validation', () => {
  const value = helpers.normalizeChatRoomProjectDefault(dto(), roomId);
  assert.deepEqual(observe(value, roomId), connected());
  assert.deepEqual(helpers.normalizeChatRoomProjectDefault(value, roomId), value);
  assert.throws(() => observe({ ...dto(), project: { ...dto().project, source: 'room' } }, roomId));
});

test('room expectation: malformed, unavailable and extra-field identities fail closed like the backend', async t => {
  const valid = connected();
  const invalid = [null, false, [], {}, { ...valid, roomId: '' }, { ...valid, rootId: 'x\0y' }, { ...valid, projectId: 'x'.repeat(513) },
    { ...valid, status: 'unavailable' }, { ...valid, status: 'reconnect-required' }, { ...valid, source: 'request' },
    { ...valid, source: 'room' }, { ...valid, boardId: null }, { ...valid, cwd: '/invented' }, { ...valid, displayPath: '/display' },
    { ...none(), rootId: 'must-be-null' }, { ...none(), source: 'board' }];
  for (const [index, value] of invalid.entries()) await t.test(String(index), () => {
    assert.throws(() => snapshot(value, roomId));
    assert.throws(() => backend({ expectedRoomProject: value }), { code: 'INVALID_EXPECTED_ROOM_PROJECT' });
  });
  assert.throws(() => snapshot(valid, 'another-room'));
  assert.throws(() => snapshot({ ...valid, roomId: 'native-conversation-id' }, roomId));
  for (const status of ['unavailable', 'reconnect-required']) assert.throws(() => observe({ ...dto(), status, project: { ...dto().project, status } }, roomId));
});

test('room expectation: explicit request target is mutually exclusive and inheritance never becomes an override', () => {
  assert.throws(() => backend({ expectedRoomProject: connected(), projectTarget: { boardId: 'b', projectId: 'p', rootId: 'r' } }),
    { code: 'INVALID_EXPECTED_ROOM_PROJECT' });
  assert.equal(backend({ projectTarget: { boardId: 'b', projectId: 'p', rootId: 'r' } }), null);
  const inherited = observe(dto(), roomId);
  assert.equal(Object.hasOwn(inherited, 'projectTarget'), false);
  assert.equal(inherited.source, 'board');
});
