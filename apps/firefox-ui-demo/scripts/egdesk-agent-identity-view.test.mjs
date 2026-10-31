import test from 'node:test';
import assert from 'node:assert/strict';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import {
  AVATAR_IMAGE_MAX_BYTES, agentAvatarImageSource, agentAvatarView, agentWorkingRows, cardAgentIdentityView,
  isAvatarAssetId, messageAuthorAvatar, resolveCardAgentIdentity,
} from '../overlay/resources/EGDeskAgentIdentityView.sys.mjs';

const ASSET = `img-${'a'.repeat(64)}`;
const PHOTO = { kind: 'image', value: 'V', color: '#252a26', assetId: ASSET };
const EMOJI = { kind: 'emoji', value: '🦉', color: '#a9c5a9' };
const base64Of = bytes => Buffer.alloc(bytes, 1).toString('base64');

test('agentAvatarView: a photo keeps its initial and tone and names the asset; emoji/initial/none behave as before', () => {
  assert.deepEqual(agentAvatarView(PHOTO, '검증 담당'), { kind: 'image', text: 'V', tone: 4, saved: true, assetId: ASSET });
  assert.deepEqual(agentAvatarView(EMOJI, '검증 담당'), { kind: 'emoji', text: '🦉', tone: 1, saved: true, assetId: null });
  assert.deepEqual(agentAvatarView(null, '검증 담당'), { kind: 'initial', text: '검', tone: 0, saved: false, assetId: null });
  // A photo reference with a malformed asset id is not a photo: the name's letter stands in.
  assert.deepEqual(agentAvatarView({ ...PHOTO, assetId: 'img-short' }, 'Codex'), { kind: 'initial', text: 'C', tone: 0, saved: false, assetId: null });
  // ChatState keeps the public shape exact for emoji/initial (no assetId key leaks in).
  assert.deepEqual(ChatState.profileAvatarView(EMOJI, 'x'), { kind: 'emoji', text: '🦉', tone: 1, saved: true });
  assert.equal(isAvatarAssetId(ASSET), true);
  assert.equal(isAvatarAssetId(`IMG-${'a'.repeat(64)}`), false);
});

test('agentAvatarImageSource: only the asked-for PNG/JPEG/WebP within 512KB becomes a data URL', () => {
  const png = base64Of(1200);
  assert.equal(agentAvatarImageSource({ assetId: ASSET, mediaType: 'image/png', imageBase64: png }, ASSET), `data:image/png;base64,${png}`);
  assert.equal(agentAvatarImageSource({ assetId: ASSET, mediaType: 'IMAGE/WebP', imageBase64: png }, ASSET), `data:image/webp;base64,${png}`);
  assert.equal(agentAvatarImageSource({ assetId: `img-${'b'.repeat(64)}`, mediaType: 'image/png', imageBase64: png }, ASSET), null, 'another asset never answers for this one');
  assert.equal(agentAvatarImageSource({ assetId: ASSET, mediaType: 'image/gif', imageBase64: png }, ASSET), null);
  assert.equal(agentAvatarImageSource({ assetId: ASSET, mediaType: 'image/svg+xml', imageBase64: png }, ASSET), null);
  assert.equal(agentAvatarImageSource({ assetId: ASSET, mediaType: 'image/png', imageBase64: 'not base64!!' }, ASSET), null);
  assert.equal(agentAvatarImageSource({ assetId: ASSET, mediaType: 'image/png', imageBase64: '' }, ASSET), null);
  assert.equal(agentAvatarImageSource({ assetId: ASSET, mediaType: 'image/png', imageBase64: base64Of(AVATAR_IMAGE_MAX_BYTES) }, ASSET)?.startsWith('data:image/png;base64,'), true);
  assert.equal(agentAvatarImageSource({ assetId: ASSET, mediaType: 'image/png', imageBase64: base64Of(AVATAR_IMAGE_MAX_BYTES + 1) }, ASSET), null);
  assert.equal(agentAvatarImageSource(null, ASSET), null);
  assert.equal(agentAvatarImageSource({ assetId: ASSET, mediaType: 'image/png', imageBase64: png }, 'img-bad'), null);
});

test('messageAuthorAvatar: the avatar captured at send wins; the room Agent lends its face only under the same name', () => {
  const room = { name: '검증 담당', avatar: EMOJI };
  assert.deepEqual(messageAuthorAvatar({ role: 'assistant', authorAvatar: PHOTO }, '검증 담당', room), PHOTO);
  assert.deepEqual(messageAuthorAvatar({ role: 'assistant' }, '검증 담당', room), EMOJI);
  assert.equal(messageAuthorAvatar({ role: 'assistant' }, '예전 이름', room), null);
  assert.equal(messageAuthorAvatar({ role: 'user', authorAvatar: PHOTO }, '대표님', room), null);
  assert.equal(messageAuthorAvatar({ role: 'assistant', authorAvatar: { kind: 'image', value: 'V', color: '#252a26', assetId: 'nope' } }, 'x', null), null);
});

test('agentWorkingRows: one bubble per busy run as its own Agent; held or disconnected rooms show none', () => {
  const runs = [
    { runId: 'r-done', status: 'completed', authorName: '탐색 담당' },
    { runId: 'r-a', status: 'running', authorName: '탐색 담당', authorAvatar: EMOJI },
    { runId: 'r-b', status: 'running', authorName: '검증 담당', authorAvatar: PHOTO, pendingApprovals: [{ id: 'ap' }] },
    { runId: 'r-b', status: 'running', authorName: '검증 담당' },
    { runId: 'r-c', status: 'running' },
  ];
  const rows = agentWorkingRows(runs, { roomName: '방 담당', roomAvatar: EMOJI });
  assert.deepEqual(rows.map(row => [row.runId, row.name, row.state, row.text, row.showName]), [
    ['r-a', '탐색 담당', 'working', 'Agent 작업 중', true],
    ['r-b', '검증 담당', 'approval', '승인을 기다리는 중', true],
    ['r-c', '방 담당', 'working', 'Agent 작업 중', true],
  ]);
  assert.deepEqual(rows[1].avatar, PHOTO);
  assert.deepEqual(rows[2].avatar, EMOJI, 'a run without its own author shows the room Agent');
  // One Agent alone keeps the quiet bubble: no name above it unless the room is a Board Thread.
  const alone = agentWorkingRows([runs[1]], { roomName: '방 담당' });
  assert.deepEqual(alone.map(row => row.showName), [false]);
  assert.deepEqual(agentWorkingRows([runs[1]], { roomName: '방 담당', group: true }).map(row => row.showName), [true]);
  assert.deepEqual(agentWorkingRows(runs, { held: true }), []);
  assert.deepEqual(agentWorkingRows(runs, { connected: false }), []);
  assert.deepEqual(agentWorkingRows([{ runId: 'r-x', status: 'running', stopUnconfirmed: true }]), []);
  assert.deepEqual(agentWorkingRows(null), []);
});

test('resolveCardAgentIdentity: the acting run names the Card Agent; reading loses to acting; no live run means no name', () => {
  const threads = { 'ct-a': { id: 't-a', profileEnabled: true }, 'ct-b': { id: 't-b', profileEnabled: false } };
  const runs = { 't-a': [{ runId: 'run-1', authorName: '탐색 담당', authorAvatar: PHOTO }, { runId: 'run-2' }], 't-b': [] };
  const hooks = { threadFor: id => threads[id] || null, runsFor: thread => runs[thread.id] || [],
    roomProfileFor: thread => thread.profileEnabled ? { name: '방 담당', avatar: EMOJI } : null };
  assert.deepEqual(resolveCardAgentIdentity([
    { runId: 'run-2', clientThreadId: 'ct-a', permission: 'observe' },
    { runId: 'run-1', clientThreadId: 'ct-a', permission: 'interact' },
  ], hooks), { name: '탐색 담당', avatar: PHOTO, runId: 'run-1', threadId: 't-a', permission: 'interact' });
  assert.deepEqual(resolveCardAgentIdentity([{ runId: 'run-2', clientThreadId: 'ct-a', permission: 'observe' }], hooks),
    { name: '방 담당', avatar: EMOJI, runId: 'run-2', threadId: 't-a', permission: 'observe' }, 'a run without an author is the room Agent');
  assert.deepEqual(resolveCardAgentIdentity([{ runId: 'run-9', clientThreadId: 'ct-b', permission: 'interact' }], hooks),
    { name: 'Codex', avatar: null, runId: 'run-9', threadId: 't-b', permission: 'interact' }, 'a plain Codex room is Codex');
  assert.equal(resolveCardAgentIdentity([{ runId: 'run-1', clientThreadId: 'ct-gone', permission: 'interact' }], hooks), null);
  assert.equal(resolveCardAgentIdentity([], hooks), null);
  assert.equal(resolveCardAgentIdentity(null, hooks), null);
});

test('cardAgentIdentityView: the chip follows the badge — shown while operating, kept through recent, gone for user hold or hidden', () => {
  const identity = { name: '탐색 담당', avatar: EMOJI, runId: 'run-1', threadId: 't-a', permission: 'interact' };
  const operating = cardAgentIdentityView({ mode: 'operating', label: 'Agent 조작 중' }, identity, null);
  assert.deepEqual(operating, { shown: true, name: '탐색 담당', avatar: EMOJI, remember: identity });
  const recent = cardAgentIdentityView({ mode: 'recent', label: '최근 Agent 활동 2건' }, null, identity);
  assert.deepEqual([recent.shown, recent.name, recent.remember], [true, '탐색 담당', identity], 'the name outlives the binding while the badge still counts');
  assert.deepEqual(cardAgentIdentityView({ mode: 'operating', label: 'Agent 읽는 중' }, null, identity), { shown: false, name: '', avatar: null, remember: null },
    'operating without a known run shows no name and forgets the old one');
  assert.deepEqual(cardAgentIdentityView({ mode: 'user', label: '대표님이 직접 조작 중' }, identity, identity), { shown: false, name: '', avatar: null, remember: null });
  assert.deepEqual(cardAgentIdentityView({ mode: 'hidden', label: '' }, identity, identity), { shown: false, name: '', avatar: null, remember: null });
  assert.deepEqual(cardAgentIdentityView({ mode: 'recent', label: '최근 Agent 활동 1건' }, null, null), { shown: false, name: '', avatar: null, remember: null });
  assert.deepEqual(cardAgentIdentityView(null, identity, identity).shown, false);
});

test('ChatState keeps photo references where the Chat reads avatars: catalog rows, projected answers, the peek', () => {
  const rows = ChatState.normalizeProfileCatalog({ profiles: [{ id: 'explorer', lifecycle: 'active', origin: 'user', headRevision: 2, activeRevision: 2, name: '탐색 담당', avatar: PHOTO }] });
  assert.deepEqual(rows[0].avatar, PHOTO);
  assert.deepEqual(ChatState.displayProfileAvatar({ ...PHOTO, assetId: 'img-bad' }), null);
  assert.deepEqual(ChatState.displayProfileAvatar(EMOJI), EMOJI);
  const peek = ChatState.agentPeekView({ author: '탐색 담당', authorAvatar: PHOTO, profile: null });
  assert.deepEqual(peek.avatar, PHOTO);
});
