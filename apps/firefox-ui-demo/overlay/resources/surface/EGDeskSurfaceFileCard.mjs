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
    getProjectTarget,
    markAgendaDirty,
    openChatInputPanel,
    resolveCanvasCardPlacement,
    revealPlacedCanvasCard,
    spawnDeskWindowShell,
    spawnTerminalCard,
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

  const verifiedRunOpens = new WeakSet();
  const validRunId = value => typeof value === 'string' && !!value.trim() && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value);
  const absoluteRunPath = value => typeof value === 'string' && value.length <= 4096
    && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value)) && !/[\u0000-\u001f\u007f]|\[redacted\]|•••/i.test(value);

  // readOrigin is the activity's account/epoch-bound GET reader. The target's
  // itemId stays in that local fence, never in the server origin query. No
  // supplied path, Board, cached origin or picker can authorize this opening.
  async function openVerifiedRunFile({ target, location, readOrigin, isCurrent, signal } = {}) {
    if (!['conversationId', 'runId', 'itemId'].every(key => validRunId(target?.[key]))
        || !absoluteRunPath(location?.path) || !Number.isSafeInteger(location?.line) || location.line < 1
        || location.column != null && (!Number.isSafeInteger(location.column) || location.column < 1)
        || typeof readOrigin !== 'function' || typeof isCurrent !== 'function') return { status: 'unavailable' };
    const selected = Object.freeze(Object.fromEntries(['conversationId', 'runId', 'itemId'].map(key => [key, target[key]])));
    const place = Object.freeze({ path: location.path, line: location.line, column: location.column ?? null });
    const current = () => {
      try { return !signal?.aborted && isCurrent(selected) === true; } catch { return false; }
    };
    if (!current()) return { status: 'stale' };
    let response;
    try { response = await readOrigin(selected, { signal }); }
    catch { return { status: current() ? 'unavailable' : 'stale' }; }
    if (!current()) return { status: 'stale' };
    if (response?.protocolVersion !== 1 || response.verified !== true || response.status !== 'verified'
        || response.conversationId !== selected.conversationId || response.runId !== selected.runId
        || !['projectId', 'rootId', 'directoryId'].every(key => validRunId(response[key]))
        || !absoluteRunPath(response.displayPath)) return { status: 'unavailable' };
    const origin = Object.freeze({ projectId: response.projectId, rootId: response.rootId,
      directoryId: response.directoryId, displayPath: response.displayPath });
    const verify = async () => {
      if (!current()) throw new Error('실행 파일 요청이 더 이상 유효하지 않습니다.');
      const latest = await readOrigin(selected, { signal });
      if (!current() || latest?.protocolVersion !== 1 || latest.status !== 'verified' || latest.verified !== true
          || latest.conversationId !== selected.conversationId || latest.runId !== selected.runId
          || Object.keys(origin).some(key => latest[key] !== origin[key])) throw new Error('실행의 현재 폴더 연결이 바뀌었습니다.');
    };
    const opening = Object.freeze({ target: selected, location: place, origin, current, verify, signal });
    verifiedRunOpens.add(opening);
    const card = spawnFileCard({ openMode: 'new', verifiedRunOpen: opening });
    const ready = await card._fileReady;
    if (!current() || !card.isConnected || card.dataset.closeState || card._fileOpenStatus === 'stale') return { status: 'stale' };
    return ready === true && card._fileOpenStatus === 'opened' ? { status: 'opened', cardId: card.id } : { status: 'unavailable' };
  }

  function spawnFileCard(options = {}) {
    const runFile = options.verifiedRunOpen || null;
    if (runFile && !verifiedRunOpens.delete(runFile)) throw new Error('확인된 실행 파일 요청이 필요합니다.');
    if (options.openMode !== 'new' && !options.restore && !options.project) {
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
    const title = el('strong', { class: 'egd-file-card-title', title: '파일' }, '파일');
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
    let restoring = !!options.record || !!runFile;
    let openingCancelled = false, originOpened = false, runFileOrigin = null;
    let preserveRestoreRecord = false;
    let rootNeedsReconnect = false;
    let projectTarget = options.projectTarget ? Object.freeze({ boardId: options.projectTarget.boardId, title: options.projectTarget.title }) : null;
    let projectConnection = null;
    let projectReference = FileCardState.fileCardRecord(null, {}, options.record?.project).project || null;
    let ownedRunner = null;
    card._fileRecord = cloneJson(options.record || FileCardState.fileCardRecord(null));
    const publish = snapshot => {
      if (!card.isConnected || restoring) return;
      const failedOriginal = preserveRestoreRecord && (!snapshot.fileId || (snapshot.fileId === options.record?.fileId && options.record?.draftId && !snapshot.draftId));
      if (!failedOriginal) {
        card._fileRecord = FileCardState.fileCardRecord(rootHandle, snapshot, projectReference);
        preserveRestoreRecord = false;
      }
      badge.textContent = failedOriginal ? '복구 확인 필요' : rootNeedsReconnect || snapshot.sourceConnection === 'reconnect-required' ? '보관 사본 · 원본 재연결 필요' : snapshot.dirty ? '작업사본 · 미저장' : '파일';
      if (runFileOrigin) {
        if (snapshot.rootId === runFileOrigin.rootId && snapshot.fileId === runFileOrigin.fileId && snapshot.sourceConnection !== 'reconnect-required') {
          badge.textContent = snapshot.dirty ? '현재 파일 · 작업사본 미저장' : '현재 파일';
        } else {
          runFileOrigin = null;
          notice.hidden = true; notice.replaceChildren();
        }
      }
      title.textContent = rootHandle?.name || '파일';
      title.title = title.textContent;
      attachButton.disabled = !snapshot.fileId || !snapshot.draftId;
      markAgendaDirty('file-view-state', card);
    };
    const ready = (async () => {
      try {
        const fileModule = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskFileView.sys.mjs');
        const service = { ...fileModule.createEGDeskFileServiceCallbacks({ request: requestLocalFilePacket }) };
        if (runFile) {
          // File handles alone can outlive a project detach. Revalidate the
          // pinned origin after each service await before releasing its result
          // to the view. This never registers/reconnects a stored path.
          for (const name of ['listDirectory', 'resolvePath', 'readFile', 'readDraft', 'createDraft']) {
            const read = service[name];
            if (typeof read !== 'function') continue;
            service[name] = async (...args) => {
              if (originOpened) return read(...args);
              const current = () => !openingCancelled && card.isConnected && runFile.current();
              if (!current()) throw new Error('실행 파일 요청이 더 이상 유효하지 않습니다.');
              const value = await read(...args);
              if (!current()) throw new Error('실행 파일 요청이 더 이상 유효하지 않습니다.');
              await runFile.verify();
              if (!current()) throw new Error('실행 파일 요청이 더 이상 유효하지 않습니다.');
              return value;
            };
          }
        }
        const pickers = fileModule.createEGDeskNativeFilePickers({ service, pickDirectory: pickNativeFileDirectory, pickSaveFile: pickNativeFileSaveFile });
        const rememberProject = (project, target) => {
          projectTarget = Object.freeze({ boardId: target.boardId, title: target.title });
          projectConnection = Object.freeze({ projectId: project.projectId, rootId: project.rootId, displayPath: project.displayPath });
          projectReference = { boardId: target.boardId, projectId: project.projectId };
          rootHandle = { rootId: project.rootId, directoryId: project.directoryId, name: project.title || project.name,
            displayPath: project.displayPath, saveAsAvailable: project.saveAsAvailable };
          rootNeedsReconnect = false; notice.hidden = true;
        };
        const chooseProject = async target => {
          const bound = Object.freeze({ boardId: target.boardId, title: target.title });
          const existing = await service.openProject({ boardId: bound.boardId });
          let project = existing?.project;
          if (!card.isConnected) return null;
          if (!project || project.status === 'reconnect-required') project = await pickers.chooseProjectFolder(bound);
          if (!project || !card.isConnected) return null;
          if (project.status !== 'connected') throw new Error('프로젝트 폴더 연결을 확인하지 못했습니다.');
          const current = view.snapshot();
          if (current.projectId === project.projectId && current.rootId === project.rootId) {
            rememberProject(project, bound);
            view.setProjectScripts(project.scripts);
            return null; // Keep the selected file, caret and unsaved working copy.
          }
          if (current.dirty || current.originalDirty) {
            const next = spawnFileCard({ openMode: 'new', project, projectTarget: bound });
            if (!await next._fileReady) throw new Error('새 파일 카드에서 프로젝트를 열지 못했습니다. 기존 작업사본은 유지했습니다.');
            return null; // Never overwrite another project's dirty Card.
          }
          rememberProject(project, bound);
          return project;
        };
        const terminalApiFor = async terminalCard => {
          const started = Date.now();
          while (card.isConnected && view.element.isConnected && terminalCard?.isConnected && Date.now() - started < 15000) {
            const api = terminalCard._termBrowser?.contentWindow?.terminalAPI;
            if (typeof api?.runScript === 'function' && api.isConnected?.()) return api;
            await new Promise(resolve => window.setTimeout(resolve, 50));
          }
          throw Object.assign(new Error('터미널 준비를 확인하지 못했습니다. 명령은 다시 보내지 않습니다.'), { code: 'TERMINAL_NOT_READY' });
        };
        const runCheck = async ({ projectId, rootId, script }) => {
          if (!projectTarget?.boardId || !projectConnection || projectConnection.projectId !== projectId || projectConnection.rootId !== rootId || !script?.id) {
            throw Object.assign(new Error('검사할 보드 프로젝트와 저장된 명령을 먼저 선택하세요.'), { code: 'TERMINAL_RUN_REQUEST' });
          }
          // These are the Card's attached Board and root, not the currently
          // selected Board, and not a caller-supplied execution path.
          const target = { ...projectTarget }, connection = { ...projectConnection };
          const verified = (await service.openProject({ boardId: target.boardId }))?.project;
          if (!card.isConnected || verified?.status !== 'connected' || verified.projectId !== projectId || verified.rootId !== rootId
              || verified.displayPath !== connection.displayPath
              || !verified.scripts?.some(saved => saved.id === script.id && saved.name === script.name && saved.command === script.command)) {
            throw Object.assign(new Error('프로젝트 연결 또는 저장된 명령이 바뀌었습니다. 다시 확인한 뒤 검사를 누르세요.'), { code: 'TERMINAL_PROJECT_CHANGED' });
          }
          const reusable = ownedRunner?.idle && ownedRunner.card.isConnected && ownedRunner.projectId === projectId && ownedRunner.rootId === rootId
            && ownedRunner.api.isConnected?.() && ownedRunner.api.ptyId === ownedRunner.sessionId
            && Number.isInteger(ownedRunner.inputRevision) && ownedRunner.api.inputRevision?.() === ownedRunner.inputRevision;
          const terminalCard = reusable ? ownedRunner.card : spawnTerminalCard({ activate: false, reveal: false, projectId, rootId });
          const api = reusable ? ownedRunner.api : await terminalApiFor(terminalCard);
          const runner = { card: terminalCard, api, projectId, rootId, sessionId: api.ptyId, inputRevision: api.inputRevision?.(), idle: false };
          ownedRunner = runner;
          const result = await api.runScript({ boardId: target.boardId, projectId, rootId, script: { ...script } });
          runner.idle = ['completed', 'failed'].includes(result?.status) && Number.isInteger(result.exitCode)
            && result.projectId === projectId && result.rootId === rootId && result.sessionId === runner.sessionId
            && api.isConnected?.() && api.ptyId === runner.sessionId && api.inputRevision?.() === runner.inputRevision;
          return result;
        };
        view = fileModule.createEGDeskFileView({ document, service,
          chooseRoot: async () => {
            const selected = await pickers.chooseRoot();
            if (selected) { rootHandle = selected; projectTarget = null; projectConnection = null; projectReference = null; rootNeedsReconnect = false; notice.hidden = true; }
            return selected;
          },
          getProjectTarget: runFile ? undefined : getProjectTarget,
          chooseProject: !runFile && typeof getProjectTarget === 'function' ? chooseProject : undefined,
          chooseSaveAs: options => pickers.chooseSaveAs(options),
          runCheck: typeof spawnTerminalCard === 'function' ? runCheck : undefined,
          projectChecksOnly: true,
          onState: publish,
        });
        card._fileView = view;
        view.element.inert = !!options.record || !!runFile;
        view.element.setAttribute('aria-busy', String(!!options.record || !!runFile));
        mount.appendChild(view.element);
        view.element.dataset.testid = 'file-view';
        for (const [selector, testid] of Object.entries({
          '.egdesk-file-connect': 'file-connect-root', '.egdesk-file-tree': 'file-tree', '.egdesk-file-search-input': 'file-search',
          '.egdesk-file-project-connect': 'file-project-connect', '.egdesk-file-script-settings-button': 'file-script-settings',
          '.egdesk-file-project-check': 'file-project-check', '.egdesk-file-check-result': 'file-check-result',
          '.egdesk-file-editor': 'file-editor', '.egdesk-file-review-button': 'file-review',
          '.egdesk-file-save-button': 'file-save-copy', '.egdesk-file-save-as-button': 'file-save-as', '.egdesk-file-reconnect-button': 'file-reconnect-source',
        })) view.element.querySelector(selector)?.setAttribute('data-testid', testid);
        if (runFile) {
          const { origin, location, target } = runFile;
          const scope = Object.freeze({ rootId: origin.rootId, signal: runFile.signal,
            isCurrent: () => !openingCancelled && card.isConnected && view.element.isConnected && runFile.current() });
          rootHandle = { rootId: origin.rootId, directoryId: origin.directoryId, displayPath: origin.displayPath,
            name: origin.displayPath.split(/[\\/]/).filter(Boolean).at(-1) || '실행 폴더' };
          if (!scope.isCurrent() || !await view.openRoot(rootHandle, { project: null, scope }) || !scope.isCurrent()
              || !await view.openAt(location, { scope }) || !scope.isCurrent() || view.snapshot().rootId !== origin.rootId) {
            throw new Error('실행 파일을 여는 동안 연결이 바뀌었습니다.');
          }
          runFileOrigin = Object.freeze({ rootId: origin.rootId, fileId: view.snapshot().fileId });
          notice.replaceChildren(
            el('p', {}, `현재 파일 · 이전 실행 ${target.runId}의 출력에서 열었습니다.`),
            el('p', {}, `원래 대화 · ${target.conversationId} · 명령 항목 · ${target.itemId}`),
            el('p', {}, `경로 · ${location.path}`),
            el('p', {}, `당시 행 참조 · ${location.line}행${location.column ? ` ${location.column}열` : ''}. 현재 파일의 위치는 달라졌을 수 있으며, 당시 내용과 같음을 확인한 것은 아닙니다.`));
          notice.style.overflowWrap = 'anywhere';
          notice.hidden = false;
          originOpened = true; card._fileOpenStatus = 'opened';
        }
        if (options.project && projectTarget) {
          rememberProject(options.project, projectTarget);
          await view.openProject(options.project);
        }
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
          if (projectReference) {
            try {
              const project = (await service.openProject({ boardId: projectReference.boardId }))?.project;
              const restored = view.snapshot();
              const restoredDraft = restored.draftId ? await service.readDraft({ draftId: restored.draftId }) : null;
              if (project?.status !== 'connected' || project.projectId !== projectReference.projectId) {
                throw new Error('저장된 보드의 프로젝트 연결이 이전 파일 카드와 다릅니다.');
              }
              const contentBound = result.rootRestored && project.rootId === options.record.root?.rootId && restored.rootId === project.rootId
                && (!options.record.draftId || result.draftRestored)
                && (!restored.fileId || (restoredDraft?.rootId === project.rootId && restoredDraft.fileId === restored.fileId));
              const target = { boardId: projectReference.boardId, title: project.title };
              if (!contentBound && (options.record.fileId || options.record.draftId)) {
                // A helper restart can issue a new opaque root for the same
                // verified project. Open that project separately; never relabel
                // or reconnect an old managed draft by trusting a saved path.
                const next = spawnFileCard({ restore: true, project, projectTarget: target });
                if (!await next._fileReady) throw new Error('검증된 프로젝트를 다시 열지 못했습니다.');
                projectReference = null; projectTarget = null; projectConnection = null;
                // The previous content record remains recoverable, but only the
                // new project Card owns automatic project hydration next time.
                delete card._fileRecord.project;
                rootNeedsReconnect = true;
                notice.hidden = false;
                notice.textContent = '프로젝트 폴더 연결이 갱신되어 새 파일 카드에서 열었습니다. 이 카드에는 이전 파일 연결 정보와 복원 가능한 작업사본을 유지했습니다. 원본 재연결을 확인하세요.';
              } else {
                await view.openProject(project, { preserveDraft: contentBound });
                rememberProject(project, target);
              }
            } catch (error) {
              rootNeedsReconnect = true;
              notice.hidden = false;
              notice.textContent = `프로젝트 연결 확인 필요 · ${error.message} 이전 파일과 작업사본은 유지했습니다. 보드 프로젝트 연결에서 다시 확인하세요.`;
            }
          }
          const scroller = view.element.querySelector('.egdesk-file-editor-label:not([hidden]) .egdesk-file-editor, .egdesk-file-viewer:not([hidden])');
          if (scroller) scroller.scrollTop = options.record.scrollTop || 0;
          card.dataset.restored = 'true';
        }
        restoring = false;
        publish(view.snapshot());
        return true;
      } catch (error) {
        restoring = false;
        if (runFile) {
          card._fileOpenStatus = openingCancelled || !card.isConnected || !runFile.current() ? 'stale' : 'unavailable';
          // An unfinished origin Card must not retain a usable tree after its
          // source epoch is lost. Only this newly created Card is disposed.
          await view?.close().catch(() => {});
        }
        notice.hidden = false;
        notice.textContent = runFile ? '현재 파일을 열지 못했습니다. 원래 출력은 유지됩니다. 실행의 현재 연결을 확인한 뒤 다시 선택하세요.' : `파일 화면을 준비하지 못했습니다: ${error.message}`;
        badge.textContent = '연결 확인 필요';
        return false;
      } finally { if (view) { view.element.inert = !!runFile && !originOpened; view.element.setAttribute('aria-busy', 'false'); } }
    })();
    const closeGate = FileCardState.createFileCloseGate({
      dispose: async () => { await ready; return view ? view.close() : true; },
      onState: status => {
        if (runFile && status.status === 'closing') openingCancelled = true;
        card.dataset.closeState = status.status;
        if (status.status !== 'closed') { notice.hidden = false; notice.textContent = status.message; }
      },
    });
    card._beforeClose = () => closeGate.requestClose();
    card._fileReady = ready;
    return card;
  }

  return { spawnFileCard, openVerifiedRunFile };
}
