// Outer File Card lifecycle. Opaque service IDs are retained for revalidation;
// neither a saved path nor a restored Card grants new filesystem permission.
const string = value => typeof value === 'string' && value ? value : null;
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

export function fileCardRecord(root, view = {}) {
  return {
    version: 1,
    root: root?.rootId && root?.directoryId ? { rootId: string(root.rootId), directoryId: string(root.directoryId), name: string(root.name) || '연결된 폴더' } : null,
    fileId: string(view.fileId), draftId: string(view.draftId),
    sourceRevision: copy(view.sourceRevision || null),
    bufferRevision: Number.isInteger(view.bufferRevision) ? view.bufferRevision : null,
    savedRevision: Number.isInteger(view.savedRevision) ? view.savedRevision : null,
    // Scroll can be restored, never caret, selection or input activation.
    scrollTop: Number.isFinite(view.scrollTop) ? Math.max(0, view.scrollTop) : 0,
  };
}

export async function restoreFileCard(view, record = {}) {
  const result = { rootRestored: false, draftRestored: false, fileRestored: false, errors: [] };
  if (record.root?.rootId && record.root?.directoryId) {
    try { await view.openRoot(copy(record.root)); result.rootRestored = true; }
    catch (error) { result.errors.push({ scope: 'root', message: error.message, code: error.code }); }
  }
  // A persistent managed draft can remain readable when its old source handle
  // has expired. The factory revalidates the draft/file binding itself.
  if (record.draftId) {
    try { await view.restoreDraft({ draftId: record.draftId }); result.draftRestored = true; }
    catch (error) { result.errors.push({ scope: 'draft', message: error.message, code: error.code }); }
  } else if (record.fileId && result.rootRestored) {
    try { await view.openFile(record.fileId, null, { focus: false }); result.fileRestored = true; }
    catch (error) { result.errors.push({ scope: 'file', message: error.message, code: error.code }); }
  }
  return result;
}

export function createFileCloseGate({ dispose, onState = () => {} }) {
  let pending = null, closed = false;
  return {
    requestClose() {
      if (closed) return Promise.resolve(true);
      if (pending) return pending;
      onState({ status: 'closing', message: '편집 내용을 기록하고 있습니다…' });
      pending = Promise.resolve().then(async () => {
        try {
          if (await dispose() !== true) {
            onState({ status: 'blocked', message: '파일 창을 닫지 못했습니다. 입력·저장 상태를 확인한 뒤 다시 닫아 주세요.' });
            return false;
          }
          closed = true;
          onState({ status: 'closed', message: '' });
          return true;
        } catch (error) {
          onState({ status: 'blocked', message: `파일 창을 유지했습니다: ${error.message}` });
          return false;
        } finally { pending = null; }
      });
      return pending;
    },
  };
}
