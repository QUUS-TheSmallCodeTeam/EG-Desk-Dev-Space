// Attach-only. Main starts the owned headless Firefox and fixture listener.
// Native UI -> real flow/HTTP/SQLite -> real owned file IO. Only OS selection
// results are synthetic; no DOM outcomes, flow results or IO receipts replaced.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chrome, loopbackJson, runUiFlow, selectorForId } from './egdesk-qa-ui-flow.mjs';
import { portableTransferFixtureEnabled } from './egdesk-portable-transfer-fixture.mjs';
import { validateQaFixtureIsolation, QA_PORTABLE_TRANSFER_FILES, QA_PORTABLE_PICKER_FILE } from './egdesk-qa-fixture-isolation.mjs';
import { parseCli, assertBeforeDeadline, observeGuard, resizeHeadless, waitStableViewport,
  waitFor, observeTargets, targetIssues, captureHeadlessScreenshot } from './verify-firefox-mcp-headless-ui-regression.mjs';

const testid = value => `[data-testid=${JSON.stringify(value)}]`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const profileImports = state => state.requests.filter(row => row.path === '/profiles/import' && row.delegated);
const profileExports = state => state.requests.filter(row => /^\/profiles\/[^/]+\/export$/.test(row.path) && row.delegated);
export const PORTABLE_OBSERVATION_BUDGET = 12 * 1024;

export function assertPortableEnvironment(env = process.env) {
  assert.equal(portableTransferFixtureEnabled(env), true);
  assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16,
    'Canonical EGDESK_QA_FIXTURE_TOKEN required');
  return true;
}

export function assertPortableStoreInvariant(before, after, { imported = 0, headAdvanced = false } = {}) {
  assert.equal(after.profile, before.profile); assert.equal(after.root, before.root);
  assert.deepEqual(after.catalogSeed, before.catalogSeed);
  assert.equal(after.catalogSeed.coherentBeforeLaunch, true); assert.equal(after.catalogSeed.setupOnly, true);
  assert.deepEqual(after.persisted.desk, before.persisted.desk, 'UI exports never save the current draft or alter saved Board/Desk revisions');
  assert.equal(after.currentImportSha256, before.seed.importSha256);
  const records = after.persisted.profiles.records;
  assert.equal(records.length, before.persisted.profiles.records.length + imported);
  assert.ok(records.every(row => row.active_revision === null && row.lifecycle === 'draft'), 'No activation or assignment');
  for (const row of before.persisted.profiles.revisions) {
    assert.deepEqual(after.persisted.profiles.revisions.find(next => next.profile_id === row.profile_id && next.revision === row.revision), row);
  }
  assert.equal(after.persisted.profiles.revisions.length, before.persisted.profiles.revisions.length + imported + Number(headAdvanced));
  assert.equal(after.headAdvances.length, Number(headAdvanced));
  for (const key of ['providerTurns', 'nativePickerInvocations', 'nativeProcessSpawns']) assert.equal(after[key], 0);
  assert.ok(after.requests.every(row => !['/chat/send', '/terminal/write', '/terminal/init'].includes(row.path)), 'No provider or terminal attempt');
  assert.ok(after.requests.filter(row => row.method !== 'GET' && row.method !== 'OPTIONS' && !row.path.startsWith('/__qa/'))
    .every(row => row.path === '/profiles/import' || row.status >= 400), 'No fake successful autosave or unrelated write');
  return true;
}

export function assertPortableImportedDraft(before, after) {
  assertPortableStoreInvariant(before, after, { imported: 1 });
  const commits = profileImports(after).filter(row => row.request?.dryRun === false);
  assert.equal(commits.length, 1); assert.equal(commits[0].status, 201);
  assert.equal(commits[0].request.textSha256, before.seed.importSha256);
  const previews = profileImports(after).filter(row => row.request?.dryRun === true && row.status === 200);
  assert.ok(previews.length >= 1); assert.ok(previews.every(row => row.request.textSha256 === before.seed.importSha256));
  const created = after.persisted.profiles.records.find(row => !before.persisted.profiles.records.some(old => old.id === row.id));
  assert.ok(created); assert.equal(created.lifecycle, 'draft'); assert.equal(created.active_revision, null);
  const body = JSON.parse(after.persisted.profiles.revisions.find(row => row.profile_id === created.id).body_json);
  assert.equal(body.instructions, previews.at(-1).response.body.instructions, 'Confirmed original preview, not a substituted import');
  assert.ok(body.instructions.includes(`${before.seed.marker}_IMPORT_ORIGINAL`));
  assert.ok(body.instructions.includes(`${before.seed.marker}_IMPORT_END`));
  return created.id;
}

export function assertPortableExportFile(state, filename, expectedText) {
  const files = state.exports.filter(file => file.name === filename);
  assert.equal(files.length, 1, 'One actual owned export file');
  assert.equal(files[0].path, `${state.exportsDir}/${filename}`);
  assert.equal(files[0].sha256, sha256(expectedText));
  assert.equal(files[0].bytes, Buffer.byteLength(expectedText));
  return files[0];
}

export function assertPortableAttachmentOmission(state, converted, ui) {
  const boardId = state.seed.boardId;
  assert.equal(converted?.method, 'GET'); assert.equal(converted?.delegated, true);
  assert.equal(converted?.path, `/v1/boards/${boardId}/export`); assert.equal(converted?.status, 200);
  assert.equal(new URLSearchParams(converted.query).get('format'), 'json-canvas');
  const head = state.persisted.desk.boards.find(row => row.board_id === boardId);
  const revision = state.persisted.desk.revisions.find(row => row.board_id === boardId && row.revision === head?.head_revision);
  const files = JSON.parse(revision.body_json).cards.filter(card => card.type === 'file');
  assert.equal(files.length, 1); assert.equal(files[0].id, 'qa-file');
  assert.equal(files[0].sourceRef.path, state.seed.importPath);
  const { canvas, report } = converted.response;
  assert.equal(report.nodes, canvas.nodes.length); assert.equal(report.edges, canvas.edges.length);
  assert.ok(Array.isArray(report.omitted));
  assert.ok(report.omitted.every(item => item && (item.id === null || typeof item.id === 'string') &&
    typeof item.kind === 'string' && typeof item.reason === 'string'));
  // report.omitted describes undrawable records (e.g. freehand), not withheld
  // attachments. A named text placeholder carries the attachment exclusion.
  const nodes = canvas.nodes.filter(node => node.id === files[0].id);
  assert.equal(nodes.length, 1, 'The original saved file has one named placeholder');
  const node = nodes[0];
  assert.deepEqual(Object.keys(node).sort(), ['id', 'x', 'y', 'width', 'height', 'type', 'text', 'egdesk'].sort());
  assert.equal(node.type, 'text');
  assert.equal(node.text, `파일 카드 · ${files[0].runtimeState.root.name}`);
  assert.deepEqual(node.egdesk, { kind: 'card', type: 'file', omitted: 'attachment' });
  assert.deepEqual(canvas.nodes.filter(row => row.egdesk?.omitted === 'attachment').map(row => row.id), [files[0].id]);
  const serialized = JSON.stringify(canvas);
  for (const excluded of [state.seed.importPath, files[0].runtimeState.root.displayPath,
    `${state.seed.marker}_IMPORT_ORIGINAL`, `${state.seed.marker}_IMPORT_END`]) {
    assert.ok(typeof excluded === 'string' && excluded.length > 0);
    assert.equal(serialized.includes(excluded), false, 'Attachment paths and original text are absent from the entire canvas');
  }
  assert.equal(ui.boardDialog?.state, 'saved');
  assert.ok(ui.boardDialog.notes.some(note => note.text === '첨부·캡처 1개의 원본은 제외하고 이름만 포함했습니다.'),
    'Visible export note must describe the actual attachment exclusion');
  return true;
}

export function assertPortablePinnedExport(beforeAdvance, after, uiBefore, uiAfter, filename) {
  const id = beforeAdvance.seed.profileId;
  for (const ui of [uiBefore, uiAfter]) {
    assert.equal(ui.target.profileId, id); assert.equal(ui.target.revision, '2');
    assert.equal(ui.target.source, 'draft'); assert.match(ui.target.text, /초안 버전 2/);
  }
  assert.equal(after.headAdvances.length, 1); assert.equal(after.headAdvances[0].revision, 3);
  assert.equal(Math.max(...after.persisted.profiles.revisions.filter(row => row.profile_id === id).map(row => row.revision)), 3);
  const latest = profileExports(after).at(-1);
  assert.equal(latest.path, `/profiles/${id}/export`);
  assert.equal(new URLSearchParams(latest.query).get('revision'), '2'); assert.equal(latest.response.revision, 2);
  assertPortableExportFile(after, filename, beforeAdvance.seed.revisions.find(row => row.revision === 2).exports.md.text);
  return true;
}

export function assertPortableNoReplay(before, samples, expectedStatus) {
  assert.ok(samples.length >= 3, 'Repeated read-only observations are required');
  for (const { state, ui } of samples) {
    assert.equal(ui.transferState, expectedStatus);
    assert.equal(state.pickerResults.length, before.pickerResults.length);
    assert.equal(profileExports(state).length, profileExports(before).length);
    assert.deepEqual(state.exports, before.exports); assert.deepEqual(state.persisted, before.persisted);
    if (expectedStatus === 'unknown') assert.ok(ui.transferButtons.every(button => button.disabled));
  }
  return true;
}

function portableFirstUseDom() {
  const api = window.__egdesk, surface = api.surface.snapshot();
  const card = surface.browserCardId ? document.getElementById(surface.browserCardId) : null;
  const fullscreen = api.state.cardFullscreen;
  // With no first-use Browser, undefined === undefined is not a match.
  // This portable flow needs no browser geometry or fullscreen restore rect.
  return { initialBrowserFocus: surface.initialBrowserFocus === true, cardId: card?.id || null,
    fullscreen: !!card?.id && !!fullscreen && fullscreen.cardId === card.id };
}
export const observePortableFirstUse = harness => chrome(harness, portableFirstUseDom);

export function assertPortableMissingHead(before, after, boardId, ui) {
  assert.match(boardId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  assert.equal(after.persisted.desk.boards.some(row => row.board_id === boardId), false);
  assert.equal(ui.boardDialog?.state, 'needs-save');
  assert.match(ui.boardDialog.statusText, /먼저.*Board.*저장/);
  assert.equal(after.pickerResults.length, before.pickerResults.length);
  assert.deepEqual(after.exports, before.exports);
  assert.ok(after.requests.some(row => row.sequence > Math.max(0, ...before.requests.map(item => item.sequence)) &&
    row.path === `/v1/boards/${boardId}` && row.method === 'GET' && row.delegated && row.status === 404),
  'Missing saved head comes from the actual Desk handler, not an injected outcome');
  assertPortableStoreInvariant(before, after);
  return true;
}

function portableUiDom() {
  const q = id => document.querySelector(`[data-testid="${id}"]`), text = node => node?.textContent || '';
  const box = node => { if (!node) return null; const r = node.getBoundingClientRect(), css = getComputedStyle(node);
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      visible: r.width > 0 && r.height > 0 && css.display !== 'none' && css.visibility === 'visible',
      scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
      scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }; };
  const api = window.__egdesk, card = document.querySelector('.egd-settings-card'), target = q('transfer-export-target');
  const status = q('transfer-status'), bd = q('board-canvas-export');
  return { width: innerWidth, height: innerHeight, settingsId: card?.id || null, settingsBox: box(card),
    settingsFullscreen: !!card && api?.state?.cardFullscreen?.cardId === card.id,
    settingsProxy: card?.querySelector('.egd-semantic-proxy') ? box(card.querySelector('.egd-semantic-proxy')) : null,
    transferState: status?.dataset.state || null, transferCode: status?.dataset.code || null, transferText: text(status),
    target: { profileId: target?.dataset.profileId || null, revision: target?.dataset.revision || null,
      source: target?.dataset.source || null, text: text(target) },
    detailId: q('settings-agent-detail')?.dataset.profileId || null,
    rows: [...document.querySelectorAll('[data-testid="settings-agent-row"]')].map(node => ({ id: node.dataset.profileId, text: text(node), lifecycle: node.dataset.lifecycle })),
    instructions: { text: text(q('import-instructions')), box: box(q('import-instructions')) },
    transferButtons: [...document.querySelectorAll('[data-testid="settings-agent-transfer"] button')].map(node => ({ id: node.dataset.testid, disabled: node.disabled })),
    contentBox: box(card?.querySelector('.egd-settings-content')),
    boardDialog: bd ? { state: bd.dataset.state, text: text(bd), statusText: text(q('board-canvas-status')),
      omitted: text(q('board-canvas-omitted')), omittedOpen: q('board-canvas-omitted')?.open === true,
      notes: [...bd.children].map((node, index) => ({ node, index })).filter(({ node }) => node.classList.contains('egd-portable-note'))
        .map(({ node, index }) => ({ selector: `[data-testid="board-canvas-export"] > :nth-child(${index + 1})`, text: text(node) })) } : null,
    boards: Object.values(api?.state?.boards?.projections || {}).map(p => ({ id: p.id, boardId: p.boardId, title: p.title, dirty: !!p.dirty,
      members: p.members.map(m => ({ id: m.viewId, sourceId: m.sourceId, present: !!document.getElementById(m.viewId) })) })),
    active: { tag: document.activeElement?.localName, id: document.activeElement?.id || null, testid: document.activeElement?.dataset.testid || null },
  };
}

function portableTextDom({ selector, needle }) {
  const nodes = [...document.querySelectorAll(selector)], node = nodes[0];
  if (nodes.length !== 1) return { count: nodes.length, text: null, fragments: [] };
  const text = node.textContent || '', fragments = [], walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let visible = !!node.isConnected && !node.closest('[hidden],[inert],[aria-hidden="true"]'), missing = 0, matches = 0;
  for (let child = walker.nextNode(); child; child = walker.nextNode()) {
    let start = needle == null ? child.data.search(/\S/) : child.data.indexOf(needle);
    if (start < 0) continue;
    const end = needle == null ? child.data.length - (child.data.match(/\s*$/)?.[0].length || 0) : start + needle.length;
    matches++; const range = document.createRange(); range.setStart(child, start); range.setEnd(child, end);
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0); range.detach?.();
    if (!rects.length) missing++;
    let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const owner = child.parentElement;
    for (let parent = owner; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), r = parent.getBoundingClientRect();
      if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0 || css.contentVisibility === 'hidden') visible = false;
      if (css.display === 'inline' || css.display === 'contents') continue;
      const sx = parent.offsetWidth ? r.width / parent.offsetWidth : 1, sy = parent.offsetHeight ? r.height / parent.offsetHeight : 1;
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
        clip.left = Math.max(clip.left, r.left + parent.clientLeft * sx);
        clip.right = Math.min(clip.right, r.left + (parent.clientLeft + parent.clientWidth) * sx);
      }
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
        clip.top = Math.max(clip.top, r.top + parent.clientTop * sy);
        clip.bottom = Math.min(clip.bottom, r.top + (parent.clientTop + parent.clientHeight) * sy);
      }
    }
    for (const r of rects) {
      const hits = [0.2, 0.5, 0.8].map(x => { const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height / 2);
        return !!hit && (hit === owner || owner.contains(hit)); });
      fragments.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, clip, hits,
        inside: r.left >= clip.left - 0.5 && r.top >= clip.top - 0.5 && r.right <= clip.right + 0.5 && r.bottom <= clip.bottom + 0.5 });
    }
  }
  return { count: 1, text, needle, matches, missing, visible, fragments };
}

function portableSettingsNavigationDom({ selector, settingsId }) {
  const cards = [...document.querySelectorAll('.egd-settings-card')].filter(node => node.id === settingsId);
  const card = cards.length === 1 ? cards[0] : null;
  const contents = card ? [...card.querySelectorAll('.egd-settings-content')] : [];
  const content = contents.length === 1 ? contents[0] : null;
  const targets = [...document.querySelectorAll(selector)], target = targets.length === 1 ? targets[0] : null;
  const rect = node => { const r = node.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const visible = node => {
    for (let n = node; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (!n.isConnected || n.hidden || n.inert || s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) return false;
    }
    return !!node && !node.closest('[aria-hidden="true"]');
  };
  const clip = node => {
    const result = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let n = node; n; n = n.parentElement) {
      const s = getComputedStyle(n), b = rect(n);
      if (s.display === 'inline' || s.display === 'contents') continue;
      const sx = n.offsetWidth ? b.width / n.offsetWidth : 1, sy = n.offsetHeight ? b.height / n.offsetHeight : 1;
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) {
        result.left = Math.max(result.left, b.left + n.clientLeft * sx);
        result.right = Math.min(result.right, b.left + (n.clientLeft + n.clientWidth) * sx);
      }
      if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) {
        result.top = Math.max(result.top, b.top + n.clientTop * sy);
        result.bottom = Math.min(result.bottom, b.top + (n.clientTop + n.clientHeight) * sy);
      }
    }
    return result;
  };
  const inside = (b, c) => b.left >= c.left && b.top >= c.top && b.right <= c.right && b.bottom <= c.bottom;
  const owns = (node, x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === node || node.contains(hit)); };
  const base = { settingsId, selector, cards: cards.length, contents: contents.length, count: targets.length,
    transferState: card?.querySelector('[data-testid="transfer-status"]')?.dataset.state || null,
    activeTestid: document.activeElement?.dataset?.testid || null, focused: target === document.activeElement };
  if (!card || !content || !target || !content.contains(target)) return { ...base, owned: false };
  const bounds = rect(content), viewport = clip(content), targetRect = rect(target), targetClip = clip(target.parentElement);
  viewport.left = Math.max(viewport.left, bounds.left); viewport.right = Math.min(viewport.right, bounds.right);
  viewport.top = Math.max(viewport.top, bounds.top); viewport.bottom = Math.min(viewport.bottom, bounds.bottom);
  const targetVisible = visible(target) && targetRect.width > 0 && targetRect.height > 0;
  const disabled = !!target.disabled || !!target.readOnly;
  const targetHits = [0.2, 0.5, 0.8].flatMap(x => [0.2, 0.5, 0.8].map(y =>
    owns(target, targetRect.left + targetRect.width * x, targetRect.top + targetRect.height * y)));
  const point = { x: Math.round(targetRect.left + targetRect.width / 2), y: Math.round(targetRect.top + targetRect.height / 2) };
  const scrollOwner = node => {
    for (let n = node; n; n = n.parentElement) {
      if (n === content) return content;
      if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;
  };
  // Settings padding is outside nested instruction scrollers. A real wheel
  // must land on this exact outer scroll owner, not the canvas or a popup.
  let wheelPoint = null;
  for (const x of [viewport.left + 12, viewport.left + 8, viewport.right - 12]) {
    for (const fraction of [0.5, 0.25, 0.75]) {
      const y = viewport.top + (viewport.bottom - viewport.top) * fraction;
      const px = Math.round(x), py = Math.round(y);
      if (px <= viewport.left + 2 || px >= viewport.right - 2 || py <= viewport.top + 2 || py >= viewport.bottom - 2) continue;
      if ([-1, 0, 1].every(dx => [-1, 0, 1].every(dy => {
        const hit = document.elementFromPoint(px + dx, py + dy);
        return !!hit && content.contains(hit) && scrollOwner(hit) === content;
      }))) { wheelPoint = { x: px, y: py }; break; }
    }
    if (wheelPoint) break;
  }
  return { ...base, owned: true, contentVisible: visible(content), targetVisible, disabled, targetRect, targetClip,
    targetReady: targetVisible && !disabled && inside(targetRect, targetClip) && targetHits.every(Boolean) && owns(target, point.x, point.y),
    point, wheelPoint, bounds, viewport, scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight };
}

export function portableObservationSources() {
  return [portableUiDom, portableTextDom, portableFirstUseDom, portableSettingsNavigationDom].map(fn => {
    const source = fn.toString(), bytes = Buffer.byteLength(source);
    assert.ok(bytes < PORTABLE_OBSERVATION_BUDGET, 'Read-only observations fit the unchanged MCP size guard');
    return { name: fn.name, source, bytes };
  });
}
export const observePortableUi = harness => chrome(harness, portableUiDom);
export const observePortableText = (harness, selector, needle = null) => chrome(harness, portableTextDom, { selector, needle });
export const observePortableSettingsNavigation = (harness, selector, settingsId) => chrome(harness, portableSettingsNavigationDom, { selector, settingsId });
export function portableTextVisible(paint, expected, needle = null) {
  return paint?.count === 1 && paint.text === expected && paint.needle === needle && paint.matches > 0 &&
    (needle == null || paint.matches === 1) && paint.missing === 0 && paint.visible && paint.fragments.length > 0 &&
    paint.fragments.every(r => r.inside && r.hits.length === 3 && r.hits.every(Boolean));
}

export async function navigatePortableSettings({ read, wheelAt, clickPoint, pause, assertDeadline, focus = false, trace = [] }) {
  let binding;
  const observe = async () => {
    assertDeadline(); const value = await read();
    assert.ok(value.owned && value.cards === 1 && value.contents === 1 && value.count === 1, 'One target in the same Settings content is required');
    assert.ok(value.contentVisible && value.targetVisible && !value.disabled, 'Settings target is unavailable');
    const next = JSON.stringify([value.settingsId, value.selector, value.transferState]);
    if (binding === undefined) binding = next;
    assert.equal(next, binding, 'Settings view changed during native navigation');
    assert.ok([value.scrollTop, value.scrollHeight, value.clientHeight].every(Number.isFinite) && value.clientHeight > 0);
    return value;
  };
  const position = value => JSON.stringify([value.targetRect, value.targetClip, value.bounds, value.viewport, value.scrollTop,
    value.scrollHeight, value.clientHeight, value.point, value.wheelPoint, value.targetReady, value.focused, value.activeTestid]);
  const settle = async (before = null, direction = 0) => {
    let previous = null, stable = 0;
    for (let sample = 0; sample < 30; sample++) {
      await pause(); const value = await observe(), next = position(value);
      const progressed = !direction || direction * (value.scrollTop - before.scrollTop) > 0.5;
      stable = progressed && next === previous ? stable + 1 : 0; previous = next;
      if (stable >= 2) return value;
    }
    throw new Error('Settings native wheel did not move and settle; no input retry or keyboard fallback');
  };
  let value = await settle();
  for (let step = 0; step <= 12; step++) {
    const fresh = await observe();
    assert.equal(position(fresh), position(value), 'Settings geometry changed before native input'); value = fresh;
    if (value.targetReady) {
      if (focus && !value.focused) {
        assert.equal(value.selector, testid('import-instructions'), 'Only the non-action instruction region may be clicked for focus');
        assertDeadline(); await clickPoint(value.point);
        trace.push({ kind: 'native-focus-point', selector: value.selector, ...value.point });
        value = await settle();
        assert.ok(value.targetReady && value.focused, 'Visible-point click did not leave focus on the instruction region');
      }
      return value;
    }
    assert.ok(step < 12, 'Settings target was not revealed within the bounded wheel budget');
    const r = value.targetRect, c = value.viewport;
    assert.ok(r.left >= c.left && r.right <= c.right && r.height + 24 <= c.bottom - c.top,
      'Target cannot fit the visible Settings scroll area');
    const delta = r.top < c.top + 12 ? r.top - c.top - 12 : r.bottom > c.bottom - 12 ? r.bottom - c.bottom + 12 : 0;
    assert.ok(delta !== 0, 'Target is covered or clipped without a safe outer-scroll route');
    const direction = Math.sign(delta), max = Math.max(0, value.scrollHeight - value.clientHeight);
    assert.ok(direction > 0 ? value.scrollTop < max - 0.5 : value.scrollTop > 0.5, 'Settings is already at its scroll boundary');
    assert.ok(value.wheelPoint && Number.isFinite(value.wheelPoint.x) && Number.isFinite(value.wheelPoint.y), 'No observed unobstructed Settings wheel point');
    const input = { ...value.wheelPoint, deltaX: 0, deltaY: direction * Math.min(240, Math.max(24, Math.ceil(Math.abs(delta)))) };
    assertDeadline(); await wheelAt(input);
    trace.push({ kind: 'native-wheel', selector: value.selector, ...input, before: value.scrollTop });
    value = await settle(value, direction);
    trace.at(-1).after = value.scrollTop;
  }
}

export async function preparePortableInstructionEdge({ edge, expectedText, readUi, readTargets, press, pause, assertDeadline }) {
  assert.ok(edge === 'Home' || edge === 'End');
  const read = async () => {
    assertDeadline();
    const ui = await readUi(), box = ui.instructions?.box;
    assert.equal(ui.transferState, 'preview');
    assert.equal(ui.instructions?.text, expectedText, 'The same original preview must remain mounted');
    assert.ok(box && [box.scrollTop, box.scrollHeight, box.clientHeight].every(Number.isFinite) && box.clientHeight > 0);
    return ui;
  };
  let ui = await read();
  assert.equal(ui.active?.testid, 'import-instructions', 'Observe native point focus before any instruction key');
  const safeRegion = async () => {
    const targets = await readTargets();
    assert.equal(targets.length, 1);
    assert.deepEqual(targetIssues(targets[0]), [], 'Instruction region must remain fully reachable, not clipped by its parent');
  };
  await safeRegion();
  ui = await read();
  assert.equal(ui.active?.testid, 'import-instructions', 'Focus changed before the instruction key');
  const atEdge = value => {
    const box = value.instructions.box, max = Math.max(0, box.scrollHeight - box.clientHeight);
    return edge === 'Home' ? box.scrollTop <= 0.5 : box.scrollTop >= max - 0.5;
  };
  const before = ui.instructions.box.scrollTop, key = atEdge(ui) ? null : edge;
  // Do not send Home/End at an already-reached edge: nested scrolling may
  // move the outer Settings region. Focus was established by a native click, so
  // omit the selector (the MCP's targeted press calls element.focus()).
  if (key) { assertDeadline(); await press(key); }
  let previous = null, stable = 0;
  for (let sample = 0; sample < 40; sample++) {
    await pause(); ui = await read();
    assert.equal(ui.active?.testid, 'import-instructions', 'Focus changed during instruction scrolling');
    const box = ui.instructions.box;
    const position = JSON.stringify([box.scrollTop, box.scrollHeight, box.clientHeight, box.left, box.top, box.width, box.height,
      ui.contentBox?.scrollTop, ui.contentBox?.clientHeight]);
    stable = atEdge(ui) && position === previous ? stable + 1 : 0;
    previous = position;
    if (stable >= 2) {
      await safeRegion();
      return { key, before, after: box.scrollTop, outerScrollTop: ui.contentBox?.scrollTop };
    }
  }
  throw new Error(`Native instruction ${edge} did not settle at its local edge; UI remains unverified`);
}

export async function runPortableTransferFlow({ harness, result, check }, { profile, deadlineMs, env = process.env }) {
  assertPortableEnvironment(env); assertBeforeDeadline(deadlineMs);
  assert.equal(typeof harness.clickPoint, 'function', 'Owned native clickPoint harness API required');
  assert.equal(typeof harness.wheelAt, 'function', 'Owned native wheelAt harness API required');
  const isolation = validateQaFixtureIsolation(profile, { env }), descriptor = isolation.files[QA_PORTABLE_PICKER_FILE].portablePickerTransform;
  check('only two fingerprinted native OS-result bodies are transformed', descriptor?.kind === 'portable-text-os-picker-results-v1' && descriptor.functions.length === 2);
  check('actual flow/view/IO-adapter modules have unchanged fingerprints', QA_PORTABLE_TRANSFER_FILES.every(name =>
    isolation.files[name]?.originalSha256 === isolation.files[name]?.transformedSha256));
  result.sourceProof = isolation.files; result.pickerTransform = descriptor;
  result.observationScripts = portableObservationSources().map(({ name, bytes }) => ({ name, bytes }));
  result.scope = { actual: ['headless native UI input', 'Profile/Board transfer flows', 'HTTP handlers', 'SQLite', 'owned Markdown read and exclusive file writes'],
    synthetic: ['native OS picker result DTO only', 'prelaunch owned Board catalog seed'],
    excluded: ['provider turns', 'OS picker interaction', 'hardware foreground', 'PTY/shell', 'production autosave'] };
  result.actions = []; result.unverified = [];
  const proof = result.portableProof = { captures: [], noReplay: [] }, token = env.EGDESK_QA_FIXTURE_TOKEN;
  const state = () => loopbackJson('/__qa/portable-transfer/state', { token, env });
  const control = body => { assertBeforeDeadline(deadlineMs); return loopbackJson('/__qa/portable-transfer/control', { method: 'POST', body, token, env }); };
  const queue = (kind, value, filename) => control({ operation: 'queue-picker', kind, result: value, ...(filename ? { filename } : {}) });
  const waitUi = predicate => waitFor(harness, observePortableUi, predicate, deadlineMs, { timeoutMs: 15000 });
  let size = { width: 1280, height: 800 };
  const safe = async selector => {
    assertBeforeDeadline(deadlineMs); await waitStableViewport(harness, size, deadlineMs);
    const targets = await observeTargets(harness, selector);
    check(`unobstructed native target ${selector}`, targets.length === 1 && targetIssues(targets[0]).length === 0,
      { count: targets.length, issues: targetIssues(targets[0]), rect: targets[0]?.rect });
    return targets[0];
  };
  const click = async (selector, label) => {
    const observed = await safe(selector), fresh = await observeTargets(harness, selector);
    assert.equal(fresh.length, 1); assert.deepEqual(targetIssues(fresh[0]), []);
    assert.deepEqual(fresh[0].rect, observed.rect, 'Native click geometry changed after hit testing');
    const point = { x: Math.round(fresh[0].rect.x + fresh[0].rect.width / 2), y: Math.round(fresh[0].rect.y + fresh[0].rect.height / 2) };
    assertBeforeDeadline(deadlineMs); await harness.clickPoint(point);
    result.actions.push({ kind: 'native-click-point', selector, label, ...point, at: Date.now() });
    await waitStableViewport(harness, size, deadlineMs);
  };
  const key = async (value, selector) => {
    assertBeforeDeadline(deadlineMs); await harness.press(value, selector);
    result.actions.push({ kind: 'native-key', key: value, selector, at: Date.now() });
  };
  // Settings navigation never cycles through unrelated focus targets. Wheel
  // points belong to the observed outer scroller, followed by fresh geometry.
  const reach = async (selector, { focus = false } = {}) => {
    const settingsId = (await observePortableUi(harness)).settingsId;
    assert.ok(settingsId, 'Existing Settings card required for native scrolling');
    return navigatePortableSettings({ read: () => observePortableSettingsNavigation(harness, selector, settingsId),
      wheelAt: input => harness.wheelAt(input), clickPoint: point => harness.clickPoint(point),
      pause: () => new Promise(resolve => setTimeout(resolve, 75)), assertDeadline: () => assertBeforeDeadline(deadlineMs),
      focus, trace: result.actions });
  };
  const capture = async (stage, subjects, observation) => {
    const paints = [];
    for (const { selector, text, needle = null } of subjects) {
      const paint = await observePortableText(harness, selector, needle); paints.push(paint);
      check(`fully painted, clipped/occlusion-checked text: ${stage}`, portableTextVisible(paint, text, needle), paint);
    }
    const shot = { stage, ...await captureHeadlessScreenshot(harness, `portable-${stage}`, deadlineMs),
      subjectsVisible: true, paints, observation };
    check('actual owned headless screenshot captured; visual review remains pending', shot.status === 'captured' && shot.visualPass === null);
    result.screenshots.push(shot); proof.captures.push(shot); return shot;
  };
  const captureStatus = async stage => {
    // Reveal the text being proved, not a nearby button that can be visible
    // while this notice is still clipped below the Settings viewport.
    await reach(testid('transfer-status'));
    const ui = await observePortableUi(harness);
    return capture(stage, [{ selector: testid('transfer-status'), text: ui.transferText }], ui);
  };
  const noReplay = async expectedStatus => {
    const before = await state(), samples = [];
    for (let i = 0; i < 4; i++) {
      assertBeforeDeadline(deadlineMs); await new Promise(resolve => setTimeout(resolve, 250));
      samples.push({ state: await state(), ui: await observePortableUi(harness) });
    }
    check(`no automatic replay after ${expectedStatus}`, assertPortableNoReplay(before, samples, expectedStatus));
    proof.noReplay.push({ expectedStatus, before, samples });
  };
  const guard = await observeGuard(harness);
  check('owned headless Firefox chrome and no signed-in account', harness.profile === profile && harness.marionettePort === 2829 &&
    guard.headless && guard.mounted && !guard.loggedIn && !guard.accountBound && guard.documentURI === 'chrome://browser/content/browser.xhtml', guard);
  proof.initial = await state();
  check('prelaunch Board catalog was checked against actual SQLite', proof.initial.profile === profile &&
    proof.initial.catalogSeed?.coherentBeforeLaunch && proof.initial.catalogSeed.sqliteRevision === 1 && proof.initial.exports.length === 0 &&
    proof.initial.pickerResults.length === 0 && proof.initial.headAdvances.length === 0, proof.initial.catalogSeed);
  await resizeHeadless(harness, size, deadlineMs); await waitStableViewport(harness, size, deadlineMs);
  const first = await observePortableFirstUse(harness);
  if (first.initialBrowserFocus || first.fullscreen) {
    await key('meta+-'); await waitFor(harness, observePortableFirstUse, ui => !ui.initialBrowserFocus && !ui.fullscreen, deadlineMs);
  }

  // The catalog seed is setup only. Selection, menu and export below are UI.
  const boardId = proof.initial.seed.boardId, boardTitle = proof.initial.persisted.desk.boards[0].title;
  const openBoard = async title => {
    await click('.egd-rail-switcher[aria-label="Board 목록"]', 'open Board catalog');
    await click(`[data-testid="board-open"][aria-label=${JSON.stringify(`Board ${title} 열기`)}] > .egd-agenda-switch-row-main > .egd-agenda-switch-row-title`, 'native Board primary title');
  };
  await openBoard(boardTitle);
  let ui = await waitUi(value => value.boards.some(board => board.boardId === boardId));
  const projection = ui.boards.find(board => board.boardId === boardId);
  const boardMenu = `${selectorForId(projection.id)} ${testid('board-menu')}`;
  let boardMenuCapture = 0;
  const openExport = async () => {
    await click(boardMenu, 'actual Board menu');
    const menuText = await observePortableText(harness, testid('board-export-json-canvas'));
    check('visible command explicitly exports the saved Board', portableTextVisible(menuText, '저장본을 .canvas로 내보내기…'));
    await capture(`stored-board-menu-${++boardMenuCapture}`, [{ selector: testid('board-export-json-canvas'), text: menuText.text }], await observePortableUi(harness));
    await click(testid('board-export-json-canvas'), 'export actual saved Board');
  };
  await queue('save', 'cancel'); await openExport();
  ui = await waitUi(value => value.boardDialog?.state === 'cancelled');
  await capture('board-picker-cancel', [{ selector: testid('board-canvas-status'), text: ui.boardDialog.statusText }], ui);
  check('Board picker cancel writes no file', (await state()).exports.length === 0);
  await click(testid('board-canvas-close'), 'close cancelled Board export');
  // Closing one actual member is a native unsaved edit; stored SQLite stays 1.
  const member = projection.members.find(row => row.sourceId === 'qa-file');
  if (member) {
    const closeSelector = `${selectorForId(member.id)} .egd-card-dot-close`, targets = await observeTargets(harness, closeSelector);
    if (targets.length === 1 && targetIssues(targets[0]).length === 0) {
      await click(closeSelector, 'native close of owned Board member creates unsaved draft');
      proof.unsavedBoard = await waitUi(value => value.boards.find(board => board.boardId === boardId)?.dirty === true);
    } else result.unverified.push({ behavior: 'stored Board plus unsaved draft', reason: 'native member close target not reachable; no DOM or geometry mutation', targets });
  }
  await queue('save', 'path', 'owned-board.canvas'); await openExport();
  ui = await waitUi(value => value.boardDialog?.state === 'saved');
  if (ui.boardDialog.omitted) {
    await click(`${testid('board-canvas-omitted')} > summary`, 'expand actual conversion omissions');
    ui = await waitUi(value => value.boardDialog?.omittedOpen === true);
  }
  await capture('board-saved-omissions', [{ selector: testid('board-canvas-status'), text: ui.boardDialog.statusText },
    ...ui.boardDialog.notes,
    ...(ui.boardDialog.omitted ? [{ selector: testid('board-canvas-omitted'), text: ui.boardDialog.omitted }] : [])], ui);
  proof.boardSaved = await state();
  const converted = proof.boardSaved.requests.filter(row => row.path === `/v1/boards/${boardId}/export` && row.status === 200).at(-1);
  check('actual .canvas bytes equal real saved-head conversion', !!assertPortableExportFile(proof.boardSaved, 'owned-board.canvas', `${JSON.stringify(converted.response.canvas, null, 2)}\n`));
  check('stored Board revision is unchanged after export', assertPortableStoreInvariant(proof.initial, proof.boardSaved));
  check('file attachment omission is verified by the real converter placeholder and visible note',
    assertPortableAttachmentOmission(proof.boardSaved, converted, ui));
  check('export visibly excludes unsaved changes and never autosaves', ui.boardDialog.notes.some(note => /미저장/.test(note.text)));
  await click(testid('board-canvas-close'), 'close saved Board export');
  // A new local Board is made through the normal UI. Its real store write is
  // refused by this read-only fixture, so the later missing-head read is real.
  // Do not call its local "saved" notice proof of a saved SQLite revision.
  proof.beforeMissingHead = await state();
  const missingTitle = 'Owned QA Board without SQLite saved head';
  await click('.egd-rail-switcher[aria-label="Board 목록"]', 'native new local Board for missing-head case');
  await click('button[aria-label="새 Board"]', 'new Board');
  const nameInput = '#egd-board-scope input[aria-label="Board 이름"]';
  await click(nameInput, 'name owned unsaved-to-SQLite Board');
  assertBeforeDeadline(deadlineMs); await harness.typeText(missingTitle, { selector: nameInput });
  result.actions.push({ kind: 'native-type', selector: nameInput, value: missingTitle, at: Date.now() });
  await click('#egd-board-scope button[aria-label="빈 Board 저장"]', 'local Board creation; actual helper autosave remains refused');
  if (await chrome(harness, () => !!document.getElementById('egd-agenda-switcher'))) {
    await click('.egd-rail-switcher[aria-label="Board 목록"]', 'close preexisting Board catalog');
  }
  const notice = await chrome(harness, () => document.getElementById('egd-board-notice')?.textContent || null);
  if (notice) {
    proof.localOnlyBoardNotice = notice;
    await click('#egd-board-notice button[aria-label="안내 닫기"]', 'dismiss owned local Board notice, not SQLite-success evidence');
  }
  await openBoard(missingTitle);
  ui = await waitUi(value => value.boards.some(board => board.title === missingTitle));
  const missingBoard = ui.boards.find(board => board.title === missingTitle);
  await click(`${selectorForId(missingBoard.id)} ${testid('board-menu')}`, 'native no-head Board menu');
  await click(testid('board-export-json-canvas'), 'request actual missing saved head');
  ui = await waitUi(value => value.boardDialog?.state === 'needs-save');
  await capture('board-no-saved-head-reason', [{ selector: testid('board-canvas-status'), text: ui.boardDialog.statusText }], ui);
  proof.missingHead = { boardId: missingBoard.boardId, ui, after: await state() };
  check('no saved-head reason comes from actual read with no picker or file write', assertPortableMissingHead(
    proof.beforeMissingHead, proof.missingHead.after, missingBoard.boardId, ui));
  await click(testid('board-canvas-close'), 'close missing-head reason');

  await click('#egd-dock .egd-dock-btn[data-id="settings"]', 'native Settings Dock');
  ui = await waitUi(value => !!value.settingsId);
  if (ui.settingsProxy?.visible) await click(`${selectorForId(ui.settingsId)} > .egd-semantic-proxy`, 'native Settings summary focus');
  await click(`${selectorForId(ui.settingsId)} .egd-card-dot-max`, 'native Settings maximize for readable transfer review');
  await waitUi(value => value.settingsFullscreen);
  await click(testid('settings-tab-agents'), 'native Agent tab');
  await waitUi(value => value.rows.some(row => row.id === proof.initial.seed.profileId));
  await reach(testid('settings-agent-import'));
  await queue('open', 'cancel'); await click(testid('settings-agent-import'), 'cancel native file result');
  await waitUi(value => value.transferState === 'cancelled');
  check('cancel before selection makes no import request', profileImports(await state()).length === 0);
  await captureStatus('profile-open-cancel');

  const preview = async () => {
    await reach(testid('settings-agent-import')); await queue('open', 'input');
    await click(testid('settings-agent-import'), 'select actual owned Markdown');
    return waitUi(value => value.transferState === 'preview');
  };
  await preview();
  await reach(testid('import-instructions'), { focus: true });
  const instructions = (await observePortableUi(harness)).instructions.text;
  check('preview retains first and last original instructions', instructions.includes(`${proof.initial.seed.marker}_IMPORT_ORIGINAL`) && instructions.includes(`${proof.initial.seed.marker}_IMPORT_END`));
  const instructionEdge = edge => preparePortableInstructionEdge({ edge, expectedText: instructions,
    readUi: () => observePortableUi(harness), readTargets: () => observeTargets(harness, testid('import-instructions')),
    press: value => key(value), pause: () => new Promise(resolve => setTimeout(resolve, 75)),
    assertDeadline: () => assertBeforeDeadline(deadlineMs) });
  proof.instructionScroll = { first: await instructionEdge('Home') };
  await waitFor(harness, () => observePortableText(harness, testid('import-instructions'), `${proof.initial.seed.marker}_IMPORT_ORIGINAL`),
    paint => portableTextVisible(paint, instructions, `${proof.initial.seed.marker}_IMPORT_ORIGINAL`), deadlineMs);
  await capture('import-instruction-first', [{ selector: testid('import-instructions'), text: instructions, needle: `${proof.initial.seed.marker}_IMPORT_ORIGINAL` }], await observePortableUi(harness));
  proof.instructionScroll.last = await instructionEdge('End');
  await waitFor(harness, () => observePortableText(harness, testid('import-instructions'), `${proof.initial.seed.marker}_IMPORT_END`),
    paint => portableTextVisible(paint, instructions, `${proof.initial.seed.marker}_IMPORT_END`), deadlineMs);
  await capture('import-instruction-end', [{ selector: testid('import-instructions'), text: instructions, needle: `${proof.initial.seed.marker}_IMPORT_END` }], await observePortableUi(harness));
  await reach(testid('settings-agent-import-confirm'));
  await safe(testid('settings-agent-import-confirm'));
  await reach(testid('transfer-cancel'));
  await capture('import-cancel-reachable', [{ selector: testid('transfer-cancel'), text: '가져오기 취소' }], await observePortableUi(harness));
  await click(testid('transfer-cancel'), 'cancel preview without persisting');
  await waitUi(value => value.transferState === 'cancelled');
  check('preview cancel creates zero profiles', assertPortableStoreInvariant(proof.initial, await state()));
  await preview(); await reach(testid('settings-agent-import-confirm'));
  await capture('import-confirm-reachable', [{ selector: testid('settings-agent-import-confirm'), text: '초안 가져오기' }], await observePortableUi(harness));
  await click(testid('settings-agent-import-confirm'), 'confirm exactly one original draft');
  await waitUi(value => value.transferState === 'imported');
  proof.imported = await state(); proof.importedId = assertPortableImportedDraft(proof.initial, proof.imported);
  check('exactly one real inactive imported draft', !!proof.importedId);
  await captureStatus('imported-draft');

  const row = `${testid('settings-agent-row')}[data-profile-id=${JSON.stringify(proof.initial.seed.profileId)}]`;
  await reach(row); await click(row, 'open actual current saved profile revision');
  const selectedVersion = await waitUi(value => value.detailId === proof.initial.seed.profileId &&
    value.target.profileId === proof.initial.seed.profileId && value.target.revision === '2');
  await reach(testid('transfer-export-target'));
  ui = await observePortableUi(harness);
  assert.equal(ui.detailId, selectedVersion.detailId, 'Revealing the version notice must preserve the selected profile');
  assert.deepEqual(ui.target, selectedVersion.target, 'Revealing the version notice must preserve the original export target');
  await capture('profile-visible-draft-version-2', [{ selector: testid('transfer-export-target'), text: ui.target.text }], ui);
  const exportProfile = async (format, selection, filename, expectedState) => {
    const selector = testid(format === 'md' ? 'settings-agent-export-md' : 'settings-agent-export-toml');
    await reach(selector); await queue('save', selection, filename); await click(selector, `native ${format} export ${selection}`);
    return waitUi(value => value.transferState === expectedState);
  };
  const exportsBeforeCancel = (await state()).exports;
  await exportProfile('md', 'cancel', null, 'cancelled'); await captureStatus('profile-save-cancel');
  check('save dialog cancel leaves actual files unchanged', JSON.stringify((await state()).exports) === JSON.stringify(exportsBeforeCancel));
  for (const [format, filename] of [['md', 'owned-agent.md'], ['codex-toml', 'owned-agent.toml']]) {
    await exportProfile(format, 'path', filename, 'saved');
    const after = await state(); check(`actual pinned ${format} output bytes`, !!assertPortableExportFile(after, filename, proof.initial.seed.revisions[1].exports[format].text));
    await captureStatus(`profile-${format}-saved`);
  }
  const originalFiles = (await state()).exports;
  await exportProfile('md', 'replace', 'owned-agent.md', 'failed');
  ui = await observePortableUi(harness); check('OS replace refusal remains explicit', ui.transferCode === 'TEXT_FILE_EXISTS');
  await captureStatus('profile-existing-filename-refused');
  check('existing filename was not overwritten', JSON.stringify((await state()).exports) === JSON.stringify(originalFiles));
  await noReplay('failed');

  proof.beforeAdvance = await state(); proof.visibleBeforeAdvance = await observePortableUi(harness);
  await control({ operation: 'advance-profile-head', expectedHeadRevision: 2 });
  proof.visibleAfterAdvance = await observePortableUi(harness);
  check('new SQLite head does not silently replace the visible old version', JSON.stringify(proof.visibleAfterAdvance.target) === JSON.stringify(proof.visibleBeforeAdvance.target));
  await reach(testid('transfer-export-target'));
  ui = await observePortableUi(harness);
  assert.deepEqual(ui.target, proof.visibleAfterAdvance.target, 'Revealing the version notice must preserve the original export target');
  await capture('visible-version-2-with-stored-head-3', [{ selector: testid('transfer-export-target'), text: ui.target.text }], ui);
  await exportProfile('md', 'path', 'owned-pinned-v2.md', 'saved');
  check('native export remains pinned to displayed v2 while real head is v3', assertPortablePinnedExport(proof.beforeAdvance, await state(),
    proof.visibleBeforeAdvance, await observePortableUi(harness), 'owned-pinned-v2.md'));
  // The owned file was already made through actual UI. A confirmed path DTO
  // now exercises the REAL exclusive-create collision after beginWrite.
  await exportProfile('md', 'path', 'owned-agent.md', 'unknown');
  await captureStatus('profile-write-unknown-no-retry');
  await noReplay('unknown');
  proof.final = await state();
  check('stored data and authority remain bounded', assertPortableStoreInvariant(proof.initial, proof.final, { imported: 1, headAdvanced: true }));
  check('actual collision preserves the existing bytes', !!assertPortableExportFile(proof.final, 'owned-agent.md', proof.initial.seed.revisions[1].exports.md.text));
  const common = await loopbackJson('/__qa/state', { token, env });
  check('providerTurns 0; no send/auth/terminal attempts', common.providerTurns === 0 && common.observed.sends.length === 0 && common.observed.authWrites.length === 0 && common.runs.length === 0);
  result.providerTurns = 0; result.nativePickerInvocations = 0; result.nativeProcessSpawns = 0;
  result.actualUiAndOwnedStorageVerified = true;
  result.visualReview = 'pending-first-person-review';
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv); assertPortableEnvironment(env);
  return runUiFlow('portable-transfer', context => runPortableTransferFlow(context, { ...options, env }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runCli();
