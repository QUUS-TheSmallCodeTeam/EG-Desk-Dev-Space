import { recoverDeskSnapshot } from './EGDeskSurfaceState.sys.mjs';

// The adapter stores exact preference strings. Backups are internal recovery
// records, not new Desks or Saved Boards; this module never deletes a record.
export function createDeskRecoveryStore({ read, write, listKeys, prefix = 'egdesk.deskRecovery.v1.', now = Date.now, makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }) {
  const get = key => {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
    try {
      const record = JSON.parse(read(key));
      return typeof record?.raw === 'string' ? { ...record, key } : null;
    } catch { return null; }
  };
  const list = () => listKeys(prefix).map(get).filter(Boolean).sort((a, b) => b.savedAt - a.savedAt);
  const preserve = (raw, reason) => {
    if (typeof raw !== 'string') throw new Error('복구 원본을 읽지 못했습니다.');
    const existing = list().find(record => record.raw === raw);
    if (existing) return existing;
    let key = `${prefix}${makeId()}`;
    while (read(key) != null) key = `${prefix}${makeId()}`;
    const record = { version: 1, raw, reason, savedAt: now() };
    write(key, JSON.stringify(record));
    const verified = get(key);
    if (!verified || verified.raw !== raw) throw new Error('복구 원본의 별도 저장을 확인하지 못했습니다.');
    return verified;
  };
  const recover = (raw, restore) => {
    let snapshot = null;
    try { snapshot = raw == null ? null : JSON.parse(raw); }
    catch { snapshot = { unreadable: true }; }
    const result = recoverDeskSnapshot(snapshot, restore);
    if (!result.protected) return { ...result, backupKey: null, recoveryProtected: false };
    try {
      const backup = preserve(raw, result.reason);
      return { ...result, backupKey: backup.key, recoveryProtected: false };
    } catch (error) {
      return { ...result, backupKey: null, recoveryProtected: true, reason: error.message };
    }
  };
  return { get, list, preserve, recover };
}

// Retry is additive: current entities win; only absent saved view IDs are added.
export function missingDeskRecoveryViews(snapshot, existingIds) {
  const present = new Set(existingIds);
  return {
    cards: (snapshot.cards || []).filter(record => !present.has(record.id)),
    shapes: (snapshot.shapes || []).filter(record => !present.has(record.id)),
  };
}

// ── RT-07 / CTX-01 / CTX-02: the local bridge's Desk store ──
// The screen keeps writing its preference values on every save (the offline
// fallback) and, while the bridge reports a ready Desk store, also saves there:
// Desk saves become recovery generations, Board saves become Board versions.
// Nothing in this section reads a write or clear function for preferences, so
// it cannot remove the earlier values (egdesk.deskSession.v1,
// egdesk.agendaState.v1, egdesk.deskRecovery.v1.*).

// Same names as helper/egdesk-chat-store.mjs PRIVATE_KEYS (the store refuses
// a whole save that carries one); the test compares the two lists.
export const DESK_STORE_PRIVATE_KEYS = Object.freeze([
  'reasoning', 'rawreasoning', 'rawmodelreasoning', 'hiddenreasoning', 'reasoningcontent',
  'credential', 'credentials', 'cookie', 'cookies', 'setcookie',
  'authorization', 'authpayload', 'authtoken', 'accesstoken',
  'refreshtoken', 'sessiontoken', 'apikey', 'privatekey', 'secret',
  'password', 'passphrase', 'clientsecret', 'systemprompt',
]);
export const DESK_STORE_LIMITS = Object.freeze({ deskStateBytes: 4 * 1024 * 1024, boardBodyBytes: 4 * 1024 * 1024, boards: 500 });
export const DESK_REASON_LABELS = Object.freeze({ autosave: '자동 저장', explicit: '직접 저장', import: '가져옴', restore: '복원' });
const DESK_STORE_BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRIVATE_KEY_SET = new Set(DESK_STORE_PRIVATE_KEYS);
const CARD_KIND_LABELS = { browser: 'Browser', file: '파일', chat: 'Chat', terminal: '터미널', settings: '설정', ontology: '지도', result: '결과', 'input-evidence': '첨부 자료' };
const textBytes = text => new TextEncoder().encode(text).length;
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const countOf = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** The bridge reports the Desk store: capabilities.desk 'local-store' or deskStorageReady. */
export function deskStoreAvailable(bridgeState) {
  const desk = bridgeState?.capabilities?.desk;
  return (Array.isArray(desk) && desk.includes('local-store')) || bridgeState?.deskStorageReady === true;
}

/**
 * JSON copy without fields the store treats as private (for example a Chat
 * room's systemPrompt). The preference value keeps them; the store never sees them.
 */
export function storeSafeCopy(value) {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value, (key, part) => (
    key && PRIVATE_KEY_SET.has(String(key).toLowerCase().replace(/[_-]/g, '')) ? undefined : part)));
}

/** Only what the Desk drawing depends on: panning, the Board label and Chat text are left out. */
export function deskLayoutKey(state) {
  return JSON.stringify([state?.cards || [], state?.shapes || [], state?.boardProjections?.projections || {}]);
}

/**
 * Body for the one-time POST /v1/desk/import, or null when nothing can be sent.
 * An unreadable Desk value is left out (its exact text already has a recovery
 * record); a Board the store would refuse (ID, size, more than 500) stays in
 * preferences only and is counted in skippedBoards.
 */
export function deskImportBody({ rawDesk = null, agendaStore = null } = {}) {
  let deskSnapshot;
  if (typeof rawDesk === 'string') {
    try {
      const parsed = JSON.parse(rawDesk);
      if (isPlainObject(parsed) && !parsed.unreadable) {
        const text = JSON.stringify(storeSafeCopy(parsed));
        if (textBytes(text) <= DESK_STORE_LIMITS.deskStateBytes) deskSnapshot = text;
      }
    } catch { /* Unreadable: the recovery record keeps the exact text. */ }
  }
  const agendas = isPlainObject(agendaStore?.agendas) ? agendaStore.agendas : {};
  const meta = isPlainObject(agendaStore?.meta) ? agendaStore.meta : {};
  const entries = Object.entries(agendas);
  const accepted = entries
    .filter(([boardId, body]) => DESK_STORE_BOARD_ID.test(boardId) && isPlainObject(body))
    .map(([boardId, body]) => ({ boardId, title: meta[boardId]?.title, body: storeSafeCopy(body),
      order: Number(meta[boardId]?.updatedAt || body.savedAt || 0) }))
    .filter(board => textBytes(JSON.stringify(board.body)) <= DESK_STORE_LIMITS.boardBodyBytes)
    .sort((a, b) => b.order - a.order)
    .slice(0, DESK_STORE_LIMITS.boards);
  const boards = accepted.map(({ boardId, title, body }) => (typeof title === 'string' ? { boardId, title, body } : { boardId, body }));
  if (deskSnapshot === undefined && !boards.length) return null;
  return { body: { ...(deskSnapshot === undefined ? {} : { deskSnapshot }), boards }, skippedBoards: entries.length - boards.length };
}

/** Month, day and time to the second, in local time ('10월 24일 14:05:09'). */
export function deskStoreTime(ts) {
  if (!Number.isFinite(ts)) return '시각을 알 수 없음';
  const date = new Date(ts);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function cardKindsText(cards) {
  const counts = new Map();
  for (const card of cards) {
    const label = CARD_KIND_LABELS[card?.type];
    if (label) counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].map(([label, n]) => `${label} ${n}`).join(' · ');
}

/** Rows for the '복구 기록' list: when, why (Korean), and how much was on the Desk. */
export function deskGenerationRows(page, { formatTime = deskStoreTime } = {}) {
  const generations = Array.isArray(page?.generations) ? page.generations : [];
  const byId = new Map(generations.map(item => [item.generation, item]));
  return generations.map(item => {
    const source = byId.get(item.restoredFrom);
    return {
      generation: item.generation,
      current: item.generation === page?.head,
      time: formatTime(item.createdAt),
      reason: DESK_REASON_LABELS[item.reason] || '저장',
      counts: `카드 ${countOf(item.cardCount)}개 · 도형 ${countOf(item.shapeCount)}개`,
      note: item.reason === 'restore' ? (source ? `${formatTime(source.createdAt)} 시점에서 복원` : '이전 시점에서 복원') : '',
    };
  });
}

/** A short look at a saved Desk: counts, kinds and Board names; never the saved text. */
export function deskStatePreview(state) {
  const cards = Array.isArray(state?.cards) ? state.cards : [];
  const shapes = Array.isArray(state?.shapes) ? state.shapes : [];
  const boards = [...new Set(Object.values(isPlainObject(state?.boardProjections?.projections) ? state.boardProjections.projections : {})
    .map(projection => (typeof projection?.title === 'string' ? projection.title.trim() : '')).filter(Boolean))];
  return { cardCount: cards.length, shapeCount: shapes.length, kinds: cardKindsText(cards), boards,
    boardsText: boards.length ? `Board ${boards.join(', ')}` : '열린 Board 없음' };
}

/** Rows for a Board's '버전 기록': version, when, who wrote it, and what a revert came from. */
export function boardRevisionRows(page, { formatTime = deskStoreTime } = {}) {
  return (Array.isArray(page?.revisions) ? page.revisions : []).map(item => ({
    revision: item.revision,
    current: item.revision === page?.headRevision,
    label: `버전 ${item.revision}`,
    time: formatTime(item.createdAt),
    author: item.author === 'import' ? '가져옴' : '직접 저장',
    note: Number.isSafeInteger(item.revertedFrom) ? `버전 ${item.revertedFrom}에서 되돌림` : '',
  }));
}

/** A short look at one Board version: its name and what it holds. */
export function boardBodyPreview(body) {
  const cards = Array.isArray(body?.cards) ? body.cards : [];
  const shapes = Array.isArray(body?.shapes) ? body.shapes : [];
  const title = typeof body?.agenda?.title === 'string' && body.agenda.title.trim() ? body.agenda.title.trim() : 'Board';
  return { title, cardCount: cards.length, shapeCount: shapes.length, kinds: cardKindsText(cards) };
}

function storeTitle(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC').trim();
  const length = Array.from(text).length;
  return length && length <= 80 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(text) ? text : undefined;
}

export const DESK_STORE_NOTICES = Object.freeze({
  importFailed: '이전 Desk와 Board 기록을 새 저장소로 옮기지 못했습니다. 지금처럼 이 PC 설정에 계속 저장합니다.',
  importSkipped: count => `Board ${count}개는 크기나 이름 때문에 새 저장소로 옮기지 않고 이 PC 설정에만 남겨 두었습니다.`,
  deskTooLarge: 'Desk가 너무 커서 복구 기록에 남기지 못했습니다. 이 PC 설정에는 그대로 저장했습니다.',
  deskPrivate: '보호가 필요한 값이 들어 있어 이번 Desk는 이 PC 설정에만 저장했습니다.',
  deskFailed: 'Desk를 복구 기록에 남기지 못했습니다. 이 PC 설정에는 그대로 저장했습니다.',
  boardFailed: 'Board를 버전 기록에 남기지 못했습니다. 이 PC 설정에는 그대로 저장했습니다.',
});

/**
 * createDeskStoreSync({request, readRawDesk, readAgendaStore, now, onNotice, onChange})
 * request(method, path, body?, {timeoutMs}) → {status, body}; it throws when
 * the bridge cannot be reached (offline, timeout). Every method resolves; none
 * throws to the screen. A result with stored:'prefs' means only the
 * preference value holds this save.
 */
export function createDeskStoreSync({ request, readRawDesk = () => null, readAgendaStore = () => null, now = Date.now,
  onNotice = () => {}, onChange = () => {}, saveTimeoutMs = 15000, importTimeoutMs = 60000, retryAfterMs = 30000 } = {}) {
  if (typeof request !== 'function') throw new TypeError('request is required');
  const status = { mode: 'unknown', generation: null, lastSavedAt: null, lastError: null, imported: null };
  const heads = new Map();
  const noticed = new Set();
  let available = false, handshake = null, lastHandshakeAt = -Infinity, lastLayout = null;
  let inFlight = null, queued = null;
  const snapshot = () => ({ ...status, ready: status.mode === 'ready', knownBoards: heads.size });
  const set = patch => {
    Object.assign(status, patch);
    try { onChange(snapshot()); } catch { /* A screen listener never breaks saving. */ }
  };
  const notice = (key, message) => {
    if (noticed.has(key)) return;
    noticed.add(key);
    try { onNotice(message); } catch { /* Same. */ }
  };
  const call = async (method, path, body, options = {}) => {
    try {
      const response = await request(method, path, body, options);
      return { status: Number(response?.status) || 0, body: response?.body ?? null, offline: !response };
    } catch { return { status: 0, body: null, offline: true }; }
  };
  const ok = response => response.status >= 200 && response.status < 300;
  const unreachable = response => response.offline || response.status === 0 || response.status === 503 || response.status === 504;
  const codeOf = response => response.body?.code || (response.offline ? 'BRIDGE_UNREACHABLE' : `HTTP_${response.status}`);
  const ready = () => status.mode === 'ready';
  const notReady = () => ({ stored: 'prefs', mode: status.mode });

  function fallback(response) {
    const mode = response.status === 503 || response.status === 404 ? 'unavailable' : 'offline';
    set({ mode, lastError: codeOf(response) });
    return { ready: false, mode };
  }

  async function connectStore() {
    lastHandshakeAt = now();
    set({ mode: 'connecting' });
    let current = await call('GET', '/v1/desk/current');
    if (!ok(current)) return fallback(current);
    if (current.body?.generation == null && current.body?.lastImport == null) {
      const prepared = deskImportBody({ rawDesk: readRawDesk(), agendaStore: readAgendaStore() });
      if (prepared) {
        const imported = await call('POST', '/v1/desk/import', prepared.body, { timeoutMs: importTimeoutMs });
        if (!ok(imported)) {
          if (unreachable(imported)) return fallback(imported);
          // 413, 400 (unreadable, private field) or a Board limit: keep preferences only.
          set({ mode: 'import-failed', lastError: codeOf(imported) });
          notice('import-failed', DESK_STORE_NOTICES.importFailed);
          return { ready: false, mode: 'import-failed' };
        }
        status.imported = { desk: imported.body?.desk?.status || null, boards: (imported.body?.boards || []).map(board => board.status) };
        if (prepared.skippedBoards > 0) notice('import-skipped', DESK_STORE_NOTICES.importSkipped(prepared.skippedBoards));
        current = await call('GET', '/v1/desk/current');
        if (!ok(current)) return fallback(current);
      }
    }
    const boards = await call('GET', '/v1/boards');
    if (!ok(boards)) return fallback(boards);
    heads.clear();
    for (const board of boards.body?.boards || []) {
      if (DESK_STORE_BOARD_ID.test(board?.boardId) && Number.isSafeInteger(board.headRevision)) heads.set(board.boardId, board.headRevision);
    }
    lastLayout = null;
    set({ mode: 'ready', generation: current.body?.generation ?? null, lastError: null });
    return { ready: true, mode: 'ready', connected: true };
  }

  /** Called with each /v1/state read (null for an older bridge). Imports once per store. */
  function observeBridge(bridgeState) {
    available = deskStoreAvailable(bridgeState);
    if (!available) {
      if (status.mode !== 'unavailable') set({ mode: 'unavailable' });
      return Promise.resolve({ ready: false, mode: 'unavailable' });
    }
    if (ready()) return Promise.resolve({ ready: true, mode: 'ready', connected: false });
    if (status.mode === 'import-failed') return Promise.resolve({ ready: false, mode: 'import-failed' });
    if (!handshake) handshake = connectStore().finally(() => { handshake = null; });
    return handshake;
  }

  /** The bridge connection dropped: preferences only until the next handshake. */
  function markOffline() {
    if (ready() || status.mode === 'connecting') set({ mode: 'offline', lastError: 'BRIDGE_UNREACHABLE' });
  }

  async function sendDesk(state, { reason = 'autosave' } = {}) {
    if (!ready()) return notReady();
    const safe = storeSafeCopy(state);
    const layout = deskLayoutKey(safe);
    if (reason === 'autosave' && layout === lastLayout) return { stored: 'prefs', skipped: 'same-layout' };
    const body = { state: safe, parentGeneration: status.generation, reason: reason === 'explicit' ? 'explicit' : 'autosave' };
    let response = await call('PUT', '/v1/desk/current', body, { timeoutMs: saveTimeoutMs });
    if (response.status === 409 && response.body?.code === 'DESK_GENERATION_CONFLICT') {
      // This window owns the Desk; the overwritten generation stays in the journal.
      response = await call('PUT', '/v1/desk/current', { ...body, parentGeneration: response.body.generation ?? null }, { timeoutMs: saveTimeoutMs });
    }
    if (ok(response)) {
      lastLayout = layout;
      set({ generation: response.body?.generation ?? status.generation, lastSavedAt: now(), lastError: null });
      return { stored: 'both', generation: status.generation, unchanged: response.body?.unchanged === true };
    }
    if (unreachable(response)) {
      set({ mode: 'offline', lastError: codeOf(response) });
      return { stored: 'prefs', offline: true };
    }
    const code = codeOf(response);
    if (response.status === 409) {
      set({ generation: response.body?.generation ?? status.generation, lastError: code });
      return { stored: 'prefs', conflict: true };
    }
    set({ lastError: code });
    if (response.status === 413) notice('desk-too-large', DESK_STORE_NOTICES.deskTooLarge);
    else if (/^PRIVATE_/.test(code)) notice('desk-private', DESK_STORE_NOTICES.deskPrivate);
    else notice('desk-failed', DESK_STORE_NOTICES.deskFailed);
    return { stored: 'prefs', error: code };
  }

  /**
   * Desk autosave (persistDeskSession) and explicit saves. One request at a
   * time; while one is out, only the newest waiting Desk is sent next.
   */
  async function saveDesk(state, options = {}) {
    if (!ready() && available && status.mode === 'offline' && !handshake && now() - lastHandshakeAt >= retryAfterMs) {
      await observeBridge({ deskStorageReady: true });
    }
    if (!ready()) return notReady();
    if (!inFlight) {
      inFlight = sendDesk(state, options)
        .catch(() => ({ stored: 'prefs', error: 'DESK_STATE_UNREADABLE' }))
        .finally(() => { inFlight = null; });
      return inFlight;
    }
    if (queued) {
      queued.state = state;
      queued.options = options;
      return queued.promise;
    }
    const next = { state, options };
    next.promise = inFlight.then(() => {
      queued = null;
      return saveDesk(next.state, next.options);
    });
    queued = next;
    return next.promise;
  }

  const generationsPath = before => `/v1/desk/generations?limit=50${Number.isSafeInteger(before) ? `&before=${before}` : ''}`;
  async function generations({ before } = {}) {
    if (!ready()) return { unavailable: true, rows: [] };
    const response = await call('GET', generationsPath(before));
    if (!ok(response)) {
      if (unreachable(response)) markOffline();
      return { error: codeOf(response), rows: [] };
    }
    return { ...response.body, rows: deskGenerationRows(response.body) };
  }

  async function generation(id) {
    if (!ready()) return { unavailable: true };
    const response = await call('GET', `/v1/desk/generations/${id}`);
    if (response.status === 404) return { missing: true };
    if (!ok(response)) return { error: codeOf(response) };
    return { ...response.body, preview: deskStatePreview(response.body?.state) };
  }

  /** Publish an earlier generation as a new one (reason restore) and return the Desk to draw. */
  async function restoreGeneration(id) {
    if (!ready()) return { unavailable: true };
    const response = await call('POST', '/v1/desk/restore', { generation: id, parentGeneration: status.generation });
    if (response.status === 404) return { missing: true };
    if (response.status === 409) {
      set({ generation: response.body?.generation ?? status.generation });
      return { conflict: true };
    }
    if (!ok(response)) return { error: codeOf(response) };
    const current = await call('GET', '/v1/desk/current');
    if (!ok(current) || !isPlainObject(current.body?.state)) return { error: codeOf(current) };
    lastLayout = null;
    set({ generation: current.body.generation, lastSavedAt: now() });
    return { restored: true, generation: current.body.generation, unchanged: response.body?.unchanged === true, state: current.body.state };
  }

  async function putBoard(boardId, body, title, expectedRevision) {
    const name = storeTitle(title);
    const payload = { body: storeSafeCopy(body), expectedRevision, ...(name ? { title: name } : {}) };
    const response = await call('PUT', `/v1/boards/${encodeURIComponent(boardId)}`, payload, { timeoutMs: saveTimeoutMs });
    if (ok(response)) {
      const head = response.body?.board?.headRevision ?? response.body?.revision;
      if (Number.isSafeInteger(head)) heads.set(boardId, head);
      return { stored: 'both', revision: response.body?.revision ?? null, headRevision: head ?? null,
        unchanged: response.body?.unchanged === true, boardCreated: response.body?.boardCreated === true };
    }
    if (response.status === 409 && response.body?.code === 'BOARD_REVISION_CONFLICT') {
      return { stored: 'prefs', conflict: true, headRevision: response.body.headRevision ?? null };
    }
    if (unreachable(response)) {
      set({ mode: 'offline', lastError: codeOf(response) });
      return { stored: 'prefs', offline: true };
    }
    set({ lastError: codeOf(response) });
    notice(`board-failed:${codeOf(response)}`, DESK_STORE_NOTICES.boardFailed);
    return { stored: 'prefs', error: codeOf(response) };
  }

  /** Board save (saveCurrentAgendaState): expectedRevision is the head this window knows, null for a new Board. */
  async function saveBoard(boardId, body, { title } = {}) {
    if (!ready()) return notReady();
    if (!DESK_STORE_BOARD_ID.test(boardId || '')) return { stored: 'prefs', skipped: 'board-id' };
    try { return await putBoard(boardId, body, title, heads.has(boardId) ? heads.get(boardId) : null); }
    catch { return { stored: 'prefs', error: 'BOARD_BODY_UNREADABLE' }; }
  }

  /** After a conflict the person chose to keep theirs: a new version on top of the latest head. */
  async function saveBoardAsNewVersion(boardId, body, { title, headRevision } = {}) {
    if (!ready()) return notReady();
    try { return await putBoard(boardId, body, title, Number.isSafeInteger(headRevision) ? headRevision : (heads.get(boardId) ?? null)); }
    catch { return { stored: 'prefs', error: 'BOARD_BODY_UNREADABLE' }; }
  }

  async function latestBoard(boardId) {
    if (!ready()) return { unavailable: true };
    const response = await call('GET', `/v1/boards/${encodeURIComponent(boardId)}`);
    if (response.status === 404) return { missing: true };
    if (!ok(response)) return { error: codeOf(response) };
    const head = response.body?.head;
    return { headRevision: response.body?.headRevision ?? head?.revision ?? null, title: response.body?.title || null,
      body: head?.body ?? null, createdAt: head?.createdAt ?? null, preview: boardBodyPreview(head?.body) };
  }

  async function boardRevisions(boardId, { before } = {}) {
    if (!ready()) return { unavailable: true, rows: [] };
    const query = `limit=50${Number.isSafeInteger(before) ? `&before=${before}` : ''}`;
    const response = await call('GET', `/v1/boards/${encodeURIComponent(boardId)}/revisions?${query}`);
    if (response.status === 404) return { missing: true, rows: [], revisions: [], headRevision: null };
    if (!ok(response)) return { error: codeOf(response), rows: [] };
    if (Number.isSafeInteger(response.body?.headRevision)) heads.set(boardId, response.body.headRevision);
    return { ...response.body, rows: boardRevisionRows(response.body) };
  }

  async function boardRevision(boardId, revision) {
    if (!ready()) return { unavailable: true };
    const response = await call('GET', `/v1/boards/${encodeURIComponent(boardId)}/revisions/${revision}`);
    if (response.status === 404) return { missing: true };
    if (!ok(response)) return { error: codeOf(response) };
    return { ...response.body, preview: boardBodyPreview(response.body?.body) };
  }

  /** Publish an earlier version as a new version; the head moves forward, never back. */
  async function revertBoard(boardId, revision) {
    if (!ready()) return { unavailable: true };
    const expected = heads.get(boardId);
    const response = await call('POST', `/v1/boards/${encodeURIComponent(boardId)}/revert`,
      { revision, ...(Number.isSafeInteger(expected) ? { expectedRevision: expected } : {}) });
    if (response.status === 409 && response.body?.code === 'BOARD_REVISION_CONFLICT') {
      if (Number.isSafeInteger(response.body.headRevision)) heads.set(boardId, response.body.headRevision);
      return { conflict: true, headRevision: response.body.headRevision ?? null };
    }
    if (response.status === 404) return { missing: true };
    if (!ok(response)) return { error: codeOf(response) };
    if (Number.isSafeInteger(response.body?.revision)) heads.set(boardId, response.body.revision);
    return { reverted: true, revision: response.body?.revision ?? null, revertedFrom: response.body?.revertedFrom ?? null,
      unchanged: response.body?.unchanged === true };
  }

  return {
    observeBridge, markOffline, saveDesk, generations, generation, restoreGeneration,
    saveBoard, saveBoardAsNewVersion, latestBoard, boardRevisions, boardRevision, revertBoard,
    status: snapshot, knownHead: boardId => heads.get(boardId) ?? null,
  };
}
