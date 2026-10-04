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
