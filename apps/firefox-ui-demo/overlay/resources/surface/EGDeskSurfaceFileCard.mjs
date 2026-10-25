// Moved verbatim from overlay/JS/eg-desk-surface.uc.js.
// Loaded once per window: ChromeUtils.importESModule(url, { global: 'current' }).
// Never statically import a .sys.mjs here; shared modules arrive through deps.
export function createFileCardZone(deps) {
  const {
    FileCardState,
    allocCardSeq,
    boardNotice,
    chatBindingNonce,
    chatInputSourceForView,
    cloneJson,
    el,
    focusCanvasCard,
    getCodexThreadById,
    markAgendaDirty,
    openChatInputPanel,
    resolveCanvasCardPlacement,
    revealPlacedCanvasCard,
    spawnDeskWindowShell,
    state,
  } = deps;

  async function requestLocalFilePacket(path, body, requestOptions = {}) {
    if (!/^\/v1\/files\//.test(path)) throw new Error('허용되지 않은 파일 서비스 경로입니다.');
    const headers = { 'Content-Type': 'application/json' };
    for (const [name, value] of Object.entries(requestOptions.headers || {})) {
      if (name.toLowerCase() !== 'x-egdesk-picker-channel' || typeof value !== 'string') throw new Error('허용되지 않은 파일 채널 헤더입니다.');
      headers['X-EGDesk-Picker-Channel'] = value;
    }
    const controller = new window.AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`http://127.0.0.1:39218${path}`, { method: 'POST', signal: controller.signal,
        headers, body: JSON.stringify(body) });
      const packet = await response.json();
      if (!response.ok || packet?.ok !== true) {
        // Preserve helper warnings without passing arbitrary response properties
        // onto the Error object or accepting prototype keys from JSON.
        const sanitizeDetails = (value, depth = 0) => {
          if (value === null || typeof value === 'boolean') return value;
          if (typeof value === 'string') return value.slice(0, 4096);
          if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
          if (depth >= 6 || !value || typeof value !== 'object') return undefined;
          if (Array.isArray(value)) return value.slice(0, 128).map(item => sanitizeDetails(item, depth + 1));
          return Object.fromEntries(Object.entries(value).slice(0, 64)
            .filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
            .map(([key, item]) => [key, sanitizeDetails(item, depth + 1)]));
        };
        const details = packet?.details && typeof packet.details === 'object' && !Array.isArray(packet.details)
          ? sanitizeDetails(packet.details) : undefined;
        throw Object.assign(new Error(packet?.error || '파일 요청을 완료하지 못했습니다.'),
          { code: packet?.code, status: response.status, ...(details ? { details } : {}) });
      }
      return packet;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('파일 요청의 완료를 확인하지 못했습니다. 편집 내용을 유지하고 상태를 다시 확인하세요.');
      throw error;
    } finally { window.clearTimeout(timer); }
  }

  function pickNativeFileDirectory() {
    return new Promise((resolve, reject) => {
      try {
        const picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
        picker.init(window.browsingContext, 'EG-Desk에 연결할 폴더', Ci.nsIFilePicker.modeGetFolder);
        picker.open(result => {
          try { resolve(result === Ci.nsIFilePicker.returnOK ? picker.file.path : null); }
          catch (error) { reject(error); }
        });
      } catch (error) { reject(error); }
    });
  }

  function pickNativeFileSaveFile({ defaultName = 'copy.txt' } = {}) {
    return new Promise((resolve, reject) => {
      try {
        const picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
        picker.init(window.browsingContext, '작업사본을 새 파일로 저장', Ci.nsIFilePicker.modeSave);
        picker.defaultString = defaultName;
        picker.appendFilters(Ci.nsIFilePicker.filterAll);
        picker.open(result => {
          try {
            if (result === Ci.nsIFilePicker.returnCancel) { resolve(null); return; }
            if (result === Ci.nsIFilePicker.returnReplace || picker.file.exists()) throw new Error('기존 파일은 덮어쓰지 않습니다. 다른 이름을 선택해 주세요.');
            if (result !== Ci.nsIFilePicker.returnOK) throw new Error('저장 위치 선택을 확인하지 못했습니다.');
            resolve({ parentPath: picker.file.parent.path, fileName: picker.file.leafName });
          } catch (error) { reject(error); }
        });
      } catch (error) { reject(error); }
    });
  }

  function spawnFileCard(options = {}) {
    if (options.openMode !== 'new' && !options.restore) {
      const existing = document.querySelector('.egd-file-card');
      if (existing) { focusCanvasCard(existing); return existing; }
    }
    const placement = resolveCanvasCardPlacement('file');
    const shell = spawnDeskWindowShell({ id: `egd-file-card-${allocCardSeq()}`, kind: 'file', className: 'egd-file-card',
      activate: !options.restore, sourceRef: { kind: 'file-surface', id: `file-view-${chatBindingNonce()}`, scope: 'local-files' },
      style: { left: `${placement.x}px`, top: `${placement.y}px`, width: `${placement.width}px`, height: `${placement.height}px` } });
    const card = shell.root;
    if (!options.restore) revealPlacedCanvasCard(card, placement);
    card.dataset.testid = 'file-card';
    card.setAttribute('aria-label', '파일 작업 창');
    const title = el('strong', { class: 'egd-file-card-title' }, '파일');
    const badge = el('span', { class: 'egd-file-card-state', role: 'status', data: { testid: 'file-card-status' } }, '준비 중');
    shell.slots.identity.append(title, badge);
    const attachButton = el('button', { type: 'button', class: 'egd-file-chat-attach', disabled: 'true',
      'aria-label': '현재 작업사본을 Chat에 첨부', data: { testid: 'file-chat-attach' }, onclick: (event) => {
        event.stopPropagation();
        const threadId = state.codex.activeThreadId;
        if (!threadId || !getCodexThreadById(state.codex, threadId)) { boardNotice('채팅방을 먼저 선택해 주세요.'); return; }
        if (!chatInputSourceForView(card)) { boardNotice('첨부할 작업사본을 먼저 열어 주세요.'); return; }
        openChatInputPanel(threadId, { viewIds: [card.id] });
      } }, 'Chat에 첨부');
    shell.slots.actions.appendChild(attachButton);
    const notice = el('div', { class: 'egd-file-card-notice', role: 'status', hidden: true, data: { testid: 'file-card-notice' } });
    const mount = el('div', { class: 'egd-file-card-mount' });
    shell.slots.content.append(notice, mount);
    let rootHandle = options.record?.root || null;
    let view = null;
    let restoring = !!options.record;
    let preserveRestoreRecord = false;
    let rootNeedsReconnect = false;
    card._fileRecord = cloneJson(options.record || FileCardState.fileCardRecord(null));
    const publish = snapshot => {
      if (!card.isConnected || restoring) return;
      const failedOriginal = preserveRestoreRecord && (!snapshot.fileId || (snapshot.fileId === options.record?.fileId && options.record?.draftId && !snapshot.draftId));
      if (!failedOriginal) {
        card._fileRecord = FileCardState.fileCardRecord(rootHandle, snapshot);
        preserveRestoreRecord = false;
      }
      badge.textContent = failedOriginal ? '복구 확인 필요' : rootNeedsReconnect || snapshot.sourceConnection === 'reconnect-required' ? '보관 사본 · 원본 재연결 필요' : snapshot.dirty ? '작업사본 · 미저장' : '파일';
      title.textContent = rootHandle?.name || '파일';
      attachButton.disabled = !snapshot.fileId || !snapshot.draftId;
      markAgendaDirty('file-view-state', card);
    };
    const ready = (async () => {
      try {
        const fileModule = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskFileView.sys.mjs');
        const service = fileModule.createEGDeskFileServiceCallbacks({ request: requestLocalFilePacket });
        const pickers = fileModule.createEGDeskNativeFilePickers({ service, pickDirectory: pickNativeFileDirectory, pickSaveFile: pickNativeFileSaveFile });
        view = fileModule.createEGDeskFileView({ document, service,
          chooseRoot: async () => {
            const selected = await pickers.chooseRoot();
            if (selected) { rootHandle = selected; rootNeedsReconnect = false; notice.hidden = true; }
            return selected;
          },
          chooseSaveAs: options => pickers.chooseSaveAs(options),
          onState: publish,
        });
        card._fileView = view;
        view.element.inert = !!options.record;
        view.element.setAttribute('aria-busy', String(!!options.record));
        mount.appendChild(view.element);
        view.element.dataset.testid = 'file-view';
        for (const [selector, testid] of Object.entries({
          '.egdesk-file-connect': 'file-connect-root', '.egdesk-file-tree': 'file-tree', '.egdesk-file-search-input': 'file-search',
          '.egdesk-file-editor': 'file-editor', '.egdesk-file-review-button': 'file-review',
          '.egdesk-file-save-button': 'file-save-copy', '.egdesk-file-save-as-button': 'file-save-as', '.egdesk-file-reconnect-button': 'file-reconnect-source',
        })) view.element.querySelector(selector)?.setAttribute('data-testid', testid);
        if (options.record) {
          const result = await FileCardState.restoreFileCard(view, options.record);
          preserveRestoreRecord = !result.draftRestored && !result.fileRestored && !!(options.record.fileId || options.record.draftId);
          rootNeedsReconnect = result.errors.some(error => error.scope === 'root');
          if (result.errors.length) {
            notice.hidden = false;
            notice.textContent = result.draftRestored
              ? '보관된 작업사본을 열었습니다. 원본 폴더는 다시 연결해야 합니다. 원본 권한을 자동으로 복원하지 않았습니다.'
              : `이전 연결을 확인하지 못했습니다. 폴더를 다시 연결해 주세요. ${result.errors.map(error => error.message).join(' ')}`;
          }
          const scroller = view.element.querySelector('.egdesk-file-editor-label:not([hidden]) .egdesk-file-editor, .egdesk-file-viewer:not([hidden])');
          if (scroller) scroller.scrollTop = options.record.scrollTop || 0;
          card.dataset.restored = 'true';
        }
        restoring = false;
        publish(view.snapshot());
      } catch (error) {
        restoring = false;
        notice.hidden = false;
        notice.textContent = `파일 화면을 준비하지 못했습니다: ${error.message}`;
        badge.textContent = '연결 확인 필요';
      } finally { if (view) { view.element.inert = false; view.element.setAttribute('aria-busy', 'false'); } }
    })();
    const closeGate = FileCardState.createFileCloseGate({
      dispose: async () => { await ready; return view ? view.close() : true; },
      onState: status => {
        card.dataset.closeState = status.status;
        if (status.status !== 'closed') { notice.hidden = false; notice.textContent = status.message; }
      },
    });
    card._beforeClose = () => closeGate.requestClose();
    card._fileReady = ready;
    return card;
  }

  return { spawnFileCard };
}
