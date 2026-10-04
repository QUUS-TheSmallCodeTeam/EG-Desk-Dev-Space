// Native Firefox Download objects remain the authority. EG-Desk never treats a
// URL, filename, or container alone as proof of a Board/Card association.

function nativeParts() {
  try {
    if (typeof globalThis.ChromeUtils?.importESModule !== 'function') return {};
    return {
      downloads: globalThis.ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs').Downloads,
      ioUtils: globalThis.IOUtils,
    };
  } catch {
    return {};
  }
}

function integerOrNull(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function basename(path) {
  return typeof path === 'string' ? path.split(/[\\/]/).at(-1) : null;
}

function nativeState(download) {
  if (download.stopped !== true) return download.canceled === true ? 'cancelling' : 'running';
  if (download.succeeded === true && download.stopped === true &&
      download.canceled !== true && !download.error && !download.hasBlockedData &&
      !download.hasPartialData) return 'succeeded';
  if (download.canceled === true) return 'cancelled';
  if (download.error) return 'failed';
  return 'stopped';
}

const ERROR_FLAGS = ['becauseSourceFailed', 'becauseTargetFailed', 'becauseBlocked',
  'becauseBlockedByParentalControls', 'becauseBlockedByReputationCheck',
  'becauseBlockedByContentAnalysis'];
let adapterSequence = 0;

function blocked(download) {
  return download.hasBlockedData === true || ERROR_FLAGS.slice(2).some((key) => download.error?.[key] === true);
}

function capture(download) {
  return {
    succeeded: download.succeeded, stopped: download.stopped, canceled: download.canceled,
    error: download.error, partial: download.hasPartialData, blocked: blocked(download),
    path: download.target?.path, partPath: download.target?.partFilePath,
    entityID: download.saver?.entityID,
    browsingContextId: download.source?.browsingContextId,
    userContextId: download.source?.userContextId, isPrivate: download.source?.isPrivate,
  };
}

function unchanged(download, snapshot) {
  const current = capture(download);
  return Object.keys(snapshot).every((key) => current[key] === snapshot[key]);
}

function missingFile(error) {
  return ['NotFoundError', 'ENOENT', 'NS_ERROR_FILE_NOT_FOUND'].includes(error?.name) ||
    error?.code === 'ENOENT';
}

/**
 * Returns an adapter over Downloads.ALL. IDs are EG-Desk session-local handles
 * for native Download objects, not invented persistent Firefox download IDs.
 * No disk journal is written; private downloads and source URLs are not logged.
 * Call start() once to register the native view, and await stop() on UI teardown.
 * onChange({type,id}) invalidates a UI row; get(id) / list({browsingContextId})
 * perform current metadata checks. Unknown contexts never match a scoped list
 * unless includeUnknown:true is explicitly requested. Actions require
 * {explicitUserRequest:true}; open/show/resume report dispatch, not OS completion.
 * Native API reference (interface use only; no Mozilla implementation copied):
 * https://firefox-source-docs.mozilla.org/toolkit/components/downloads/index.html
 */
export async function openDownloadsAdapter({ downloads, ioUtils, onChange } = {}) {
  const injected = downloads !== undefined || ioUtils !== undefined;
  const native = injected ? {} : nativeParts();
  const api = downloads ?? native.downloads;
  const io = ioUtils ?? native.ioUtils;
  const mode = injected ? 'injected' : api && io ? 'gecko-native' : 'unavailable';
  const supported = typeof api?.getList === 'function' && api.ALL !== undefined &&
    typeof io?.stat === 'function';
  let list = null;
  let started = false;
  let requested = false;
  let epoch = 0;
  let transition = Promise.resolve();
  let activeView = null;
  let sequence = 0;
  const sessionId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++adapterSequence}`;
  let byObject = new WeakMap();
  const byId = new Map();
  const paused = new WeakSet();

  function remember(download) {
    if (!download || typeof download !== 'object') return null;
    let id = byObject.get(download);
    if (!id) {
      id = `egdesk-download-${sessionId}-${++sequence}`;
      byObject.set(download, id);
      byId.set(id, download);
    }
    return id;
  }

  function notify(type, download) {
    const id = type === 'added' ? remember(download) : byObject.get(download);
    if (!id || typeof onChange !== 'function') return;
    try { onChange({ type, id }); } catch { /* UI observer cannot affect Firefox */ }
  }

  function makeView(token) {
    const active = () => started && requested && epoch === token;
    return {
      onDownloadAdded(download) { if (active()) notify('added', download); },
      onDownloadChanged(download) { if (active()) notify('changed', download); },
      onDownloadRemoved(download) {
        if (!active()) return;
        const id = byObject.get(download);
        if (!id) return;
        byId.delete(id);
        byObject.delete(download);
        paused.delete(download);
        try { onChange?.({ type: 'removed', id }); } catch { /* UI observer is isolated */ }
      },
    };
  }

  function clear() {
    started = false;
    byId.clear();
    byObject = new WeakMap();
  }

  function start() {
    if (!supported) return Promise.resolve({ supported: false, mode });
    if (requested) return transition;
    requested = true;
    const token = ++epoch;
    const work = transition.catch(() => {}).then(async () => {
      if (!requested || epoch !== token) return { supported: true, mode, observing: false };
      if (list && activeView) {
        await list.removeView(activeView);
        list = null;
        activeView = null;
      }
      const nativeList = await api.getList(api.ALL);
      if (!requested || epoch !== token) return { supported: true, mode, observing: false };
      if (!nativeList || typeof nativeList.addView !== 'function' ||
          typeof nativeList.removeView !== 'function') {
        requested = false;
        return { supported: false, mode, observing: false };
      }
      if (!requested || epoch !== token) return { supported: true, mode, observing: false };
      const view = makeView(token);
      list = nativeList;
      activeView = view;
      started = true;
      try {
        // addView supplies the existing list and subsequent changes, avoiding a
        // second getAll snapshot that could resurrect an already removed item.
        await nativeList.addView(view);
        if (!requested || epoch !== token) {
          await nativeList.removeView(view);
          list = null;
          activeView = null;
          clear();
        }
        return { supported: true, mode, observing: started };
      } catch (error) {
        if (epoch === token) requested = false;
        clear();
        await nativeList.removeView(view);
        list = null;
        activeView = null;
        throw error;
      }
    });
    transition = work.catch((error) => {
      if (epoch === token) requested = false;
      throw error;
    });
    return transition;
  }

  function stop() {
    requested = false;
    epoch += 1;
    clear();
    const work = transition.catch(() => {}).then(async () => {
      if (list && activeView) await list.removeView(activeView);
      list = null;
      activeView = null;
      return { supported, mode, observing: false };
    });
    transition = work;
    return work;
  }

  async function statFile(path) {
    if (typeof path !== 'string' || !path) return { state: 'unknown', metadata: null };
    try {
      const stat = await io.stat(path);
      if (stat?.type !== 'regular' || !Number.isSafeInteger(stat.size) || stat.size < 0) {
        return { state: 'not-regular', metadata: null };
      }
      return { state: 'present', metadata: {
        path,
        size: stat.size,
        lastModified: Number.isFinite(stat.lastModified) ? stat.lastModified : null,
      } };
    } catch (error) {
      return { state: missingFile(error) ? 'missing' : 'unknown', metadata: null };
    }
  }

  async function resumable(download) {
    if (download.stopped !== true || download.succeeded === true ||
        blocked(download) || download.hasPartialData !== true || !download.saver?.entityID ||
        typeof download.target?.partFilePath !== 'string') return false;
    const partial = await statFile(download.target.partFilePath);
    return partial.state === 'present' && partial.metadata.size > 0;
  }

  async function describe(id) {
    if (!started) return null;
    const download = byId.get(id);
    if (!download) return null;
    const snapshot = capture(download);
    const source = download.source ?? {};
    const native = nativeState(download);
    const finalFile = native === 'succeeded' ? await statFile(download.target?.path) :
      { state: 'not-complete', metadata: null };
    let canResume = await resumable(download);
    if (!started || byId.get(id) !== download) return null;
    const stable = unchanged(download, snapshot);
    if (!stable) canResume = false;
    const status = native === 'succeeded' ?
      stable && finalFile.state === 'present' ? 'completed' : 'completed-file-unverified' :
      native === 'cancelled' && canResume && paused.has(download) ? 'paused' : native;
    const browsingContextId = stable ? integerOrNull(source.browsingContextId, 1) : null;
    return {
      id,
      idScope: 'adapter-session',
      nativeId: typeof download.guid === 'string' ? download.guid : null,
      status: stable ? status : 'unverified',
      nativeState: stable ? native : nativeState(download),
      fileState: stable ? finalFile.state : 'changed-during-inspection',
      file: stable ? finalFile.metadata : null,
      contentVerification: 'not-performed',
      filename: basename(download.target?.path),
      currentBytes: integerOrNull(download.currentBytes),
      totalBytes: download.hasProgress === true ? integerOrNull(download.totalBytes) : null,
      progress: download.hasProgress === true && Number.isFinite(download.progress) ? download.progress : null,
      hasPartialData: download.hasPartialData === true,
      canResume,
      canOpen: stable && status === 'completed',
      error: download.error ? Object.fromEntries(ERROR_FLAGS.map((key) =>
        [key, download.error[key] === true])) : null,
      browsingContextId,
      userContextId: stable ? integerOrNull(source.userContextId) : null,
      cookieStoreId: stable && typeof source.cookieStoreId === 'string' ? source.cookieStoreId : null,
      association: browsingContextId === null ? 'unknown' : 'browser-context',
      boardRef: null,
      isPrivate: source.isPrivate === true,
    };
  }

  async function listDownloads({ browsingContextId = null, includeUnknown = false } = {}) {
    if (!started) return [];
    if (browsingContextId !== null && integerOrNull(browsingContextId, 1) === null) {
      throw new TypeError('browsingContextId must be a positive integer');
    }
    const results = [];
    for (const id of [...byId.keys()]) {
      const item = await describe(id);
      if (!item) continue;
      if (browsingContextId !== null && item.browsingContextId !== browsingContextId &&
          !(includeUnknown && item.browsingContextId === null)) continue;
      results.push(item);
    }
    return results;
  }

  async function search(query, options = {}) {
    if (typeof query !== 'string' || query.length > 256) throw new TypeError('Invalid search text');
    const term = query.trim().toLocaleLowerCase();
    const matches = [];
    for (const item of await listDownloads(options)) {
      const download = byId.get(item.id);
      const sourceUrl = typeof download?.source?.url === 'string' ? download.source.url : '';
      if (!term || item.filename?.toLocaleLowerCase().includes(term) ||
          sourceUrl.toLocaleLowerCase().includes(term)) matches.push(item);
    }
    return matches;
  }

  function requireAction(id, explicitUserRequest) {
    if (explicitUserRequest !== true) return { error: { status: 'denied',
      reason: 'explicit-user-request-required' } };
    if (!started || !byId.has(id)) return { error: { status: 'unavailable' } };
    return { download: byId.get(id) };
  }

  async function pause(id, { explicitUserRequest } = {}) {
    const action = requireAction(id, explicitUserRequest);
    if (action.error) return action.error;
    const download = action.download;
    if (nativeState(download) !== 'running' || !download.saver?.entityID ||
        blocked(download) || !download.target?.partFilePath ||
        typeof download.cancel !== 'function') return { status: 'unsupported' };
    download.tryToKeepPartialData = true;
    await download.cancel();
    if (await resumable(download)) paused.add(download);
    return { status: (await describe(id))?.status ?? 'unavailable' };
  }

  async function resume(id, { explicitUserRequest } = {}) {
    const action = requireAction(id, explicitUserRequest);
    if (action.error) return action.error;
    const download = action.download;
    const before = capture(download);
    if (!(await resumable(download)) || typeof download.start !== 'function') {
      return { status: 'unsupported' };
    }
    if (!started || byId.get(id) !== download || !unchanged(download, before)) {
      return { status: 'unavailable' };
    }
    // start() resolves only when the transfer finishes; do not hold a UI turn
    // or claim completion from the dispatch promise.
    paused.delete(download);
    try { void Promise.resolve(download.start()).catch(() => notify('resume-failed', download)); }
    catch { return { status: 'unavailable' }; }
    return { status: 'resume-requested' };
  }

  async function cancel(id, { explicitUserRequest } = {}) {
    const action = requireAction(id, explicitUserRequest);
    if (action.error) return action.error;
    if (typeof action.download.cancel !== 'function') return { status: 'unsupported' };
    paused.delete(action.download);
    await action.download.cancel();
    return { status: (await describe(id))?.status ?? 'unavailable' };
  }

  async function show(id, { explicitUserRequest } = {}) {
    const action = requireAction(id, explicitUserRequest);
    if (action.error) return action.error;
    if (typeof action.download.showContainingDirectory !== 'function') {
      return { status: 'unsupported' };
    }
    await action.download.showContainingDirectory();
    return { status: 'show-requested' };
  }

  async function open(id, { explicitUserRequest } = {}) {
    const action = requireAction(id, explicitUserRequest);
    if (action.error) return action.error;
    const download = action.download;
    const beforePath = download.target?.path;
    const item = await describe(id);
    if (!item?.canOpen || typeof download.launch !== 'function' ||
        !started || byId.get(id) !== download ||
        download.target?.path !== beforePath || nativeState(download) !== 'succeeded') {
      return { status: 'not-openable' };
    }
    // Firefox's own launch path retains its platform and download safety policy.
    await download.launch();
    return { status: 'launch-requested', file: item.file };
  }

  return { supported, mode, start, stop, get: describe, list: listDownloads, search,
    pause, resume, cancel, show, open };
}
