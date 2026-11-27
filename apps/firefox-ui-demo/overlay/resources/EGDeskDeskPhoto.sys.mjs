// PRIVILEGED FIRST-PARTY CHROME ONLY. This is an opt-in local preview raster,
// never a serialized DOM, live-window paint, screenshot API, service or transport.
import { capturePositivePhoto } from './EGDeskLayoutPhoto.sys.mjs';

const XHTML = 'http://www.w3.org/1999/xhtml';
const MAX_MEMO = 2000;
const editors = new WeakMap();
const savedBodies = new WeakMap();
const is = (n, tag, cls) => n?.namespaceURI === XHTML && n.localName === tag && n.classList.contains(cls);
const privateNode = n => n.hasAttribute('data-capture-private') || n.hasAttribute('data-private') || n.isContentEditable;
const saneRecord = r => r?.author?.kind === 'user' && typeof r.id === 'string' && r.id.length > 0 &&
  Number.isSafeInteger(r.revision) && r.revision >= 0 && typeof r.text === 'string' && r.text.length <= MAX_MEMO;

// Called only by the native memo constructor with its exact editor; no capture-time
// selector/query can substitute a form field. Do not put textarea data in this registry.
export function registerDeskMemoPhotoEditor(root, editor, isEditing) {
  if (!editors.has(root) && typeof isEditing === 'function') editors.set(root, { editor, isEditing });
}

// Call *after* the existing local Desk snapshot write succeeded, with that snapshot's
// exact memo runtimeState (not the current unsaved object). Never saves anything itself.
export function noteDeskMemoPhotoSaved(root, persisted) {
  if (!editors.has(root)) return;
  if (!saneRecord(persisted) || persisted.id !== root.dataset.memoId) { savedBodies.delete(root); return; }
  savedBodies.set(root, { id: persisted.id, revision: persisted.revision, text: persisted.text });
}

function memoRoot(root, layer, document) {
  return is(root, 'div', 'egd-memo-card') && root.classList.contains('egd-canvas-card') &&
    root.classList.contains('egd-desk-window') && root.ownerDocument === document && root.isConnected &&
    root.parentElement === layer && root.dataset.testid === 'memo-card' && root.dataset.deskWindowKind === 'memo' &&
    !root.dataset.jointManaged && !root.dataset.jointScope && root._deskWindowShell?.root === root &&
    !root.classList.contains('egd-card-collapsed') && !root._memoDragging && !privateNode(root) && editors.has(root);
}
function readMemo(root, document) {
  const { editor, isEditing } = editors.get(root);
  const body = root._deskWindowShell.slots?.content;
  if (!is(body, 'div', 'egd-memo-card-body') || body.parentElement !== root || privateNode(body) ||
      !is(editor, 'textarea', 'egd-memo-text') || !editor.isConnected || editor.ownerDocument !== document ||
      editor.dataset.testid !== 'memo-text' || editor.disabled || editor.readOnly || !is(editor.parentElement, 'div', 'egd-memo-body') ||
      editor.parentElement.parentElement !== body || privateNode(editor) || privateNode(editor.parentElement) ||
      document.activeElement === editor || root._memoTextDirty || isEditing() !== false ||
      editor.scrollTop !== 0 || editor.scrollLeft !== 0 || editor.scrollHeight > editor.clientHeight + 1) return null;
  const record = root._memoRecord, saved = savedBodies.get(root);
  if (!saneRecord(record) || !record.text.trim() || /[\r\t]/.test(record.text) || record.id !== root.dataset.memoId ||
      !saved || saved.id !== record.id || saved.revision !== record.revision || saved.text !== record.text) return null;
  // Comparison only, performed after the closed editing/saved gates. The sole text
  // source for paint is the current saved `_memoRecord.text`, not the native editor.
  if (editor.value !== record.text) return null;
  return { editor, record, revision: record.revision, text: record.text };
}

// Trusted chrome caller: invoke only after the user explicitly picks Image Review.
// isCurrent binds window/profile (non-private), workplane/camera, exact selection,
// current root identity/revisions and grants until local preview; authorize must be
// a positive approval per named slot: own native memo or joint card with active
// pixel-disclosure grant for its exact projection. A local memo uses projectionId:null.
// Items are one approved explicit set, not a discovery query. Null => no photo.
export async function captureDeskPhoto(params = {}) {
  if (params.imageReview !== true || typeof params.authorize !== 'function' ||
      params.document?.documentURI !== 'chrome://browser/content/browser.xhtml' || params.window?.docShell?.usePrivateBrowsing === true) return null;
  const { authorize } = params;
  return capturePositivePhoto(params, { authorize, memoRoot, readMemo });
}
