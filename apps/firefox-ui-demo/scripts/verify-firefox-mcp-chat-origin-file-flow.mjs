#!/usr/bin/env node
// Attach-only, Main-owned native UI acceptance. Importing starts nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { qaBridgeConfig, validateQaFixtureIsolation } from './egdesk-qa-fixture-isolation.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { chatOriginFileFixtureEnabled, CHAT_ORIGIN_FILE_SEED, CHAT_ORIGIN_FILE_STATE, CHAT_ORIGIN_FILE_CONTROL,
  CHAT_ORIGIN_FILE_TEXT, CHAT_ORIGIN_FILE_OUTPUT, CHAT_ORIGIN_FILE_BOARDS } from './egdesk-chat-origin-file-fixture.mjs';
import { prepareRunOutputDesk, clickRunOutputControl, clickRunOutputSelector } from './verify-firefox-mcp-chat-run-outputs-flow.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const testid = value => `[data-testid=${JSON.stringify(value)}]`;
const FILE_CARD = '[data-testid="file-card"].egd-file-card';
const ID_FIELDS = ['conversationId', 'runId', 'itemId'];
export function originCommandSelector(target) {
  for (const key of ID_FIELDS) assert.ok(typeof target?.[key] === 'string' && target[key].trim() && target[key].length <= 300 && !/[\u0000-\u001f]/.test(target[key]), `Exact ${key} required`);
  return `${testid('chat-command-result')}${ID_FIELDS.map(key => `[data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}=${JSON.stringify(target[key])}]`).join('')}`;
}
export function chatOriginFileOptions(argv, env = process.env, now = Date.now()) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--profile', '--deadline-utc'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--') && !args.has(argv[i]), 'Expected --profile PATH and optional --deadline-utc UTC_ISO_TIMESTAMP');
    args.set(argv[i], argv[i + 1]);
  }
  assert.ok(args.get('--profile') && path.isAbsolute(args.get('--profile')), 'Explicit absolute profile required');
  assert.equal(chatOriginFileFixtureEnabled(env), true);
  assert.equal(env.MOZ_HEADLESS, '1', 'Main-owned headless QA only');
  assert.equal(String(env.EGDESK_MARIONETTE_PORT || '2829'), '2829');
  assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16);
  const bridge = qaBridgeConfig(env);
  assert.ok(![2828, 2829, 6000, 6001].includes(bridge.port), 'Fixture cannot share an automation port');
  const utc = args.get('--deadline-utc');
  if (utc) assert.match(utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
  const deadlineMs = utc ? Date.parse(utc) : now + 6 * 60_000;
  assert.ok(Number.isFinite(deadlineMs) && deadlineMs > now && deadlineMs - now <= 15 * 60_000, 'Future deadline within 15 minutes required');
  return { profile: args.get('--profile'), bridge, deadlineMs };
}
export function originFileModuleProvenance(profile) {
  assertQaFixtureManifest(profile);
  const manifest = validateQaFixtureIsolation(profile), receipts = {};
  // The common manifest always covers SurfaceFileCard's sanctioned endpoint
  // rewrite. Also hash the unmodified presentation modules even when an older
  // common materializer did not enumerate them for this new fixture mode.
  for (const name of ['EGDeskChatRunResult.sys.mjs', 'EGDeskFileView.sys.mjs', 'EGDeskRunResult.sys.mjs']) {
    const relative = `resources/${name}`, actual = path.join(profile, 'chrome', relative);
    assert.ok(fs.lstatSync(actual).isFile() && !fs.lstatSync(actual).isSymbolicLink() && fs.realpathSync.native(actual) === actual);
    const source = hash(fs.readFileSync(new URL(`../overlay/${relative}`, import.meta.url))), copied = hash(fs.readFileSync(actual));
    assert.equal(copied, source, `Actual profile presentation module differs: ${relative}`);
    receipts[relative] = { originalSha256: source, transformedSha256: copied };
  }
  const relative = 'resources/surface/EGDeskSurfaceFileCard.mjs', entry = manifest.files?.[relative];
  assert.match(entry?.originalSha256 || '', /^[a-f0-9]{64}$/);
  assert.match(entry?.transformedSha256 || '', /^[a-f0-9]{64}$/);
  assert.deepEqual(entry.replacements, { endpointUrls: 1, helperPortConstants: 0 });
  assert.equal(Object.hasOwn(entry, 'projectPickerTransform'), false, 'No picker/result body replacement');
  receipts[relative] = structuredClone(entry);
  return receipts;
}
export function assertChatOriginFilePeer(peer, options) {
  assert.equal(peer.kind, 'egdesk-chat-origin-file-fixture'); assert.equal(peer.fixture, true); assert.equal(peer.disposed, false);
  assert.equal(peer.profile, options.profile);
  for (const key of ['host', 'port', 'origin']) assert.equal(peer[key], options.bridge[key]);
  for (const key of ['providerTurns', 'shellExecutions', 'nativeProcessSpawns', 'nativePickerInvocations', 'approvalPosts',
    'uiOriginalWriteAttempts', 'uiOriginalWrites', 'gitAttempts', 'nativeCreateAttempts']) assert.equal(peer.effects[key], 0, key);
  assert.equal(peer.effects.setupSourceWrites, 2); assert.equal(peer.effects.setupPickerGrants, 2);
  assert.equal(peer.effects.profileCatalogWrites, 1);
  if (peer.original) {
    assert.equal(peer.persisted.origins.length, 1);
    const stored = peer.persisted.origins[0];
    for (const key of ['conversationId', 'runId', 'clientThreadId', 'requestId']) assert.equal(stored[key], peer.original[key]);
    assert.equal(stored.project.projectId, peer.projects.original.projectId); assert.equal(stored.project.startCwd, peer.folders.original);
    assert.deepEqual(peer.fakeRpc.map(value => value.method), ['thread/start', 'turn/start']);
    assert.equal(peer.retainedOutputSha256, hash(CHAT_ORIGIN_FILE_OUTPUT));
  }
  return true;
}
export function assertOriginReadWindow(before, after) {
  assert.deepEqual(after.fakeRpc, before.fakeRpc); assert.deepEqual(after.controls, before.controls); assert.deepEqual(after.frames, before.frames);
  assert.deepEqual(after.registrations, before.registrations, 'No picker/reconnection grants while opening the original run');
  assert.deepEqual(after.persisted.origins, before.persisted.origins); assert.equal(after.persisted.requests, before.persisted.requests);
  assert.equal(after.persisted.events, before.persisted.events); assert.equal(after.retainedOutputSha256, before.retainedOutputSha256);
  assert.equal(after.sourceSha256, hash(CHAT_ORIGIN_FILE_TEXT.current)); assert.equal(after.sourceSha256, before.sourceSha256);
  assert.equal(after.otherSha256, before.otherSha256);
  assert.deepEqual(after.effects, { ...before.effects, managedDraftSqlWrites: before.effects.managedDraftSqlWrites + 1 });
  assert.equal(after.persisted.drafts, before.persisted.drafts + 1);
  assert.deepEqual(after.requests.slice(0, before.requests.length), before.requests);
  const requests = after.requests.slice(before.requests.length);
  const { rootId, directoryId } = before.projects.original;
  assert.ok(rootId && directoryId);
  const origins = requests.filter(row => row.path === '/chat/run-project-origin');
  assert.ok(origins.length >= 2, 'Opening rechecks the real original-run origin around file reads');
  for (const row of origins) {
    assert.equal(row.method, 'GET'); assert.equal(row.status, 200); assert.equal(row.delegated, true);
    assert.deepEqual(row.query, { conversationId: before.original.conversationId, runId: before.original.runId });
    assert.equal(row.response.verified, true); assert.equal(row.response.rootId, rootId);
    assert.equal(row.response.directoryId, directoryId); assert.equal(row.response.displayPath, before.folders.original);
  }
  const lists = requests.filter(row => row.path === '/v1/files/list');
  assert.equal(lists.length, 1, 'Exactly one initial original-root directory listing');
  assert.deepEqual(lists[0].request, { directoryId, cursor: 0, limit: 100 });
  const resolved = requests.filter(row => row.path === '/v1/files/resolve');
  assert.equal(resolved.length, 1); assert.equal(resolved[0].status, 200);
  assert.deepEqual(resolved[0].request, { rootId: before.projects.original.rootId, path: before.sourcePath });
  const fileId = resolved[0].response.result.id;
  assert.ok(typeof fileId === 'string' && fileId);
  const reads = requests.filter(row => row.path === '/v1/files/read');
  assert.equal(reads.length, 1); assert.equal(reads[0].status, 200); assert.deepEqual(reads[0].request, { fileId });
  const drafts = requests.filter(row => row.path === '/v1/files/drafts/create');
  assert.equal(drafts.length, 1); assert.equal(drafts[0].status, 200); assert.deepEqual(drafts[0].request, { fileId });
  const draftId = drafts[0].response?.result?.id;
  assert.ok(typeof draftId === 'string' && draftId, 'Actual newly created draft receipt required');
  const checkDraft = row => {
    assert.equal(row.response.result.id, draftId); assert.equal(row.response.result.fileId, fileId);
    assert.equal(row.response.result.rootId, rootId);
  };
  checkDraft(drafts[0]);
  const draftReads = requests.filter(row => row.path === '/v1/files/drafts/read');
  assert.ok(draftReads.length <= 1, 'No unrelated or repeated draft reads');
  for (const row of draftReads) {
    assert.ok(requests.indexOf(row) > requests.indexOf(drafts[0]), 'Only the newly created draft may be reread');
    assert.deepEqual(row.request, { draftId }); checkDraft(row);
  }
  const allowed = new Set(['/chat/run-project-origin', '/chat/state',
    '/v1/files/list', '/v1/files/resolve', '/v1/files/read', '/v1/files/drafts/create', '/v1/files/drafts/read']);
  assert.ok(requests.every(row => allowed.has(row.path) && row.delegated && row.status === 200), 'No current-Board lookup, send, shell, approval or original-write fallback');
  for (const row of requests) {
    assert.equal(row.method, row.path.startsWith('/chat/') ? 'GET' : 'POST');
    if (row.path !== '/chat/run-project-origin') assert.deepEqual(row.query, {}, 'No hidden query target');
  }
  return { fileId, draftId, originReads: origins.length, managedDraftSqlWrites: 1 };
}
export function assertOriginActiveRoom(view, original, initialRoom) {
  assert.ok(initialRoom?.id && initialRoom.clientThreadId);
  assert.equal(initialRoom.clientThreadId, original.clientThreadId);
  assert.equal(view.thread.id, initialRoom.id, 'The initially created UI room remains active');
  assert.equal(view.thread.clientThreadId, original.clientThreadId);
  assert.equal(view.thread.conversationId, original.conversationId);
}
export function assertCurrentOriginFileUi(before, after, state, fileId, draftId, initialRoom) {
  for (const view of [before, after]) {
    assertOriginActiveRoom(view, state.original, initialRoom);
    assert.equal(view.command.count, 1);
    for (const key of ID_FIELDS) assert.equal(view.command.identity[key], state.original[key]);
    assert.equal(view.command.tail, CHAT_ORIGIN_FILE_OUTPUT.trimEnd());
  }
  assert.deepEqual(after.command.tail, before.command.tail, 'HISTORIC output stays in the original result');
  assert.equal(after.thread.requestProjectTarget?.projectId, state.projects.other.projectId, 'Another Board was actually selected for the next request');
  const oldIds = new Set(before.cards.map(card => card.id)), added = after.cards.filter(card => !oldIds.has(card.id));
  assert.equal(added.length, 1, 'Exactly one NEW File Card');
  assert.ok([...oldIds].every(id => after.cards.some(card => card.id === id)), 'Existing File Cards remain');
  const card = added[0]; assert.match(card.id, /^egd-file-card-\d+$/);
  assert.equal(card.ready, true); assert.equal(card.openStatus, 'opened'); assert.equal(card.busy, 'false'); assert.equal(card.inert, false);
  assert.equal(card.snapshot.rootId, state.projects.original.rootId); assert.equal(card.snapshot.fileId, fileId); assert.equal(card.snapshot.draftId, draftId);
  assert.equal(card.editor.value, CHAT_ORIGIN_FILE_TEXT.current); assert.equal(card.editor.visible, true);
  assert.equal(originEditorVisible(card.editor.geometry), true, 'CURRENT editor must be on-screen, unclipped, unoccluded and internally readable');
  assert.equal(card.badge.text, '현재 파일'); assert.equal(card.badge.visible, true);
  assert.ok(card.notice.paragraphs.some(value => value.text.includes(state.sourcePath) && value.painted), 'Full wrapped original path is painted');
  assert.ok(card.notice.paragraphs.some(value => /현재 파일/.test(value.text) && /당시 내용과 다를 수/.test(value.text) && value.painted), 'Current versus historic warning is visible');
  assert.equal(card.notice.details.length, 1); assert.equal(card.notice.details[0].open, false);
  assert.equal(card.notice.details[0].summary, '출처 상세');
  // Raw IDs/old line references stay in closed native Details, not mandatory
  // always-painted paragraphs. Identity is verified structurally and by HTTP.
  for (const key of ID_FIELDS) assert.ok(card.notice.details[0].text.includes(state.original[key]));
  assert.match(card.notice.details[0].text, /2행.*3열/);
  return card;
}

// Serializable read-only geometry; a textarea's value alone is not visual proof.
export function originEditorVisible(value) {
  const valid = r => r && ['left', 'right', 'top', 'bottom', 'width', 'height'].every(key => Number.isFinite(r[key]))
    && r.width > 0 && r.height > 0 && r.right > r.left && r.bottom > r.top;
  if (!value?.styledVisible || !valid(value.rect) || !valid(value.viewport) || !value.contentFits
      || !Array.isArray(value.clips) || !Array.isArray(value.hits) || value.hits.length !== 9 || !value.hits.every(hit => hit === true)) return false;
  const inside = (outer, x = true, y = true) => valid(outer)
    && (!x || value.rect.left >= outer.left - 0.5 && value.rect.right <= outer.right + 0.5)
    && (!y || value.rect.top >= outer.top - 0.5 && value.rect.bottom <= outer.bottom + 0.5);
  return inside(value.viewport) && value.clips.every(clip => inside(clip.rect, clip.x, clip.y));
}
export function readOriginEditorGeometry(node) {
  if (!node) return null;
  const document = node.ownerDocument, view = document.defaultView;
  const box = r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
  const rect = box(node.getBoundingClientRect()), clips = [], hits = [];
  let styledVisible = node.isConnected;
  for (let n = node; n; n = n.parentElement) {
    const style = view.getComputedStyle(n);
    if (n.hidden || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) styledVisible = false;
    if (n === node) continue;
    const x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX), y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
    if (x || y) {
      const b = n.getBoundingClientRect(), sx = b.width / n.offsetWidth, sy = b.height / n.offsetHeight;
      const left = b.left + n.clientLeft * sx, top = b.top + n.clientTop * sy;
      const width = n.clientWidth * sx, height = n.clientHeight * sy;
      clips.push({ x, y, rect: { left, top, width, height, right: left + width, bottom: top + height } });
    }
  }
  for (const x of [0.2, 0.5, 0.8]) for (const y of [0.2, 0.5, 0.8]) {
    const hit = document.elementFromPoint(rect.left + rect.width * x, rect.top + rect.height * y);
    hits.push(!!hit && (hit === node || node.contains(hit)));
  }
  return { styledVisible, rect, clips, hits,
    viewport: { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight, width: view.innerWidth, height: view.innerHeight },
    scrollTop: node.scrollTop, scrollLeft: node.scrollLeft,
    contentFits: node.clientHeight > 0 && node.clientWidth > 0 && node.scrollTop === 0 && node.scrollLeft === 0
      && node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1 };
}

export async function observeChatOriginFileUi(harness, target) {
  const selector = originCommandSelector(target);
  return harness.evaluateChrome(`() => {
    const editorVisible = ${originEditorVisible.toString()};
    const editorGeometry = ${readOriginEditorGeometry.toString()};
    const shown = node => {
      if (!node?.isConnected) return false;
      const r = node.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      for (let n = node; n; n = n.parentElement) { const s = getComputedStyle(n); if (n.hidden || s.display === 'none' || s.visibility === 'hidden') return false; }
      return true;
    };
    const painted = node => {
      if (!shown(node)) return false;
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = [...range.getClientRects()];
      return rects.length > 0 && rects.every(r => {
        if (!(r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight)) return false;
        for (let n = node; n; n = n.parentElement) { const s = getComputedStyle(n), b = n.getBoundingClientRect();
          if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && (r.left < b.left - 1 || r.right > b.right + 1)) return false;
          if (/(auto|scroll|hidden|clip)/.test(s.overflowY) && (r.top < b.top - 1 || r.bottom > b.bottom + 1)) return false;
        }
        return true;
      });
    };
    const roots = [...document.querySelectorAll(${JSON.stringify(selector)})], root = roots.length === 1 ? roots[0] : null;
    const c = window.__egdesk?.state?.codex, t = c?.threads?.find(value => value.id === c.activeThreadId);
    return { thread: { id: t?.id, clientThreadId: t?.clientBindingId || t?.id, conversationId: t?.conversationId, requestProjectTarget: t?.requestProjectTarget || null },
      command: { count: roots.length, identity: { conversationId: root?.dataset.conversationId, runId: root?.dataset.runId, itemId: root?.dataset.itemId },
        state: root?.getAttribute('data-state'), tail: root?.querySelector('.egdesk-run-result-tail')?.textContent || '',
        notice: root?.querySelector(':scope > .egd-codex-activity-note[role="status"]')?.textContent || '',
        buttons: [...(root?.querySelectorAll('button.egdesk-run-result-location') || [])].map(node => ({ text: node.textContent, aria: node.getAttribute('aria-label'), disabled: node.disabled, visible: shown(node) })) },
      cards: [...document.querySelectorAll(${JSON.stringify(FILE_CARD)})].map(card => {
        const notice = card.querySelector('[data-testid="file-card-notice"]'), view = card.querySelector('[data-testid="file-view"]'), editor = card.querySelector('[data-testid="file-editor"]'), badge = card.querySelector('[data-testid="file-card-status"]');
        const geometry = editorGeometry(editor);
        return { id: card.id, ready: !!card._fileReady, openStatus: card._fileOpenStatus, snapshot: card._fileView?.snapshot?.(), busy: view?.getAttribute('aria-busy'), inert: view?.inert,
          editor: { value: editor?.value, visible: editorVisible(geometry), geometry }, badge: { text: badge?.textContent, visible: painted(badge) },
          notice: { paragraphs: [...(notice?.querySelectorAll(':scope > p') || [])].map(node => ({ text: node.textContent, painted: painted(node) })),
            details: [...(notice?.querySelectorAll(':scope > details') || [])].map(node => ({ open: node.open, summary: node.querySelector('summary')?.textContent, text: node.textContent })) } };
      }) };
  }`);
}

export async function observeOriginDesk(harness) {
  return harness.evaluateChrome(`() => {
    const api = window.__egdesk, surface = api.surface.snapshot();
    const card = surface.browserCardId ? document.getElementById(surface.browserCardId) : null;
    return { initialBrowserFocus: !!surface.initialBrowserFocus,
      fullscreen: !!card?.id && api.state.cardFullscreen?.cardId === card.id,
      cardId: card?.id || null, browserContextId: card?._xulBrowser?.browsingContext?.id ?? null };
  }`);
}

export async function observeOriginProjectUi(harness) {
  return harness.evaluateChrome(`() => {
    const geometry = ${readOriginEditorGeometry.toString()};
    const c = window.__egdesk?.state?.codex, t = c?.threads?.find(value => value.id === c.activeThreadId);
    const panels = [...document.querySelectorAll('[data-testid="chat-project-panel"]')], panel = panels.length === 1 ? panels[0] : null;
    const effective = panel?.querySelector('[data-testid="chat-project-effective"]');
    const summary = panel?.querySelector('[data-testid="chat-room-project-current"]');
    const chips = [...document.querySelectorAll('[data-testid="chat-attachments"]')]
      .filter(node => node.dataset.threadId === t?.id)
      .flatMap(node => [...node.querySelectorAll('[data-testid="chat-project-target"]')]);
    const chip = chips.length === 1 ? chips[0] : null;
    return { thread: { id: t?.id, clientThreadId: t?.clientBindingId || t?.id, conversationId: t?.conversationId,
        messages: t?.messages?.length, requestProjectTarget: t?.requestProjectTarget || null, sendError: t?.sendError || null },
      panelCount: panels.length, panelThreadId: panel?.dataset.threadId,
      chip: { count: chips.length, source: chip?.dataset.source, text: chip?.textContent },
      effective: { source: effective?.dataset.source, title: effective?.querySelector('strong')?.textContent,
        path: effective?.querySelector('p')?.textContent, geometry: geometry(effective) },
      summary: { status: summary?.dataset.status, source: summary?.dataset.source, text: summary?.textContent } };
  }`);
}

export function assertOriginRoomUnsent(peer, room) {
  assert.ok(room?.id && room.clientThreadId);
  assert.equal(peer.original, null); assert.deepEqual(peer.fakeRpc, [], 'No fake engine acceptance before the reviewed Send');
  assert.equal(peer.persisted.requests, 0); assert.equal(peer.persisted.events, 0); assert.deepEqual(peer.persisted.origins, []);
  assert.equal(peer.requests.some(row => row.path === '/chat/send'), false, 'No first-send/retry workaround');
}

export function assertOriginRoomProjectReview(view, peer, room, status, afterSequence = 0) {
  assertOriginRoomUnsent(peer, room);
  assert.ok(['none', 'connected'].includes(status));
  assert.equal(view.thread.id, room.id); assert.equal(view.thread.clientThreadId, room.clientThreadId);
  assert.ok(!view.thread.conversationId); assert.equal(view.thread.messages, 0); assert.equal(view.thread.requestProjectTarget, null);
  assert.equal(view.panelCount, 1); assert.equal(view.panelThreadId, room.id);
  const source = status === 'none' ? 'none' : 'board';
  assert.equal(view.summary.status, status); assert.equal(view.summary.source, source);
  assert.equal(view.effective.source, source); assert.equal(view.chip.count, 1); assert.equal(view.chip.source, source);
  assert.equal(originEditorVisible(view.effective.geometry), true, 'The effective project and full path must be visibly readable');
  const reads = peer.requests.filter(row => row.path === '/v1/files/projects/room-default' && row.request?.roomId === room.clientThreadId);
  const read = reads.at(-1);
  assert.ok(read?.sequence > afterSequence, 'A fresh UI room-default HTTP read is required after fixture preparation');
  assert.equal(read.method, 'POST'); assert.equal(read.status, 200); assert.equal(read.delegated, true);
  assert.deepEqual(read.query, {}); assert.deepEqual(read.request, { roomId: room.clientThreadId });
  assert.equal(read.response?.ok, true);
  const value = read.response.result;
  assert.equal(value.roomId, room.clientThreadId); assert.equal(value.status, status);
  const expected = { roomId: room.clientThreadId, status, source: status === 'none' ? null : 'board',
    boardId: status === 'none' ? null : CHAT_ORIGIN_FILE_BOARDS.original,
    projectId: status === 'none' ? null : peer.projects.original.projectId,
    rootId: status === 'none' ? null : peer.projects.original.rootId };
  assert.deepEqual({ roomId: value.roomId, status: value.status, source: value.source, boardId: value.inheritance?.boardId ?? null,
    projectId: value.project?.projectId ?? null, rootId: value.project?.rootId ?? null }, expected);
  assert.equal(value.override, null);
  if (status === 'none') {
    assert.equal(value.inheritance, null); assert.equal(value.project, null); assert.equal(peer.preparedRoom, null);
  } else {
    assert.equal(peer.preparedRoom, room.clientThreadId);
    assert.equal(value.project.displayPath, peer.folders.original);
    assert.equal(view.effective.path, peer.folders.original, 'Full path, not a tooltip or truncated chip');
    assert.equal(view.effective.title, `Board 상속 · ${value.project.title}`);
    assert.ok(view.chip.text.includes(value.project.title));
  }
  return { expectedRoomProject: expected, displayPath: value.project?.displayPath ?? null, readSequence: read.sequence };
}

export async function prepareOriginRoomForSend(harness, room, { click, state, prepareRoom, waitUntil }) {
  // Read the UI first: its completed render must precede the HTTP trace
  // snapshot, otherwise a just-completed read can be absent from that snapshot.
  const observe = async () => { const view = await observeOriginProjectUi(harness); return { view, peer: await state() }; };
  // Settle the new room's initial read before changing the fixture's server
  // default. Reopening native Details then performs a fresh production read.
  await click(testid('chat-project-open'));
  const empty = await waitUntil(observe, value => value.view.summary.status === 'none' && value.view.chip.source === 'none'
    && originEditorVisible(value.view.effective.geometry), { timeoutMs: 10000 });
  const initial = assertOriginRoomProjectReview(empty.view, empty.peer, room, 'none');
  await click(testid('chat-project-cancel'));
  await prepareRoom(room.clientThreadId);
  const prepared = await state(); assertOriginRoomUnsent(prepared, room);
  await click(testid('chat-project-open'));
  const connected = await waitUntil(observe, value => value.view.summary.status === 'connected' && value.view.chip.source === 'board'
    && originEditorVisible(value.view.effective.geometry), { timeoutMs: 10000 });
  const reviewed = assertOriginRoomProjectReview(connected.view, connected.peer, room, 'connected', prepared.requests.length);
  await click(testid('chat-project-cancel'));
  const closed = await waitUntil(() => observeOriginProjectUi(harness), value => value.panelCount === 0, { timeoutMs: 5000 });
  assert.equal(closed.thread.id, room.id); assert.equal(closed.thread.clientThreadId, room.clientThreadId);
  assert.equal(closed.thread.requestProjectTarget, null); assert.equal(closed.chip.count, 1); assert.equal(closed.chip.source, 'board');
  assertOriginRoomUnsent(await state(), room);
  return { initial, reviewed, nativeInspection: true, sendAttemptsBeforeReview: 0 };
}

export async function runChatOriginFileFlow(options) {
  const provenance = originFileModuleProvenance(options.profile);
  const { runUiFlow, loopbackJson, openChat, sendFromComposer, visible, waitUntil } = await import('./egdesk-qa-ui-flow.mjs');
  const token = process.env.EGDESK_QA_FIXTURE_TOKEN;
  const deadline = () => assert.ok(Date.now() < options.deadlineMs, 'Origin File QA deadline reached');
  const state = async () => { deadline(); const value = await loopbackJson(CHAT_ORIGIN_FILE_STATE, { token }); assertChatOriginFilePeer(value, options); return value; };
  const control = (action, extra = {}) => { deadline(); return loopbackJson(CHAT_ORIGIN_FILE_CONTROL, { method: 'POST', token, body: { action, ...extra } }); };
  await runUiFlow('chat-origin-current-file', async ({ harness, result, check, capture }) => {
    assert.equal(harness.profile, options.profile);
    const click = async selector => {
      deadline(); await visible(harness, selector);
      await waitUntil(() => harness.evaluateChrome(`() => { const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})], n = nodes.length === 1 ? nodes[0] : null, r = n?.getBoundingClientRect();
        const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { count: nodes.length, ready: !!n && !n.disabled && !!r && r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && (n === hit || n.contains(hit)) }; }`),
      value => value.count === 1 && value.ready, { timeoutMs: 5000 });
      deadline(); await harness.click(selector);
      result.nativeControls.push({ action: 'click', selector });
    };
    const initial = await state(); assert.equal(initial.original, null); assert.equal(initial.persisted.origins.length, 0);
    result.moduleProvenance = provenance; result.nativeControls = [];
    await prepareRunOutputDesk(harness, { deadlineMs: options.deadlineMs, readFirstUse: observeOriginDesk, waitUntil });
    await openChat(harness);
    if ((await harness.inspect('.egd-codex-conversation-back')).some(node => node.visible)) await click('.egd-codex-conversation-back');
    await click('.egd-codex-thread-home-new');
    const room = await harness.evaluateChrome(`() => { const c = window.__egdesk.state.codex, t = c.threads.find(value => value.id === c.activeThreadId);
      return { id: t?.id, clientThreadId: t?.clientBindingId || t?.id, conversationId: t?.conversationId, messages: t?.messages?.length, profileEnabled: t?.profileEnabled }; }`);
    assert.ok(room.id && !room.conversationId && room.messages === 0 && room.profileEnabled !== true);
    result.originPreparation = await prepareOriginRoomForSend(harness, room, { click, state, waitUntil,
      prepareRoom: clientThreadId => control('prepare-room', { clientThreadId }) });
    check('original room identity and full project path are natively reviewed before the only Send; engine/request counts remain zero', true);
    deadline(); await sendFromComposer(harness, CHAT_ORIGIN_FILE_SEED);
    const seeded = await waitUntil(async () => {
      const peer = await state();
      if (!peer.original) {
        const view = await observeOriginProjectUi(harness);
        assert.ok(!view.thread.sendError, `Initial ordinary Send was refused; no retry: ${view.thread.sendError}`);
      }
      return peer;
    }, value => value.original && value.chat.runs.some(run => run.runId === value.original.runId && run.status === 'completed'), { timeoutMs: 15000 });
    const sends = seeded.requests.filter(row => row.path === '/chat/send');
    assert.equal(sends.length, 1); assert.equal(sends[0].status, 202); assert.equal(sends[0].delegated, true);
    assert.deepEqual(sends[0].request.expectedRoomProject, result.originPreparation.reviewed.expectedRoomProject);
    assert.equal(Object.hasOwn(sends[0].request, 'projectTarget'), false);
    assert.equal(seeded.original.clientThreadId, room.clientThreadId);
    assert.equal(seeded.requests.filter(row => row.path === '/chat/command-output').length, 0, 'Metadata alone must not fetch output');
    await control('advance-current');
    // Choose the other Board for the NEXT request using actual native controls;
    // do not send again or change the accepted run's private origin.
    await click(testid('chat-project-open'));
    const select = testid('chat-project-board');
    const choices = await harness.evaluateChrome(`() => [...document.querySelector(${JSON.stringify(select)}).options].map(node => ({ value: node.value, label: node.textContent }))`);
    const index = choices.findIndex(option => option.value === CHAT_ORIGIN_FILE_BOARDS.other);
    assert.ok(index > 0 && choices.length <= 16 && choices.filter(option => option.value === CHAT_ORIGIN_FILE_BOARDS.other).length === 1);
    await click(select);
    for (const key of ['Home', ...Array(index).fill('ArrowDown'), 'Enter']) { deadline(); await harness.press(key, select); }
    await waitUntil(() => harness.inspect(testid('chat-project-apply')), nodes => nodes.length === 1 && !nodes[0].disabled, { timeoutMs: 10000 });
    await click(testid('chat-project-apply'));
    await click(testid('chat-activity-open'));
    const target = seeded.original, scope = originCommandSelector(target), clicks = { waitUntil, deadlineMs: options.deadlineMs, trace: result.nativeControls };
    const beforeResult = await state();
    await clickRunOutputControl(harness, scope, '실행 결과 보기', 'button', clicks);
    await waitUntil(() => observeChatOriginFileUi(harness, target), value => value.command.buttons.length === 1, { timeoutMs: 10000 });
    await clickRunOutputSelector(harness, `${scope} .egdesk-run-result-output > summary`, clicks);
    const beforeOpen = await observeChatOriginFileUi(harness, target), beforeFiles = await state();
    assertOriginActiveRoom(beforeOpen, target, room);
    const outputs = beforeFiles.requests.slice(beforeResult.requests.length).filter(row => row.path === '/chat/command-output');
    assert.equal(outputs.length, 1); assert.equal(outputs[0].method, 'GET'); assert.equal(outputs[0].status, 200);
    assert.deepEqual(outputs[0].query, Object.fromEntries(ID_FIELDS.map(key => [key, target[key]])));
    assert.equal(beforeOpen.command.tail, CHAT_ORIGIN_FILE_OUTPUT.trimEnd());
    assert.ok(beforeOpen.command.buttons[0].text.startsWith('현재 파일 열기 ·') && beforeOpen.command.buttons[0].aria.startsWith('현재 파일 열기 ·'));
    await clickRunOutputSelector(harness, `${scope} button.egdesk-run-result-location`, clicks);
    let afterOpen = await waitUntil(() => observeChatOriginFileUi(harness, target), value => value.cards.some(card => !beforeOpen.cards.some(old => old.id === card.id) && card.openStatus === 'opened'), { timeoutMs: 15000 });
    const newCard = afterOpen.cards.find(card => !beforeOpen.cards.some(old => old.id === card.id));
    if (!newCard.notice.paragraphs.every(value => value.painted) || !newCard.editor.visible) {
      await click(`[id=${JSON.stringify(newCard.id)}] .egd-card-dot-max`);
      afterOpen = await observeChatOriginFileUi(harness, target);
      if (afterOpen.cards.find(card => card.id === newCard.id)?.editor.geometry?.scrollTop > 0) {
        deadline(); await harness.scrollWithKey(`[id=${JSON.stringify(newCard.id)}] [data-testid="file-editor"]`, 'Home');
      }
      afterOpen = await waitUntil(() => observeChatOriginFileUi(harness, target), value => {
        const current = value.cards.find(card => card.id === newCard.id);
        return current?.notice.paragraphs.every(item => item.painted) && current.editor.visible;
      }, { timeoutMs: 10000 });
    }
    const final = await state(), reads = assertOriginReadWindow(beforeFiles, final);
    const card = assertCurrentOriginFileUi(beforeOpen, afterOpen, final, reads.fileId, reads.draftId, room);
    check('real accepted origin opens a NEW CURRENT File Card while the old HISTORIC output and other-Board choice remain', true);
    check('UI original writes zero; one managed-draft SQL insert is counted independently of the controlled source rewrite', final.effects.uiOriginalWrites === 0 && final.effects.controlledSourceWrites === 1 && final.effects.managedDraftSqlWrites === 1);
    await capture('origin-current-file-from-historic-command');
    assert.deepEqual(originFileModuleProvenance(options.profile), provenance);
    result.originFile = { original: target, newFileCardId: card.id, fileId: reads.fileId, rootId: card.snapshot.rootId,
      draftId: card.snapshot.draftId, editorVisibility: card.editor.geometry, originReads: reads.originReads, effects: final.effects, retainedOutputSha256: final.retainedOutputSha256,
      sourceSha256: final.sourceSha256, domMutation: false, providerTurn: 'not-run', nativeUiVerified: true };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runChatOriginFileFlow(chatOriginFileOptions(process.argv.slice(2))); }
  catch (cause) { process.stderr.write(`Origin File fixture preflight: ${cause.message}\n`); process.exitCode = 1; }
}
