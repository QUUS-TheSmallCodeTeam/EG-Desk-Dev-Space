import test from 'node:test';
import assert from 'node:assert/strict';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import {
  AVATAR_IMAGE_MAX_BYTES, agentAvatarImageSource, agentAvatarView, agentWorkingRows, cardAgentIdentityView,
  isAvatarAssetId, messageAuthorAvatar, resolveCardAgentIdentity,
} from '../overlay/resources/EGDeskAgentIdentityView.sys.mjs';
import { fileCardAgentBadges, pathInsideRoot, runTouchedPaths } from '../overlay/resources/EGDeskAgentIdentityView.sys.mjs';

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

test('File card Agent badge: a run touches only the File cards of its own verified project, inside the root', () => {
  const run = {
    runId: 'turn-1',
    activities: [
      { kind: 'fileChange', detail: { changes: [{ path: '/work/app/src/a.js', kind: 'update' }, { path: '/work/app/src/a.js', kind: 'update' }, { path: '/work/app-other/x.js' }] },
        sourceRefs: [{ type: 'file', target: { path: '/work/app/README.md' } }] },
      { kind: 'fileChange', detail: { changes: [{ path: '/work/app/../etc/passwd' }, { path: 'relative/b.js' }, { path: '/work/app/./c.js' }, { path: 7 }] } },
      { kind: 'commandExecution', detail: { changes: [{ path: '/work/app/cmd.js' }] } },
    ],
  };
  const paths = runTouchedPaths(run);
  assert.deepEqual(paths, ['/work/app/src/a.js', '/work/app-other/x.js', '/work/app/README.md'], 'deduplicated absolute paths; traversal, relative and non-file rows dropped');
  assert.equal(pathInsideRoot('/work/app', '/work/app-other/x.js'), null, 'a sibling folder with the same prefix is outside');
  assert.equal(pathInsideRoot('/work/app/', '/work/app/src/a.js'), 'src/a.js');
  assert.equal(pathInsideRoot('/work/app', '/work/app'), null, 'the root itself is not a file inside it');

  const project = { projectId: 'proj-1', rootId: 'root-1' };
  const scope = { ...project, rootPath: '/work/app' };
  const runs = [
    { runId: 'done', name: '리뷰어', avatar: { kind: 'initial', value: 'R', color: '#252a26' }, busy: false, project, paths: ['/work/app/old.js'] },
    { runId: 'turn-1', name: '리오', avatar: EMOJI, busy: true, project, paths },
    { runId: 'elsewhere', name: '다른 방', busy: true, project: { projectId: 'proj-2', rootId: 'root-2' }, paths: ['/work/app/src/a.js'] },
  ];
  const cards = [
    { cardId: 'file-a', scope },
    { cardId: 'file-picked', scope: null },
    { cardId: 'file-other-root', scope: { ...project, rootId: 'root-9', rootPath: '/work/app' } },
    { cardId: 'file-sub', scope: { ...project, rootPath: '/work/app/src' } },
    { cardId: 'file-bad-path', scope: { ...project, rootPath: 'work/app' } },
  ];
  const badges = fileCardAgentBadges(runs, cards);
  assert.deepEqual(badges.map(badge => [badge.cardId, badge.runId, badge.name, badge.busy, badge.count, badge.files]), [
    ['file-a', 'turn-1', '리오', true, 2, ['src/a.js', 'README.md']],
    ['file-sub', 'turn-1', '리오', true, 1, ['a.js']],
  ], 'a busy run wins; a picked folder, another root and an unverified path show nothing; another project never matches');
  assert.equal(badges[0].text, '리오 · 파일 2개 작업 중');
  assert.deepEqual(badges[0].avatar, EMOJI);
  const finished = fileCardAgentBadges([runs[0]], [{ cardId: 'file-a', scope }]);
  assert.equal(finished[0].text, '리뷰어 · 파일 1개 작업함');
  assert.deepEqual(fileCardAgentBadges([{ ...runs[1], project: null }], [{ cardId: 'file-a', scope }]), [], 'a run without a verified project sees no File card');
  assert.deepEqual(fileCardAgentBadges(null, null), []);
});

test('File card Agent badge wiring: the File card exposes only its verified project root and the Chat refresh draws the chip', async () => {
  const { readFile } = await import('node:fs/promises');
  const surface = await readFile(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
  const fileCard = await readFile(new URL('../overlay/resources/surface/EGDeskSurfaceFileCard.mjs', import.meta.url), 'utf8');
  assert.match(fileCard, /Object\.defineProperty\(card, '_fileAgentScope', \{ configurable: true, get: \(\) => projectConnection && !rootNeedsReconnect/);
  assert.match(surface, /AgentIdentityView\.fileCardAgentBadges\(runs, fileCards\.map\(card => \(\{ cardId: card\.id, scope: card\._fileAgentScope \|\| null \}\)\)\)/);
  assert.match(surface, /const project = entry\?\.status === 'ready' && entry\.value\?\.status === 'connected' \? entry\.value\.project : null;/);
  assert.match(surface, /if \(!ChatState\.isRunBusy\(run\)\) continue;/);
  assert.match(surface, /renderCodexActivityPanel\(\);\n {6}if \(typeof refreshFileCardAgentBadges === .function.\) refreshFileCardAgentBadges\(\);/);
});
