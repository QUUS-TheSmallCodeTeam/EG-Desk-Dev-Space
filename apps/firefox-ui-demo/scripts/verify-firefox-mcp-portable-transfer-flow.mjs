// Attach-only. Main starts the owned headless Firefox and fixture listener.
// Native UI -> real flow/HTTP/SQLite -> real owned file IO. Only OS selection
// results and one explicitly recorded malformed duplicate receipt are synthetic.
// No DOM outcomes, SQLite creations or IO receipts are replaced.
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
const profileDuplicates = state => state.requests.filter(row => row.method === 'POST' && /^\/profiles\/[^/]+\/duplicate$/.test(row.path));
const deskAutosave = row => row.method === 'PUT' && row.path === '/v1/desk/current';
const nonDeskWrites = state => state.requests.filter(row => row.method !== 'GET' && !row.path.startsWith('/__qa/') && !deskAutosave(row));
export const PORTABLE_DUPLICATE_NOTICE = '복제한 새 초안을 만들었습니다. 원본은 그대로이며, 아직 사용하거나 대화방에 배정하지 않았습니다.';
export const PORTABLE_DUPLICATE_UNKNOWN_NOTICE = '복제 결과를 확인하지 못했습니다. Agent 목록에서 사본을 확인해 주세요. 이 설정 창에서는 같은 버전을 다시 복제하지 않습니다. 자동으로 다시 시도하지 않습니다.';
export const PORTABLE_OBSERVATION_BUDGET = 12 * 1024;

export function assertPortableEnvironment(env = process.env) {
  assert.equal(portableTransferFixtureEnabled(env), true);
  assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16,
    'Canonical EGDESK_QA_FIXTURE_TOKEN required');
  return true;
}

export function assertPortableStoreInvariant(before, after, { imported = 0, headAdvanced = false, duplicated = 0 } = {}) {
  assert.ok(duplicated === 0 || duplicated === 1);
  assert.equal(after.profile, before.profile); assert.equal(after.root, before.root);
  assert.deepEqual(after.catalogSeed, before.catalogSeed);
  assert.equal(after.catalogSeed.coherentBeforeLaunch, true); assert.equal(after.catalogSeed.setupOnly, true);
  assert.deepEqual(after.persisted.desk, before.persisted.desk, 'UI exports never save the current draft or alter saved Board/Desk revisions');
  assert.equal(after.currentImportSha256, before.seed.importSha256);
  const records = after.persisted.profiles.records;
  assert.equal(records.length, before.persisted.profiles.records.length + imported + duplicated);
  assert.ok(records.every(row => row.active_revision === null && row.lifecycle === 'draft'), 'No activation or assignment');
  for (const row of before.persisted.profiles.revisions) {
    assert.deepEqual(after.persisted.profiles.revisions.find(next => next.profile_id === row.profile_id && next.revision === row.revision), row);
  }
  const headDelta = Number(headAdvanced) - before.headAdvances.length;
  assert.ok(headDelta === 0 || headDelta === 1);
  assert.equal(after.persisted.profiles.revisions.length, before.persisted.profiles.revisions.length + imported + headDelta + duplicated);
  assert.equal(profileDuplicates(after).length, duplicated);
  assert.equal(after.duplicateEvents?.length || 0, duplicated);
  assert.equal(after.headAdvances.length, Number(headAdvanced));
  for (const key of ['providerTurns', 'nativePickerInvocations', 'nativeProcessSpawns']) assert.equal(after[key], 0);
  assert.ok(after.requests.every(row => !['/chat/send', '/terminal/write', '/terminal/init'].includes(row.path)), 'No provider or terminal attempt');
  assert.ok(after.requests.filter(row => row.method !== 'GET' && row.method !== 'OPTIONS' && !row.path.startsWith('/__qa/'))
    .every(row => row.path === '/profiles/import' || row.status >= 400 || duplicated === 1 && row.method === 'POST' &&
      row.path === `/profiles/${before.seed.profileId}/duplicate` && row.delegated && row.status === 201 &&
      JSON.stringify(row.request) === JSON.stringify({ revision: 2 })), 'No fake successful autosave or unrelated write');
  return true;
}

export function assertPortableDuplicateReady(state, ui) {
  assert.equal(profileDuplicates(state).length, 0, 'No duplicate POST before the explicit native click');
  assert.deepEqual(state.duplicateEvents, []);
  const id = state.seed.profileId;
  assert.equal(ui.detailCount, 1);
  assert.equal(ui.detailId, id); assert.equal(ui.detailRevision, '2'); assert.equal(ui.detailLifecycle, 'draft');
  assert.equal(ui.target.profileId, id); assert.equal(ui.target.revision, '2'); assert.equal(ui.target.source, 'draft');
  assert.match(ui.target.text, /초안 버전 2/);
  assert.deepEqual(ui.duplicate, { count: 1, profileId: id, revision: '2', state: 'idle', disabled: false });
  assert.equal(ui.transferState, 'unknown', 'R7 unknown/no-replay remains completed before independent duplication');
  assert.ok(ui.transferButtons.length > 0 && ui.transferButtons.every(button => button.disabled));
  assert.ok(Array.isArray(ui.roomAssignments));
  assert.equal(Math.max(...state.persisted.profiles.revisions.filter(row => row.profile_id === id).map(row => row.revision)), 3);
  assert.equal(state.headAdvances.length, 1); assert.equal(state.headAdvances[0].revision, 3);
  return true;
}

export function assertPortableDuplicateUi(before, after, id) {
  assert.notEqual(id, before.detailId);
  assert.equal(after.detailCount, 1);
  assert.equal(after.detailId, id); assert.equal(after.detailRevision, '1'); assert.equal(after.detailLifecycle, 'draft');
  assert.equal(after.target.profileId, id); assert.equal(after.target.revision, '1'); assert.equal(after.target.source, 'draft');
  assert.match(after.target.text, /초안 버전 1/);
  assert.equal(after.agentNotice, PORTABLE_DUPLICATE_NOTICE);
  assert.equal(after.duplicate.count, 1); assert.equal(after.duplicate.profileId, id);
  assert.equal(after.duplicate.revision, '1'); assert.equal(after.duplicate.state, 'idle');
  assert.deepEqual(after.roomAssignments, before.roomAssignments, 'Creating a draft must not assign it to any room');
  assert.equal(after.activeThreadId, before.activeThreadId);
  return true;
}

export function assertPortableRejectedDeskAutosaves(before, after) {
  assert.equal(after.profile, before.profile); assert.equal(after.root, before.root);
  assert.deepEqual(after.persisted.desk, before.persisted.desk, 'Rejected Desk autosaves cannot change the stored Desk or Board');
  // Settings rendering triggers the existing Desk MutationObserver. Exclude
  // only its exact, non-delegated rejection, never every failed write. The
  // fixture rejects this route before invoking a store or reading its body.
  for (const state of [before, after]) for (const row of state.requests.filter(deskAutosave)) {
    assert.ok(Number.isSafeInteger(row.sequence) && row.sequence > 0);
    assert.deepEqual(row, { sequence: row.sequence, method: 'PUT', path: '/v1/desk/current', query: '',
      delegated: false, status: 403, code: 'QA_PORTABLE_ROUTE_BLOCKED' }, 'Only the exact refused Desk autosave is separate from profile writes');
  }
  const previous = before.requests.filter(deskAutosave), current = after.requests.filter(deskAutosave);
  assert.deepEqual(current.slice(0, previous.length), previous, 'Earlier rejected Desk attempts remain unchanged in the trace');
  let sequence = Math.max(0, ...before.requests.map(row => row.sequence));
  for (const row of current.slice(previous.length)) {
    assert.ok(row.sequence > sequence, 'Extra rejected Desk attempts must be new ordered requests');
    sequence = row.sequence;
  }
  return true;
}

export function assertPortableDuplicatedDraft(before, after, uiBefore, uiAfter) {
  assertPortableDuplicateReady(before, uiBefore);
  assertPortableStoreInvariant(before, after, { headAdvanced: true, duplicated: 1 });
  const calls = profileDuplicates(after); assert.equal(calls.length, 1);
  const call = calls[0], sourceId = before.seed.profileId, source = before.seed.revisions.find(row => row.revision === 2);
  assert.equal(call.path, `/profiles/${sourceId}/duplicate`); assert.equal(call.query, '');
  assert.equal(call.delegated, true); assert.equal(call.status, 201); assert.equal(call.requestTruncated, false);
  assert.deepEqual(call.request, { revision: 2 });
  assert.equal(call.requestSha256, sha256(JSON.stringify({ revision: 2 })));
  assert.deepEqual(call.before, before.persisted); assert.deepEqual(call.after, after.persisted);
  assertPortableRejectedDeskAutosaves(before, after);
  assert.deepEqual(nonDeskWrites(after), [...nonDeskWrites(before), call],
    'Only the explicit duplicate accompanies separately verified rejected Desk autosaves; no activation, assignment or other write');
  const original = before.persisted.profiles.records.find(row => row.id === sourceId);
  for (const record of before.persisted.profiles.records) {
    assert.deepEqual(after.persisted.profiles.records.find(row => row.id === record.id), record, 'Original/imported profiles stay unchanged');
  }
  const copies = after.persisted.profiles.records.filter(row => !before.persisted.profiles.records.some(old => old.id === row.id));
  assert.equal(copies.length, 1); const copy = copies[0];
  assert.equal(copy.lifecycle, 'draft'); assert.equal(copy.active_revision, null); assert.equal(copy.origin, 'user');
  const revisions = after.persisted.profiles.revisions.filter(row => row.profile_id === copy.id);
  assert.equal(revisions.length, 1); const revision = revisions[0];
  assert.equal(revision.revision, 1); assert.equal(revision.parent_revision, null);
  const body = JSON.parse(revision.body_json);
  assert.deepEqual(body, { ...source.body, name: `${source.body.name} 사본` }, 'Copy the entire displayed v2 body, never head v3');
  assert.equal(revision.hash, sha256(revision.body_json));
  const provenance = JSON.parse(copy.source_json), entry = provenance.at(-1);
  assert.deepEqual(provenance.slice(0, -1), JSON.parse(original.source_json));
  assert.ok(Number.isSafeInteger(entry.at));
  assert.deepEqual(entry, { kind: 'duplicate', origin: original.origin, profileId: sourceId,
    revision: 2, hash: source.hash, name: source.body.name, at: entry.at });
  const receipt = call.response;
  assert.equal(receipt.id, copy.id); assert.equal(receipt.revision, 1); assert.equal(receipt.hash, revision.hash);
  assert.equal(receipt.profile.id, copy.id); assert.equal(receipt.profile.lifecycle, 'draft');
  assert.equal(receipt.profile.activeRevision, null); assert.equal(receipt.profile.active, null);
  assert.equal(receipt.profile.headRevision, 1); assert.equal(receipt.profile.head.revision, 1);
  assert.deepEqual(receipt.profile.head.body, body); assert.deepEqual(receipt.profile.source, provenance);
  assert.deepEqual(after.duplicateEvents, [{ sequence: call.sequence, sourceProfileId: sourceId, sourceRevision: 2,
    sourceHash: source.hash, profileId: copy.id, revision: 1, hash: revision.hash, name: body.name, lifecycle: 'draft', activeRevision: null }]);
  for (const key of ['exports', 'pickerResults', 'headAdvances', 'forbiddenPosts']) assert.deepEqual(after[key], before[key]);
  assertPortableDuplicateUi(uiBefore, uiAfter, copy.id);
  return copy.id;
}

export function assertPortableDuplicateNoReplay(before, samples, uiBefore, id) {
  assert.ok(samples.length >= 3);
  for (const { state, ui } of samples) {
    assert.deepEqual(state.persisted, before.persisted); assert.deepEqual(state.exports, before.exports);
    assert.deepEqual(profileDuplicates(state), profileDuplicates(before));
    assert.deepEqual(state.duplicateEvents, before.duplicateEvents);
    assert.deepEqual(state.pickerResults, before.pickerResults); assert.deepEqual(state.forbiddenPosts, before.forbiddenPosts);
    assertPortableRejectedDeskAutosaves(before, state);
    assert.deepEqual(nonDeskWrites(state), nonDeskWrites(before), 'No additional duplicate, activation, import, assignment or other write request');
    assertPortableDuplicateUi(uiBefore, ui, id);
  }
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
  const detail = q('settings-agent-detail'), duplicate = q('settings-agent-duplicate');
  const form = q('settings-agent-form'), save = q('settings-agent-save'), actions = form?.querySelector('.egd-settings-form-actions');
  const content = card?.querySelector('.egd-settings-content'), contentBox = box(content), actionsBox = box(actions);
  const scaleY = content?.offsetHeight > 0 ? contentBox.height / content.offsetHeight : null;
  const contentViewport = content && scaleY > 0 ? {
    top: contentBox.top + content.clientTop * scaleY,
    bottom: contentBox.top + (content.clientTop + content.clientHeight) * scaleY,
    clientHeight: content.clientHeight, scrollHeight: content.scrollHeight, scrollTop: content.scrollTop,
  } : null;
  const all = (node, selector) => [...(node?.querySelectorAll(selector) || [])];
  const control = node => node ? { id: node.id, testid: node.dataset.testid, index: node.dataset.index ?? null,
    field: node.dataset.field ?? null, value: node.value.slice(0, 512), length: node.value.length,
    truncated: node.value.length > 512, disabled: !!node.disabled, readOnly: !!node.readOnly,
    focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd } : null;
  const ownText = node => [...(node?.childNodes || [])].filter(part => part.nodeType === 3).map(part => part.textContent).join('');
  const exampleRows = all(form, '[data-testid="settings-agent-example-row"]'), avoidRows = all(form, '[data-testid="settings-agent-avoid-row"]');
  return { width: innerWidth, height: innerHeight, settingsId: card?.id || null, settingsBox: box(card),
    settingsFullscreen: !!card && api?.state?.cardFullscreen?.cardId === card.id,
    settingsProxy: card?.querySelector('.egd-semantic-proxy') ? box(card.querySelector('.egd-semantic-proxy')) : null,
    transferState: status?.dataset.state || null, transferCode: status?.dataset.code || null, transferText: text(status),
    target: { profileId: target?.dataset.profileId || null, revision: target?.dataset.revision || null,
      source: target?.dataset.source || null, text: text(target) },
    detailId: q('settings-agent-detail')?.dataset.profileId || null,
    detailCount: document.querySelectorAll('[data-testid="settings-agent-detail"]').length,
    detailRevision: detail?.dataset.revision || null, detailLifecycle: detail?.dataset.lifecycle || null,
    detailPersonality: {
      examples: all(q('settings-agent-detail-examples'), 'li').slice(0, 4).map(row => ({ user: ownText(row.children[0]), reply: ownText(row.children[1]) })),
      avoid: all(q('settings-agent-detail-avoid'), 'li').slice(0, 9).map(text),
    },
    editor: form ? { count: all(document, '[data-testid="settings-agent-form"]').length,
      owned: form.closest('.egd-settings-card') === card,
      // Current product exposes neither private closure field on the form.
      // Null is unknown, not a fabricated ID/revision: entry GET/detail and
      // the eventual actual PUT establish that binding separately.
      profileId: form.dataset.profileId ?? null, baseRevision: form.dataset.baseRevision ?? null,
      busy: save?.disabled ?? null, busySource: 'save.disabled', errors: text(q('settings-agent-errors')),
      fieldErrors: all(form, '.egd-settings-field-invalid').map(node => ({ field: node.dataset.field, text: text(node.querySelector('.egd-settings-field-error')) })),
      exampleCount: exampleRows.length, avoidCount: avoidRows.length,
      examples: exampleRows.slice(0, 4).map(row => ({ index: row.dataset.index,
        user: control(row.querySelector('[data-testid="settings-agent-example-user"]')),
        reply: control(row.querySelector('[data-testid="settings-agent-example-reply"]')) })),
      avoid: avoidRows.slice(0, 9).map(row => ({ index: row.dataset.index, text: control(row.querySelector('[data-testid="settings-agent-avoid-text"]')) })),
      chips: Object.fromEntries(['traits', 'expertise', 'toolPreferences'].map(field => [field, {
        input: control(form.querySelector(`[data-testid="settings-agent-chip-input"][data-field="${field}"]`)),
        values: all(form.querySelector(`.egd-settings-field[data-field="${field}"]`), '.egd-settings-chip').map(ownText),
      }])),
      tone: form.querySelector('[data-field="tone"] [aria-pressed="true"]')?.id || null,
      actions: { position: actions ? getComputedStyle(actions).position : null, box: actionsBox, contentViewport,
        save: box(save), cancel: box(q('settings-agent-cancel')) },
    } : null,
    agentNotice: text(q('settings-agent-notice')),
    duplicate: { count: document.querySelectorAll('[data-testid="settings-agent-duplicate"]').length,
      profileId: duplicate?.dataset.profileId || null, revision: duplicate?.dataset.revision || null,
      state: duplicate?.dataset.state || null, disabled: duplicate?.disabled ?? true },
    activeThreadId: api?.state?.codex?.activeThreadId || null,
    roomAssignments: (api?.state?.codex?.threads || []).map(thread => ({ id: thread.id,
      agentProfileId: thread.agentProfileId ?? null, profileEnabled: thread.profileEnabled ?? null,
      conversationId: thread.conversationId ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
    rows: [...document.querySelectorAll('[data-testid="settings-agent-row"]')].map(node => ({ id: node.dataset.profileId, text: text(node), lifecycle: node.dataset.lifecycle })),
    instructions: { text: text(q('import-instructions')), box: box(q('import-instructions')) },
    transferButtons: [...document.querySelectorAll('[data-testid="settings-agent-transfer"] button')].map(node => ({ id: node.dataset.testid, disabled: node.disabled })),
    contentBox,
    boardDialog: bd ? { state: bd.dataset.state, text: text(bd), statusText: text(q('board-canvas-status')),
      omitted: text(q('board-canvas-omitted')), omittedOpen: q('board-canvas-omitted')?.open === true,
      notes: [...bd.children].map((node, index) => ({ node, index })).filter(({ node }) => node.classList.contains('egd-portable-note'))
        .map(({ node, index }) => ({ selector: `[data-testid="board-canvas-export"] > :nth-child(${index + 1})`, text: text(node) })) } : null,
    boards: Object.values(api?.state?.boards?.projections || {}).map(p => ({ id: p.id, boardId: p.boardId, title: p.title, dirty: !!p.dirty,
      members: p.members.map(m => ({ id: m.viewId, sourceId: m.sourceId, present: !!document.getElementById(m.viewId) })) })),
    active: { tag: document.activeElement?.localName, id: document.activeElement?.id || null, testid: document.activeElement?.dataset.testid || null,
      index: document.activeElement?.dataset.index ?? null, field: document.activeElement?.dataset.field ?? null },
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
  // Editing uses this same outer Settings scroller. Its sticky action row is
  // an occluder for fields, but never an occluder for its own Save/Cancel.
  // No form exists during the preceding import/export/duplicate flow.
  const actions = target.closest?.('[data-testid="settings-agent-form"]')?.querySelector('.egd-settings-form-actions');
  if (actions && !actions.contains(target) && getComputedStyle(actions).position === 'sticky') {
    const footer = rect(actions);
    if (footer.bottom > viewport.top && footer.top < viewport.bottom) {
      viewport.bottom = Math.min(viewport.bottom, footer.top);
      targetClip.bottom = Math.min(targetClip.bottom, footer.top);
    }
  }
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
  return { ...base, owned: true, contentVisible: visible(content), targetVisible, disabled, readOnly: !!target.readOnly,
    testid: target.dataset?.testid, profileId: target.dataset?.profileId, revision: target.dataset?.revision, duplicateState: target.dataset?.state,
    targetRect, targetClip, targetHits,
    targetPaintReady: targetVisible && inside(targetRect, targetClip) && targetHits.every(Boolean) && owns(target, point.x, point.y),
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

export async function navigatePortableSettings({ read, wheelAt, clickPoint, pause, assertDeadline, focus = false, trace = [], disabledDuplicate = null }) {
  let binding;
  const observe = async () => {
    assertDeadline(); const value = await read();
    assert.ok(value.owned && value.cards === 1 && value.contents === 1 && value.count === 1, 'One target in the same Settings content is required');
    assert.ok(value.contentVisible && value.targetVisible, 'Settings target is unavailable');
    if (disabledDuplicate) {
      assert.equal(focus, false); assertDisabledDuplicateTarget(value, disabledDuplicate);
      value.targetReady = value.targetPaintReady;
    } else assert.equal(value.disabled, false, 'Settings target is unavailable');
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

export const PORTABLE_DRAFT_INPUT = {
  examples: [{ user: 'QA draft question one', reply: 'QA draft answer one.\nKeep active unchanged.' },
    { user: 'QA draft question two', reply: 'QA draft answer two.' }],
  avoid: ['QA draft avoid one', 'QA draft avoid two'], tone: 'warm',
  pending: { traits: 'QA careful', expertise: 'QA draft review', toolPreferences: 'qa-readonly' },
};
const draftPath = state => `/profiles/${state.seed.profileId}/draft`;
const draftControls = ui => ui.editor ? [...ui.editor.examples.flatMap(row => [row.user, row.reply]),
  ...ui.editor.avoid.map(row => row.text), ...Object.values(ui.editor.chips).map(chip => chip.input)] : [];
const indexed = (name, index) => `${testid(name)}[data-index="${index}"]`;
const chipSelector = field => `${testid('settings-agent-chip-input')}[data-field=${JSON.stringify(field)}]`;

export function portableDraftExpectedBody(profile) {
  const body = structuredClone(profile.head.body), input = PORTABLE_DRAFT_INPUT;
  // The existing form derives the initial avatar for this exact owned seed.
  // Account for that normal save behavior explicitly, not by accepting any
  // unrelated body changes from the receipt as our expected value.
  assert.equal(body.name, 'Owned QA portable profile');
  body.avatar ||= { kind: 'initial', value: 'O', color: '#49634f' };
  body.personality = { ...body.personality, tone: input.tone,
    traits: [...(body.personality?.traits || []), input.pending.traits],
    examples: structuredClone(input.examples), avoid: [...input.avoid] };
  body.expertise = [...(body.expertise || []), input.pending.expertise];
  body.toolPreferences = [...(body.toolPreferences || []), input.pending.toolPreferences];
  return body;
}

export function assertPortableDraftGet(state, profile) {
  const id = state.seed.profileId, record = state.persisted.profiles.records.find(row => row.id === id);
  assert.equal(profile.id, id); assert.ok(record);
  assert.equal(profile.activeRevision, record.active_revision); assert.equal(profile.lifecycle, record.lifecycle);
  const rows = state.persisted.profiles.revisions.filter(row => row.profile_id === id);
  assert.equal(profile.headRevision, Math.max(...rows.map(row => row.revision)));
  for (const revision of [profile.head, ...(profile.active ? [profile.active] : [])]) {
    const row = rows.find(value => value.revision === revision.revision);
    assert.ok(row); assert.equal(revision.profileId, id);
    assert.equal(row.hash, sha256(row.body_json)); assert.equal(revision.hash, row.hash);
    assert.deepEqual(revision.body, JSON.parse(row.body_json));
  }
  assert.equal(profile.head.revision, profile.headRevision);
  assert.equal(profile.active?.revision ?? null, profile.activeRevision);
  const read = state.requests.findLast(row => row.method === 'GET' && row.path === `/profiles/${id}` && row.query === '');
  assert.ok(read?.delegated && read.status === 200, 'Actual profile GET, not a synthesized result, is required');
  assert.deepEqual(read.response, profile); assert.equal(read.responseSha256, sha256(JSON.stringify(profile)));
  return true;
}

export function assertPortableDraftDelta(before, after, { puts = 0, changed = false, body = null, profile = null, baseRevision = null } = {}) {
  assert.ok(puts === 0 || puts === 1); assert.ok(!changed || puts === 1);
  assertPortableRejectedDeskAutosaves(before, after);
  assert.deepEqual(after.requests.slice(0, before.requests.length), before.requests, 'Earlier transfer receipts are immutable');
  for (const key of ['seed', 'catalogSeed', 'currentImportSha256', 'exports', 'pickerResults', 'queuedPicker',
    'headAdvances', 'duplicateEvents', 'receiptFaults', 'duplicateReceiptFault', 'forbiddenPosts']) assert.deepEqual(after[key], before[key]);
  for (const key of ['providerTurns', 'nativePickerInvocations', 'nativeProcessSpawns']) assert.equal(after[key], 0);
  const added = after.requests.slice(before.requests.length);
  assert.ok(added.every(row => !/^\/(?:chat|terminal|providers?|auth|rooms?)(?:\/|$)/.test(row.path)), 'No provider/auth/room/terminal attempt');
  const writes = added.filter(row => row.method !== 'GET' && !deskAutosave(row));
  const preflight = writes.filter(row => row.method === 'OPTIONS'), calls = writes.filter(row => row.method === 'PUT');
  assert.equal(calls.length, puts, 'Count actual draft PUT separately from earlier allowed import/duplicate POST and preflight');
  assert.equal(writes.length, calls.length + preflight.length, 'No new POST, control or unrelated mutation in the draft stage');
  assert.ok(preflight.length <= 1 && (puts > 0 || preflight.length === 0), 'At most one exact preflight for the explicit save');
  for (const row of preflight) assert.deepEqual(row, { sequence: row.sequence, method: 'OPTIONS', path: draftPath(before),
    query: '', delegated: false, status: 204 });
  assert.deepEqual(after.persisted.profiles.records, before.persisted.profiles.records, 'Active/lifecycle/source and all other profiles stay unchanged');
  const prior = before.persisted.profiles.revisions, rows = after.persisted.profiles.revisions;
  const head = Math.max(...prior.filter(row => row.profile_id === before.seed.profileId).map(row => row.revision));
  const revision = head + Number(changed);
  assert.equal(rows.length, prior.length + Number(changed));
  for (const row of prior) assert.deepEqual(rows.find(next => next.profile_id === row.profile_id && next.revision === row.revision), row);
  if (changed) {
    const row = rows.find(row => row.profile_id === before.seed.profileId && row.revision === revision);
    assert.ok(row); assert.equal(row.parent_revision, head); assert.equal(row.hash, sha256(row.body_json));
    assert.deepEqual(JSON.parse(row.body_json), body);
  }
  if (!puts) { assert.deepEqual(after.persisted, before.persisted); return true; }
  assert.equal(baseRevision, head); assertPortableDraftGet(after, profile);
  const call = calls[0], request = { body, expectedRevision: baseRevision };
  assert.equal(call.path, draftPath(before)); assert.equal(call.query, ''); assert.equal(call.status, 200); assert.equal(call.delegated, true);
  assert.equal(call.requestTruncated, false); assert.deepEqual(call.request, request);
  assert.equal(call.requestBytes, Buffer.byteLength(JSON.stringify(request))); assert.equal(call.requestSha256, sha256(JSON.stringify(request)));
  assert.equal(call.response.id, before.seed.profileId); assert.equal(call.response.revision, revision); assert.equal(call.response.unchanged, !changed);
  assert.equal(call.response.hash, profile.head.hash); assert.deepEqual(call.response.profile, profile);
  assert.equal(call.responseSha256, sha256(JSON.stringify(call.response)));
  assert.equal(profile.headRevision, revision); assert.deepEqual(profile.head.body, body);
  assert.deepEqual(call.before, before.persisted); assert.deepEqual(call.after, after.persisted);
  assert.ok(after.requests.some(row => row.method === 'GET' && row.path === `/profiles/${profile.id}` && row.sequence > call.sequence && row.status === 200),
    'Read back from the real handler after the PUT');
  return true;
}

function assertDraftContext(before, ui) {
  assert.ok(ui.settingsId); assert.equal(ui.settingsId, before.settingsId);
  assert.deepEqual(ui.roomAssignments, before.roomAssignments); assert.equal(ui.activeThreadId, before.activeThreadId);
}
export function assertPortableDraftFooter(ui) {
  const actions = ui.editor?.actions, viewport = actions?.contentViewport, footer = actions?.box;
  assert.equal(actions?.position, 'sticky');
  assert.ok(viewport && footer && [viewport.top, viewport.bottom, viewport.clientHeight, viewport.scrollHeight, footer.bottom].every(Number.isFinite),
    'Observed footer and actual client scrollport geometry are required');
  assert.ok(viewport.clientHeight > 0 && viewport.bottom > viewport.top && viewport.scrollHeight >= viewport.clientHeight);
  if (viewport.scrollHeight > viewport.clientHeight + 1) {
    assert.ok(Math.abs(viewport.bottom - footer.bottom) <= 1,
      'Overflowing Agent form footer must meet the scrollport bottom: no exposed body strip below the actions');
  }
  // A short form is deliberately not stretched to the bottom of the card.
  return true;
}
export function assertPortableDraftForm(ui, profile, context) {
  assertDraftContext(context, ui);
  const form = ui.editor;
  assert.ok(form && form.count === 1 && form.owned, 'One actual form in the existing Settings card');
  assert.equal(ui.detailCount, 0); assert.equal(form.busy, false); assert.equal(form.busySource, 'save.disabled');
  assert.equal(form.errors, ''); assert.deepEqual(form.fieldErrors, []);
  if (form.profileId !== null) assert.equal(form.profileId, profile.id);
  if (form.baseRevision !== null) assert.equal(Number(form.baseRevision), profile.headRevision);
  assert.equal(form.exampleCount, form.examples.length); assert.ok(form.exampleCount <= 3);
  assert.equal(form.avoidCount, form.avoid.length); assert.ok(form.avoidCount <= 8);
  for (const rows of [form.examples, form.avoid]) rows.forEach((row, index) => {
    assert.equal(row.index, String(index));
    for (const control of [row.user, row.reply, row.text].filter(Boolean)) assert.equal(control.index, String(index));
  });
  for (const control of draftControls(ui)) {
    assert.ok(control?.id); assert.equal(control.truncated, false); assert.equal(control.length, control.value.length);
    assert.equal(control.disabled, false); assert.equal(control.readOnly, false);
  }
  assert.equal(form.actions.position, 'sticky', 'Use the existing sticky actions, not another editor/modal');
  return true;
}
function draftValues(ui) {
  return { examples: ui.editor.examples.map(row => ({ user: row.user.value, reply: row.reply.value })),
    avoid: ui.editor.avoid.map(row => row.text.value) };
}
function assertDraftBodyInForm(ui, body) {
  assert.deepEqual(draftValues(ui), { examples: body.personality?.examples || [], avoid: body.personality?.avoid || [] });
  assert.equal(ui.editor.tone, `${ui.settingsId}-profile-tone-${body.personality?.tone || 'plain'}`);
  for (const [field, values] of Object.entries({ traits: body.personality?.traits || [], expertise: body.expertise || [], toolPreferences: body.toolPreferences || [] })) {
    assert.deepEqual(ui.editor.chips[field].values, values); assert.equal(ui.editor.chips[field].input.value, '');
  }
}
function assertDraftDetail(ui, profile, context) {
  assertDraftContext(context, ui); assert.equal(ui.editor, null); assert.equal(ui.detailCount, 1);
  const shown = profile.active || profile.head;
  assert.equal(ui.detailId, profile.id); assert.equal(ui.detailRevision, String(shown.revision)); assert.equal(ui.detailLifecycle, profile.lifecycle);
  assert.equal(ui.target.profileId, profile.id); assert.equal(ui.target.revision, String(shown.revision));
  assert.equal(ui.target.source, profile.active ? 'active' : 'draft');
  assert.deepEqual(ui.detailPersonality, { examples: shown.body.personality?.examples || [], avoid: shown.body.personality?.avoid || [] });
  return true;
}

// Single native edit, with no selector-based focus command, direct value write,
// Tab fallback or input retry. An uncertain native result aborts the stage.
export async function editPortableDraftInput({ selector, value, readUi, readTarget, validateUi, reach, click, press, typeText, waitUi, assertDeadline, recordReach }) {
  assert.equal(typeof validateUi, 'function');
  assertDeadline(); validateUi(await readUi()); await reach(selector); validateUi(await readUi());
  assertDeadline(); await click(selector, 'focus the observed Agent form input');
  const focused = await readTarget(selector);
  recordReach?.(focused);
  assert.ok(focused.count === 1 && focused.owned && focused.targetReady && focused.focused, 'Native click must focus the same visible input');
  const before = await readUi(), current = draftControls(before).find(control => control?.focused);
  validateUi(before); assert.equal(focused.settingsId, before.settingsId);
  assert.ok(current && current.id === before.active.id && current.testid === focused.testid && !current.disabled && !current.readOnly);
  assert.equal(current.truncated, false);
  assertDeadline(); await press(process.platform === 'darwin' ? 'meta+a' : 'Control+a');
  const selected = await readUi(), selectedControl = draftControls(selected).find(control => control?.id === current.id);
  validateUi(selected); assert.equal(selectedControl?.value, current.value);
  assert.equal(selected.active.id, current.id); assert.equal(selectedControl?.focused, true);
  assert.equal(selectedControl.start, 0); assert.equal(selectedControl.end, current.value.length);
  assertDeadline(); if (value) await typeText(value); else await press('Backspace');
  const after = await waitUi(ui => ui.active.id === current.id && draftControls(ui).some(control =>
    control?.id === current.id && control.focused && control.value === value && control.start === value.length && control.end === value.length));
  return after;
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
    synthetic: ['native OS picker result DTO', 'prelaunch owned Board catalog seed', 'one malformed duplicate receipt after actual SQLite creation; not a network/SSE fault'],
    excluded: ['provider turns', 'OS picker interaction', 'hardware foreground', 'PTY/shell', 'production autosave', 'network/SSE disconnection'] };
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
  const reach = async (selector, { focus = false, disabledDuplicate = null } = {}) => {
    const settingsId = (await observePortableUi(harness)).settingsId;
    assert.ok(settingsId, 'Existing Settings card required for native scrolling');
    return navigatePortableSettings({ read: () => observePortableSettingsNavigation(harness, selector, settingsId),
      wheelAt: input => harness.wheelAt(input), clickPoint: point => harness.clickPoint(point),
      pause: () => new Promise(resolve => setTimeout(resolve, 75)), assertDeadline: () => assertBeforeDeadline(deadlineMs),
      focus, disabledDuplicate, trace: result.actions });
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
  assert.equal(proof.initial.seed.profileVersion, 'head2-draft',
    'The original transfer flow consumes advance-head 2→3 and requires inactive drafts; run the independent draft stage for head3-active2');
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
  // Keep all R7 receipts/checks intact before this independent Settings action.
  proof.transferFinal = proof.final;
  proof.duplicate = await runPortableDuplicateCase({ readState: state, readUi: () => observePortableUi(harness),
    reach, click, capture, check, waitUi, pause: () => new Promise(resolve => setTimeout(resolve, 250)),
    assertDeadline: () => assertBeforeDeadline(deadlineMs) });
  proof.final = await state();
  check('final store permits only the original import, one head advance and one explicit duplicate',
    assertPortableStoreInvariant(proof.initial, proof.final, { imported: 1, headAdvanced: true, duplicated: 1 }));
  const afterDuplicate = await loopbackJson('/__qa/state', { token, env });
  check('duplicate adds no provider/send/auth/terminal activity', afterDuplicate.providerTurns === 0 &&
    afterDuplicate.observed.sends.length === 0 && afterDuplicate.observed.authWrites.length === 0 && afterDuplicate.runs.length === 0);
  proof.successFinal = proof.final;
  proof.duplicateUnknown = await runPortableDuplicateUnknownCase({ readState: state, readUi: () => observePortableUi(harness),
    armFault: target => loopbackJson('/__qa/portable-transfer/control', { method: 'POST', token, env,
      body: { operation: 'arm-duplicate-receipt-fault', ...target } }), reach, click, capture, check, waitUi,
    retryDisabled: async (selector, target, uiBefore) => {
      const point = await probePortableDisabledDuplicate({ selector, target, uiBefore,
        readUi: () => observePortableUi(harness),
        readTarget: () => observePortableSettingsNavigation(harness, selector, uiBefore.settingsId),
        clickPoint: value => harness.clickPoint(value), assertDeadline: () => assertBeforeDeadline(deadlineMs) });
      result.actions.push({ kind: 'native-disabled-duplicate-probe', selector, ...point, at: Date.now() });
    }, pause: () => new Promise(resolve => setTimeout(resolve, 250)), assertDeadline: () => assertBeforeDeadline(deadlineMs) });
  proof.final = await state();
  const afterUnknown = await loopbackJson('/__qa/state', { token, env });
  check('receipt fault adds no provider/send/auth/terminal activity', afterUnknown.providerTurns === 0 &&
    afterUnknown.observed.sends.length === 0 && afterUnknown.observed.authWrites.length === 0 && afterUnknown.runs.length === 0);
  // Freeze every preceding receipt/check before permitting the independent
  // draft PUT. In particular do not reuse the consumed head-advance control.
  proof.unknownFinal = proof.final;
  proof.draftEdit = {};
  await runPortableDraftEditCase({ proof: proof.draftEdit, actionTrace: result.actions, readState: state, readUi: () => observePortableUi(harness),
    readProfile: id => { assertBeforeDeadline(deadlineMs); return loopbackJson(`/profiles/${id}`, { token, env }); },
    readTarget: async selector => observePortableSettingsNavigation(harness, selector, (await observePortableUi(harness)).settingsId),
    resize: async height => { size = { width: 1280, height }; await resizeHeadless(harness, size, deadlineMs); await waitStableViewport(harness, size, deadlineMs); },
    reach, click, press: value => key(value),
    typeText: async text => { assertBeforeDeadline(deadlineMs); await harness.typeText(text);
      result.actions.push({ kind: 'native-type-text', text, at: Date.now() }); },
    capture, check, waitUi, pause: () => new Promise(resolve => setTimeout(resolve, 250)), assertDeadline: () => assertBeforeDeadline(deadlineMs) });
  proof.final = await state();
  check('final draft receipt still has no save/revision replay or unrelated mutation',
    assertPortableDraftDelta(proof.draftEdit.unchanged.state, proof.final));
  const afterDraft = await loopbackJson('/__qa/state', { token, env });
  check('draft editing adds no observed provider/send/auth/terminal activity', afterDraft.providerTurns === 0 &&
    afterDraft.observed.sends.length === 0 && afterDraft.observed.authWrites.length === 0 && afterDraft.runs.length === 0);
  result.providerTurns = afterDraft.providerTurns;
  result.nativePickerInvocations = proof.final.nativePickerInvocations; result.nativeProcessSpawns = proof.final.nativeProcessSpawns;
  result.actualUiAndOwnedStorageVerified = true;
  result.profileDuplicateVerified = true;
  result.profileDuplicateUnknownVerified = 'synthetic-malformed-receipt-after-actual-create-only';
  result.profileDraftEditVerified = true;
  result.visualReview = 'pending-first-person-review';
}

// The caller supplies only the already-owned native/observation helpers. This
// stage cannot POST a duplicate itself or replace any product state/receipt.
export async function runPortableDuplicateCase({ readState, readUi, reach, click, capture, check, waitUi, pause, assertDeadline }) {
  const before = await readState(), uiBefore = await readUi();
  check('no duplicate request or draft before the explicit native click; displayed v2 remains independent of head v3',
    assertPortableDuplicateReady(before, uiBefore));
  const selector = `${testid('settings-agent-duplicate')}[data-profile-id=${JSON.stringify(before.seed.profileId)}][data-revision="2"][data-state="idle"]`;
  await reach(selector);
  await capture('profile-duplicate-v2-command', [{ selector, text: '복제해서 새로 만들기' }], await readUi());
  const clickState = await readState(), clickUi = await readUi();
  assertPortableDuplicateReady(clickState, clickUi);
  assert.deepEqual(clickState.persisted, before.persisted);
  assert.deepEqual(clickUi.target, uiBefore.target); assert.deepEqual(clickUi.roomAssignments, uiBefore.roomAssignments);
  assert.equal(clickUi.activeThreadId, uiBefore.activeThreadId);
  assertDeadline(); await click(selector, 'duplicate exactly the displayed saved version 2 into one inactive draft');
  const uiAfter = await waitUi(value => value.detailId !== before.seed.profileId && value.detailRevision === '1' &&
    value.detailLifecycle === 'draft' && value.agentNotice === PORTABLE_DUPLICATE_NOTICE);
  const after = await readState(), id = assertPortableDuplicatedDraft(before, after, uiBefore, uiAfter);
  check('one actual duplicate POST copies v2, not head v3, into one unassigned inactive draft v1', !!id);
  for (const [stage, subject, expected] of [
    ['profile-duplicate-created-notice', 'settings-agent-notice', PORTABLE_DUPLICATE_NOTICE],
    ['profile-duplicate-draft-version-1', 'transfer-export-target', uiAfter.target.text],
  ]) {
    await reach(testid(subject)); const ui = await readUi();
    assertPortableDuplicateUi(uiBefore, ui, id);
    await capture(stage, [{ selector: testid(subject), text: expected }], ui);
  }
  const samples = [];
  for (let sample = 0; sample < 4; sample++) {
    assertDeadline(); await pause(); samples.push({ state: await readState(), ui: await readUi() });
  }
  check('duplicate completion does not replay, activate, assign, alter exports or replace original saved revisions',
    assertPortableDuplicateNoReplay(after, samples, uiBefore, id));
  check('any intervening Desk autosave is exactly rejected before delegation and leaves Desk/Board SQLite unchanged',
    assertPortableRejectedDeskAutosaves(before, samples.at(-1).state));
  return { before, uiBefore, clickState, clickUi, after, uiAfter, id, samples };
}

export function assertPortableUnknownUi(before, ui, target) {
  assert.equal(ui.settingsId, before.settingsId); assert.ok(ui.settingsId);
  assert.equal(ui.detailCount, 1); assert.equal(ui.detailId, target.profileId);
  assert.equal(ui.detailRevision, String(target.revision)); assert.equal(ui.detailLifecycle, 'draft');
  assert.deepEqual(ui.target, before.target);
  assert.deepEqual(ui.duplicate, { count: 1, profileId: target.profileId, revision: String(target.revision), state: 'unknown', disabled: true });
  assert.equal(ui.agentNotice, PORTABLE_DUPLICATE_UNKNOWN_NOTICE);
  assert.deepEqual(ui.roomAssignments, before.roomAssignments); assert.equal(ui.activeThreadId, before.activeThreadId);
  return true;
}

function assertDisabledDuplicateTarget(value, target) {
  assert.equal(value.testid, 'settings-agent-duplicate'); assert.equal(value.profileId, target.profileId);
  assert.equal(value.revision, String(target.revision)); assert.equal(value.duplicateState, 'unknown');
  assert.equal(value.disabled, true); assert.equal(value.readOnly, false);
}

export async function probePortableDisabledDuplicate({ selector, target, uiBefore, readUi, readTarget, clickPoint, assertDeadline }) {
  const observe = async () => {
    assertDeadline(); assertPortableUnknownUi(uiBefore, await readUi(), target);
    const value = await readTarget();
    assertDisabledDuplicateTarget(value, target);
    assert.equal(value.selector, selector); assert.equal(value.settingsId, uiBefore.settingsId);
    assert.ok(value.owned && value.cards === 1 && value.contents === 1 && value.count === 1);
    assert.ok(value.contentVisible && value.targetVisible && value.targetPaintReady,
      'Disabled probe still requires the entire button, ancestor clipping and all nine hit points');
    return value;
  };
  const first = await observe(), fresh = await observe();
  for (const key of ['targetRect', 'targetClip', 'point', 'scrollTop', 'viewport']) assert.deepEqual(fresh[key], first[key]);
  assertDeadline(); await clickPoint(fresh.point); // Exactly one input; never retry ambiguous input.
  return fresh.point;
}

export function assertPortableUnknownCreated(before, after, uiBefore, uiAfter, target) {
  assert.equal(target.profileId, before.seed.profileId); assert.deepEqual(after.seed, before.seed);
  assertPortableUnknownUi(uiBefore, uiAfter, target);
  assertPortableRejectedDeskAutosaves(before, after);
  assert.equal(before.duplicateReceiptFault, null); assert.deepEqual(before.receiptFaults, []);
  assert.equal(profileDuplicates(before).length, 1); assert.equal(before.duplicateEvents.length, 1);
  assert.equal(profileDuplicates(after).length, 2); assert.equal(after.duplicateEvents.length, 2);
  const call = profileDuplicates(after).at(-1), receipt = call.response;
  assert.deepEqual(nonDeskWrites(after), [...nonDeskWrites(before), call]);
  assert.equal(call.path, `/profiles/${target.profileId}/duplicate`); assert.equal(call.query, '');
  assert.equal(call.delegated, true); assert.equal(call.status, 201); assert.equal(call.requestTruncated, false);
  assert.deepEqual(call.request, { revision: target.revision });
  assert.equal(call.requestSha256, sha256(JSON.stringify(call.request)));
  assert.deepEqual(call.before, before.persisted); assert.deepEqual(call.after, after.persisted);
  assert.equal(call.responseSha256, sha256(JSON.stringify(receipt)));
  assert.equal(call.deliveredStatus, 201); assert.deepEqual(call.deliveredResponse, { ...receipt, profile: null });
  const delivered = JSON.stringify(call.deliveredResponse);
  assert.equal(call.deliveredResponseSha256, sha256(delivered)); assert.equal(call.deliveredResponseBytes, Buffer.byteLength(delivered));
  const arm = after.requests.find(row => row.sequence === after.duplicateReceiptFault.armSequence);
  assert.equal(arm.path, '/__qa/portable-transfer/control'); assert.equal(arm.method, 'POST'); assert.equal(arm.status, 200);
  assert.deepEqual(arm.request, { operation: 'arm-duplicate-receipt-fault', ...target });
  assert.equal(arm.requestSha256, sha256(JSON.stringify(arm.request)));
  assert.deepEqual(after.duplicateReceiptFault, { state: 'consumed', armSequence: arm.sequence, ...target, requestSequence: call.sequence });
  assert.ok(arm.sequence < call.sequence);
  assert.deepEqual(after.receiptFaults, [{ kind: 'duplicate-receipt-profile-null', synthetic: true, armSequence: arm.sequence,
    sequence: call.sequence, sourceProfileId: target.profileId, sourceRevision: target.revision, sourceHash: target.hash,
    createdProfileId: receipt.id, actualResponseSha256: call.responseSha256, deliveredResponseSha256: call.deliveredResponseSha256 }]);
  assert.deepEqual(call.receiptFault, after.receiptFaults[0]);
  const source = before.persisted.profiles.revisions.find(row => row.profile_id === target.profileId && row.revision === target.revision);
  assert.ok(source); assert.equal(source.hash, target.hash);
  const old = before.persisted.profiles, next = after.persisted.profiles;
  assert.equal(next.records.length, old.records.length + 1); assert.equal(next.revisions.length, old.revisions.length + 1);
  for (const row of old.records) assert.deepEqual(next.records.find(item => item.id === row.id), row);
  for (const row of old.revisions) assert.deepEqual(next.revisions.find(item => item.profile_id === row.profile_id && item.revision === row.revision), row);
  const copy = next.records.find(row => !old.records.some(item => item.id === row.id));
  assert.equal(copy.id, receipt.id); assert.equal(copy.lifecycle, 'draft'); assert.equal(copy.active_revision, null); assert.equal(copy.origin, 'user');
  const revision = next.revisions.find(row => row.profile_id === copy.id);
  const sourceBody = JSON.parse(source.body_json), body = { ...sourceBody, name: `${sourceBody.name} 사본` };
  assert.equal(revision.revision, 1); assert.equal(revision.parent_revision, null);
  assert.deepEqual(JSON.parse(revision.body_json), body); assert.equal(revision.hash, sha256(revision.body_json));
  assert.equal(receipt.revision, 1); assert.equal(receipt.hash, revision.hash);
  assert.equal(receipt.profile.id, copy.id); assert.equal(receipt.profile.lifecycle, 'draft');
  assert.equal(receipt.profile.activeRevision, null); assert.equal(receipt.profile.active, null);
  assert.equal(receipt.profile.headRevision, 1); assert.equal(receipt.profile.head.revision, 1);
  assert.deepEqual(receipt.profile.head.body, body);
  const provenance = JSON.parse(copy.source_json), entry = provenance.at(-1);
  assert.deepEqual(provenance.slice(0, -1), JSON.parse(old.records.find(row => row.id === target.profileId).source_json));
  assert.deepEqual(provenance, receipt.profile.source); assert.ok(Number.isSafeInteger(entry.at));
  assert.deepEqual(entry, { kind: 'duplicate', origin: 'user', profileId: target.profileId, revision: target.revision,
    hash: target.hash, name: sourceBody.name, at: entry.at });
  assert.deepEqual(after.duplicateEvents, [...before.duplicateEvents, { sequence: call.sequence, sourceProfileId: target.profileId,
    sourceRevision: target.revision, sourceHash: target.hash, profileId: copy.id, revision: 1, hash: revision.hash,
    name: body.name, lifecycle: 'draft', activeRevision: null }]);
  for (const key of ['exports', 'pickerResults', 'headAdvances', 'forbiddenPosts', 'currentImportSha256']) assert.deepEqual(after[key], before[key]);
  for (const key of ['providerTurns', 'nativePickerInvocations', 'nativeProcessSpawns']) assert.equal(after[key], 0);
  return copy.id;
}

export function assertPortableUnknownNoReplay(before, samples, uiBefore, target) {
  assert.ok(samples.length >= 3);
  for (const { state, ui } of samples) {
    assertPortableUnknownUi(uiBefore, ui, target); assertPortableRejectedDeskAutosaves(before, state);
    assert.deepEqual(nonDeskWrites(state), nonDeskWrites(before));
    for (const key of ['persisted', 'duplicateEvents', 'duplicateReceiptFault', 'receiptFaults', 'exports', 'pickerResults', 'headAdvances', 'forbiddenPosts']) {
      assert.deepEqual(state[key], before[key]);
    }
  }
  return true;
}

export async function runPortableDuplicateUnknownCase({ readState, readUi, armFault, reach, click, retryDisabled, capture, check, waitUi, pause, assertDeadline }) {
  assertDeadline();
  const start = await readState(), startUi = await readUi();
  const back = `${testid('settings-agent-detail')}[data-profile-id=${JSON.stringify(startUi.detailId)}] > button.egd-settings-link`;
  await reach(back); await capture('duplicate-unknown-return-to-list', [{ selector: back, text: '← Agent 목록' }], await readUi());
  await click(back, 'return to the actual Agent list');
  await waitUi(ui => ui.rows.some(row => row.id === start.seed.profileId));
  const row = `${testid('settings-agent-row')}[data-profile-id=${JSON.stringify(start.seed.profileId)}]`;
  await reach(row); await click(row, 'select original saved profile for receipt fault');
  const uiBefore = await waitUi(ui => ui.detailId === start.seed.profileId && ui.duplicate.state === 'idle' && !ui.duplicate.disabled);
  const before = await readState(), revision = Number(uiBefore.detailRevision);
  assert.deepEqual(before.persisted, start.persisted); assert.equal(uiBefore.settingsId, startUi.settingsId);
  assertPortableRejectedDeskAutosaves(start, before); assert.deepEqual(nonDeskWrites(before), nonDeskWrites(start));
  for (const key of ['duplicateEvents', 'exports', 'pickerResults', 'forbiddenPosts']) assert.deepEqual(before[key], start[key]);
  assert.deepEqual(uiBefore.roomAssignments, startUi.roomAssignments); assert.equal(uiBefore.activeThreadId, startUi.activeThreadId);
  assert.equal(uiBefore.detailCount, 1); assert.equal(uiBefore.detailLifecycle, 'draft');
  assert.equal(uiBefore.target.profileId, start.seed.profileId); assert.equal(uiBefore.target.revision, String(revision));
  assert.equal(uiBefore.target.source, 'draft'); assert.ok(Number.isSafeInteger(revision) && revision > 0);
  assert.deepEqual(uiBefore.duplicate, { count: 1, profileId: start.seed.profileId, revision: String(revision), state: 'idle', disabled: false });
  const source = before.persisted.profiles.revisions.find(item => item.profile_id === start.seed.profileId && item.revision === revision);
  assert.ok(source); assert.equal(revision, Math.max(...before.persisted.profiles.revisions.filter(item => item.profile_id === start.seed.profileId).map(item => item.revision)));
  const target = { profileId: start.seed.profileId, revision, hash: source.hash };
  const selector = `${testid('settings-agent-duplicate')}[data-profile-id=${JSON.stringify(target.profileId)}][data-revision="${revision}"]`;
  await reach(`${selector}[data-state="idle"]`);
  assertDeadline(); await armFault(target);
  const armed = await readState(), freshUi = await readUi();
  assert.deepEqual(armed.persisted, before.persisted); assert.deepEqual(armed.duplicateEvents, before.duplicateEvents);
  assert.deepEqual(nonDeskWrites(armed), nonDeskWrites(before));
  assert.deepEqual(armed.duplicateReceiptFault, { state: 'armed', armSequence: armed.duplicateReceiptFault.armSequence, ...target });
  for (const key of ['settingsId', 'detailId', 'detailRevision', 'detailLifecycle', 'target', 'duplicate', 'roomAssignments', 'activeThreadId']) assert.deepEqual(freshUi[key], uiBefore[key]);
  assertDeadline(); await click(`${selector}[data-state="idle"]`, 'one actual duplicate with a declared malformed receipt');
  const uiAfter = await waitUi(ui => ui.duplicate.state === 'unknown' && ui.duplicate.disabled && ui.agentNotice === PORTABLE_DUPLICATE_UNKNOWN_NOTICE);
  const after = await readState(), id = assertPortableUnknownCreated(before, after, uiBefore, uiAfter, target);
  check('malformed receipt follows exactly one real inactive draft creation, not a failed or fake store write', !!id);
  await reach(testid('settings-agent-notice'));
  assertPortableUnknownUi(uiBefore, await readUi(), target);
  await capture('duplicate-receipt-unknown-notice', [{ selector: testid('settings-agent-notice'), text: PORTABLE_DUPLICATE_UNKNOWN_NOTICE }], await readUi());
  const disabledSelector = `${selector}[data-state="unknown"]`;
  await reach(disabledSelector, { disabledDuplicate: target });
  await capture('duplicate-unknown-disabled-button', [{ selector: disabledSelector, text: '복제해서 새로 만들기' }], await readUi());
  assertDeadline(); await retryDisabled(disabledSelector, target, uiBefore);
  const samples = [];
  for (let n = 0; n < 4; n++) { assertDeadline(); await pause(); samples.push({ state: await readState(), ui: await readUi() }); }
  check('native point on disabled unknown duplicate produces zero additional POST/create; original identity remains fixed',
    assertPortableUnknownNoReplay(after, samples, uiBefore, target));
  return { start, before, uiBefore, target, armed, after, uiAfter, id, samples, faultScope: 'synthetic receipt only; no network/SSE fault' };
}

// Native-only orchestration: injected input helpers drive the unchanged form.
// readProfile is GET-only; this stage has no API mutation/fixture control path.
export async function runPortableDraftEditCase({ readState, readUi, readProfile, readTarget, resize, reach, click,
  press, typeText, capture, check, waitUi, pause, assertDeadline, proof = {}, actionTrace = [] }) {
  // The caller attaches this object before awaiting the stage, so a rejected
  // assertion cannot discard already-observed evidence. No extra UI reads.
  Object.assign(proof, { observations: [], buttons: [], samples: [], removalDiagnostics: [], toneDiagnostics: [], footerDiagnostics: [], lastRowReach: [] });
  assertDeadline();
  const start = await readState(), profileBefore = await readProfile(start.seed.profileId), before = await readState(), context = await readUi();
  assertPortableDraftGet(before, profileBefore); assertPortableDraftDelta(start, before);
  assert.equal(profileBefore.headRevision, 3);
  const activeSeed = before.seed.profileVersion === 'head3-active2';
  assert.ok(activeSeed || before.seed.profileVersion === 'head2-draft');
  assert.equal(profileBefore.activeRevision, activeSeed ? 2 : null); assert.equal(profileBefore.lifecycle, activeSeed ? 'active' : 'draft');
  assert.equal(before.headAdvances.length, activeSeed ? 0 : 1);
  assert.equal(before.requests.filter(row => row.method === 'PUT' && row.path === draftPath(before)).length, 0);
  assertDraftDetail(context, profileBefore, context);
  Object.assign(proof, { before, profileBefore, context, seedMode: before.seed.profileVersion,
    bindingEvidence: 'entry detail + actual GET + eventual PUT expectedRevision; private form profile/base fields may be unexposed',
    conflict: 'excluded; existing product units cover keptForm and explicit resave' });
  const recordRemoval = (when, phase, kind, ui, retainedIds, selector, reached) => {
    if (proof.removalDiagnostics.length >= 8) return;
    const focused = draftControls(ui).find(control => control?.id === ui.active?.id);
    const rows = kind === 'example' ? ui.editor?.examples : ui.editor?.avoid;
    proof.removalDiagnostics.push({ when, phase, kind, width: ui.width, height: ui.height, settingsFullscreen: ui.settingsFullscreen ?? null,
      active: { tag: ui.active?.tag ?? null, id: ui.active?.id ?? null, testid: ui.active?.testid ?? null, index: ui.active?.index ?? null },
      retainedIds: [...retainedIds], selection: focused ? { start: focused.start, end: focused.end } : null,
      rows: (rows || []).slice(0, kind === 'example' ? 3 : 8).map(row => ({ index: row.index,
        controls: [row.user, row.reply, row.text].filter(Boolean).map(control => ({ id: control.id, testid: control.testid,
          rowKeyFromInputId: control.id?.match(/-profile-personality(?:Examples|Avoid)-(row-\d+)-/)?.[1] ?? null,
          index: control.index, focused: control.focused, start: control.start, end: control.end })) })),
      reachAction: { selector, scrollTop: reached?.scrollTop ?? null, targetReady: reached?.targetReady ?? null,
        focused: reached?.focused ?? null, activeTestid: reached?.activeTestid ?? null },
      recentActions: actionTrace.slice(-2).map(({ kind, selector, x, y, deltaY, before, after }) => ({ kind, selector, x, y, deltaY, before, after })),
    });
  };
  const recordTone = (when, phase, ui, oldFocus, tone, reached) => {
    if (proof.toneDiagnostics.length >= 4) return;
    const focused = draftControls(ui).find(control => control?.id === ui.active?.id);
    proof.toneDiagnostics.push({ when, phase, width: ui.width, height: ui.height, settingsFullscreen: ui.settingsFullscreen ?? null,
      active: { tag: ui.active?.tag ?? null, id: ui.active?.id ?? null, testid: ui.active?.testid ?? null, index: ui.active?.index ?? null },
      selection: focused ? { start: focused.start, end: focused.end } : null,
      previousInput: oldFocus ? { id: oldFocus.id, testid: oldFocus.testid, index: oldFocus.index, start: oldFocus.start, end: oldFocus.end } : null,
      expectedButtonId: tone, selectedTone: ui.editor?.tone ?? null,
      reachAction: { selector: selectorForId(tone), scrollTop: reached?.scrollTop ?? null, targetReady: reached?.targetReady ?? null,
        focused: reached?.focused ?? null, activeTestid: reached?.activeTestid ?? null },
      recentActions: actionTrace.slice(-2).map(({ kind, selector, x, y, deltaY, before, after }) => ({ kind, selector, x, y, deltaY, before, after })),
    });
  };
  const observeForm = async profile => { const ui = await readUi(); assertPortableDraftForm(ui, profile, context); return ui; };
  const edit = async (selector, value, profile) => {
    const ui = await editPortableDraftInput({ selector, value, readUi, readTarget,
      validateUi: value => assertPortableDraftForm(value, profile, context), reach, click, press, typeText, waitUi, assertDeadline,
      recordReach: target => {
        if (proof.lastRowReach.length < 4 && ['example-reply', 'avoid-text'].some(name => selector === indexed(`settings-agent-${name}`, 2))) {
          proof.lastRowReach.push({ selector, target });
        }
      } });
    assertPortableDraftForm(ui, profile, context); return ui;
  };
  const open = async (profile, height, phase) => {
    assertDeadline(); await resize(height);
    const ui = await readUi(); assert.equal(ui.height, height); assertDraftDetail(ui, profile, context);
    const selector = `${testid('settings-agent-detail')}[data-profile-id=${JSON.stringify(profile.id)}] .egd-settings-detail-actions > button:first-child`;
    await reach(selector); await capture(`draft-${phase}-edit-command-${height}`, [{ selector, text: '편집' }], await readUi());
    assertDraftDetail(await readUi(), profile, context);
    assertDeadline(); await click(selector, 'open the existing saved Agent editor');
    const opened = await waitUi(value => value.editor?.count === 1 && !value.editor.busy);
    assertPortableDraftForm(opened, profile, context); assertDraftBodyInForm(opened, profile.head.body);
    proof.observations.push({ phase: `${phase}-opened`, ui: opened });
    return opened;
  };
  const button = async (id, phase, profile) => {
    const selector = testid(id); await reach(selector);
    const target = await readTarget(selector), ui = await observeForm(profile);
    const { box, contentViewport } = ui.editor.actions;
    if (proof.footerDiagnostics.length < 4) proof.footerDiagnostics.push({ phase, width: ui.width, height: ui.height,
      settingsFullscreen: ui.settingsFullscreen ?? null, contentViewport, footerBottom: box?.bottom ?? null,
      bottomGap: contentViewport && box ? contentViewport.bottom - box.bottom : null });
    check(`${phase}: overflowing form footer covers the scrollport bottom without forcing short-form alignment`, assertPortableDraftFooter(ui));
    assert.ok(target.owned && target.count === 1 && target.targetReady, 'Sticky action must be fully reachable by the existing native Settings path');
    await capture(`draft-${phase}-${ui.height}`, [{ selector, text: id.endsWith('-save') ? '초안 저장' : '취소' }], ui);
    proof.buttons.push({ phase, height: ui.height, target });
    return selector;
  };
  const change = async (profile, phase) => {
    let ui = await observeForm(profile), expected = draftValues(ui);
    assert.ok(expected.examples.length <= 1 && expected.avoid.length <= 1, 'Known owned seed only, never erase arbitrary rows');
    const pending = {};
    const verify = value => {
      assertPortableDraftForm(value, profile, context); assert.deepEqual(draftValues(value), expected);
      for (const [field, text] of Object.entries(pending)) {
        assert.equal(value.editor.chips[field].input.value, text, 'Pending chip survives every add/delete/tone rerender');
        assert.ok(!value.editor.chips[field].values.includes(text), 'Pending text must not be silently committed before Save');
      }
      return value;
    };
    for (const [field, text] of Object.entries(PORTABLE_DRAFT_INPUT.pending)) {
      ui = await edit(chipSelector(field), text, profile); pending[field] = text; verify(ui);
    }
    for (const kind of ['example', 'avoid']) {
      const key = kind === 'example' ? 'examples' : 'avoid';
      const add = async () => {
        const index = expected[key].length, selector = testid(`settings-agent-${kind}-add`);
        await reach(selector); verify(await readUi()); assertDeadline(); await click(selector, `add one ${kind} row through the existing form`);
        expected[key].push(kind === 'example' ? { user: '', reply: '' } : '');
        ui = verify(await waitUi(value => value.editor?.[key]?.length === expected[key].length));
        assert.equal(ui.active.testid, `settings-agent-${kind}-${kind === 'example' ? 'user' : 'text'}`); assert.equal(ui.active.index, String(index));
        proof.observations.push({ phase: `${phase}-${kind}-add-${index}`, ui });
      };
      const fillRow = async (index, value) => {
        for (const [field, text] of Object.entries(kind === 'example' ? value : { text: value })) {
          ui = await edit(indexed(`settings-agent-${kind}-${field}`, index), text, profile);
          if (kind === 'example') expected[key][index][field] = text; else expected[key][index] = text;
          verify(ui);
        }
      };
      if (!expected[key].length) await add();
      await fillRow(0, PORTABLE_DRAFT_INPUT[key][0]);
      await add(); await fillRow(1, kind === 'example' ? { user: 'QA temporary question', reply: 'QA temporary answer' } : 'QA temporary avoid');
      await add(); await fillRow(2, PORTABLE_DRAFT_INPUT[key][1]);
      const retained = kind === 'example' ? [ui.editor.examples[2].user.id, ui.editor.examples[2].reply.id] : [ui.editor.avoid[2].text.id];
      const remove = indexed(`settings-agent-${kind}-remove`, 1);
      const reached = await reach(remove), beforeRemove = await readUi();
      recordRemoval('before-click-after-reach', phase, kind, beforeRemove, retained, remove, reached);
      verify(beforeRemove); assertDeadline(); await click(remove, `delete only the temporary ${kind} row`); expected[key].splice(1, 1);
      ui = await waitUi(value => value.editor?.[key]?.length === 2);
      recordRemoval('after-click-row-count-wait', phase, kind, ui, retained, remove, reached);
      ui = verify(ui);
      assert.ok(retained.includes(ui.active.id), 'Focus follows a retained input, not a detached/deleted row or the page');
      assert.equal(ui.active.index, '1', 'Renumbering preserves the retained row identity');
      proof.observations.push({ phase: `${phase}-${kind}-removed-middle`, ui });
    }
    const oldFocus = draftControls(ui).find(control => control.focused), tone = `${ui.settingsId}-profile-tone-${PORTABLE_DRAFT_INPUT.tone}`;
    const toneReached = await reach(selectorForId(tone)), beforeTone = await readUi();
    recordTone('before-click-after-reach', phase, beforeTone, oldFocus, tone, toneReached);
    verify(beforeTone); assertDeadline(); await click(selectorForId(tone), 'change tone without dropping pending/row inputs');
    ui = await waitUi(value => value.editor?.tone === tone);
    recordTone('after-click-selected-tone-wait', phase, ui, oldFocus, tone, toneReached);
    ui = verify(ui);
    assert.ok(ui.active.id === tone || ui.active.id === oldFocus?.id, 'Tone rerender keeps native button focus or the existing input focus');
    if (ui.active.id === oldFocus?.id) {
      const kept = draftControls(ui).find(control => control.id === oldFocus.id);
      assert.equal(kept.start, oldFocus.start); assert.equal(kept.end, oldFocus.end);
    }
    proof.observations.push({ phase: `${phase}-tone-and-pending`, ui });
    check(`${phase}: actual values, pair order, renumbered retained focus and all three pending chip inputs survive native add/delete/tone`, true);
  };
  const cancel = async (profile, baseline, phase) => {
    const selector = await button('settings-agent-cancel', phase, profile);
    await observeForm(profile);
    assertDeadline(); await click(selector, 'cancel the existing form without a draft PUT');
    const ui = await waitUi(value => value.editor === null && value.detailId === profile.id);
    assertDraftDetail(ui, profile, context);
    const fetched = await readProfile(profile.id), state = await readState();
    assertPortableDraftGet(state, fetched); assert.deepEqual(fetched, profile);
    check(`${phase}: cancel produces zero draft PUT and zero revision or active/Desk/Board change`, assertPortableDraftDelta(baseline, state));
    return { ui, profile: fetched, state };
  };

  await open(profileBefore, 600, 'cancel'); await change(profileBefore, 'cancel');
  proof.cancelled = await cancel(profileBefore, before, 'cancel-600');
  await open(profileBefore, 800, 'save'); await change(profileBefore, 'save');
  const save = await button('settings-agent-save', 'save-pending-800', profileBefore);
  const beforeSave = await readState(); assertPortableDraftDelta(proof.cancelled.state, beforeSave);
  const pendingUi = await observeForm(profileBefore);
  assert.deepEqual(draftValues(pendingUi), { examples: PORTABLE_DRAFT_INPUT.examples, avoid: PORTABLE_DRAFT_INPUT.avoid });
  for (const [field, text] of Object.entries(PORTABLE_DRAFT_INPUT.pending)) assert.equal(pendingUi.editor.chips[field].input.value, text);
  assertDeadline(); await click(save, 'one explicit draft save including still-pending chips');
  const savedUi = await waitUi(ui => ui.editor === null && ui.detailId === profileBefore.id);
  const savedProfile = await readProfile(profileBefore.id), saved = await readState(), expectedBody = portableDraftExpectedBody(profileBefore);
  check('one explicit changed save: exactly one actual PUT; real GET and SQLite agree on one new head with pending values',
    assertPortableDraftDelta(beforeSave, saved, { puts: 1, changed: true, body: expectedBody, profile: savedProfile, baseRevision: profileBefore.headRevision }));
  assertDraftDetail(savedUi, savedProfile, context); assert.deepEqual(savedProfile.active, profileBefore.active);
  proof.saved = { before: beforeSave, state: saved, profile: savedProfile, ui: savedUi, expectedBody };

  // The default seed starts empty. Reopening the saved head proves populated
  // pairs/avoid are directly editable without adding another blank row/modal.
  await open(savedProfile, 600, 'populated-reopen');
  for (const [name, value] of [['example-user', 'QA cancelled existing question'], ['example-reply', 'QA cancelled existing answer'],
    ['avoid-text', 'QA cancelled existing avoid']]) await edit(indexed(`settings-agent-${name}`, 0), value, savedProfile);
  proof.populatedCancelled = await cancel(savedProfile, saved, 'populated-cancel-600');
  await open(savedProfile, 800, 'unchanged-reopen');
  const unchangedSave = await button('settings-agent-save', 'unchanged-save-800', savedProfile);
  const beforeUnchanged = await readState(); assertPortableDraftDelta(proof.populatedCancelled.state, beforeUnchanged);
  assertDraftBodyInForm(await observeForm(savedProfile), savedProfile.head.body);
  assertDeadline(); await click(unchangedSave, 'explicit unchanged save; never create another revision');
  const unchangedUi = await waitUi(ui => ui.editor === null && ui.detailId === savedProfile.id);
  const unchangedProfile = await readProfile(savedProfile.id), unchanged = await readState();
  check('unchanged explicit save is one PUT but zero new revisions, with the same saved head and active version',
    assertPortableDraftDelta(beforeUnchanged, unchanged, { puts: 1, body: expectedBody, profile: unchangedProfile, baseRevision: savedProfile.headRevision }));
  assertDraftDetail(unchangedUi, unchangedProfile, context); assert.deepEqual(unchangedProfile, savedProfile);
  proof.unchanged = { before: beforeUnchanged, state: unchanged, profile: unchangedProfile, ui: unchangedUi };
  for (let n = 0; n < 4; n++) {
    assertDeadline(); await pause(); const state = await readState(), ui = await readUi();
    assertPortableDraftDelta(unchanged, state); assertDraftDetail(ui, unchangedProfile, context);
    proof.samples.push({ state, ui });
  }
  check('four bounded passive samples show no automatic save/revision, provider or assignment replay', proof.samples.length === 4);
  assert.ok(proof.observations.length <= 24); assert.equal(proof.buttons.length, 4);
  return proof;
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv); assertPortableEnvironment(env);
  return runUiFlow('portable-transfer', context => runPortableTransferFlow(context, { ...options, env }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runCli();
