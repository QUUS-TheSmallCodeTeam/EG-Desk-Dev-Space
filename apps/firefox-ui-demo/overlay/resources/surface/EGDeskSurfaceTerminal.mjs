// Moved verbatim from overlay/JS/eg-desk-surface.uc.js.
// Loaded once per window: ChromeUtils.importESModule(url, { global: 'current' }).
// Never statically import a .sys.mjs here; shared modules arrive through deps.
export function createTerminalZone(deps) {
  const {
    RunResult,
    TAG,
    allocCardSeq,
    boardCloseRequests,
    boardNotice,
    completeAgendaClose,
    el,
    focusCanvasCard,
    makeSourceRef,
    openBoardProjectFileAt,
    raiseCardZ,
    resolveCanvasCardPlacement,
    revealPlacedCanvasCard,
    setActiveEntity,
    spawnBrowserCard,
    spawnDeskWindowShell,
    state,
  } = deps;

  function routeTerminalFrameWheel(state, card, frame, event) {
    // Main may provide the same gesture-session policy used by the outer canvas.
    if (typeof state.routeTerminalFrameWheel === 'function') {
      return state.routeTerminalFrameWheel(card, frame, event) === true;
    }
    // Until that bridge is available, preserve the basic active/inactive rule.
    if (event.ctrlKey || event.metaKey || state.activeEntityId === card.id
        || typeof state.panCanvasByWheel !== 'function') return false;
    state.panCanvasByWheel(event);
    return true;
  }

  // Firefox chrome postMessage hides MessageEvent.source. Authenticate the
  // current owned document through its API key, never through origin alone.
  // A fresh document publishes a fresh key, so queued pre-reload events fail.
  function terminalHostMessageMatches(event, frame, expectedUrl) {
    const key = event.data?.hostEventKey;
    if (event.origin !== 'chrome://userchrome' || typeof key !== 'string' || !key) return false;
    try {
      return frame.isConnected && !!frame.contentWindow
        && (event.source === null || event.source === frame.contentWindow)
        && frame.contentDocument?.documentURI === expectedUrl
        && frame.contentWindow.terminalAPI?.hostEventKey === key;
    } catch { return false; }
  }

  // Lost connectivity is not evidence of exit. A known PTY always asks first.
  function terminalCloseNeedsConfirm(api) {
    try {
      if (!api) return false;
      return (typeof api.ptyId === 'string' && api.ptyId !== '') || api.isConnected?.() === true;
    } catch { return false; }
  }

  // ============ Terminal Canvas Card ============
  const EGDESK_HELPER_PORT = 39218;
  const TERMINAL_HTML_URL = 'chrome://userchrome/content/terminal.html';
  const bridgeOrigin = 'http://127.0.0.1:' + EGDESK_HELPER_PORT;
  const heldSessions = new Map(); // Window memory only. Not a Desk restore record.
  let scope = null, scopeClosed = false;
  const reentryMessages = {
    ORIGINAL_EXITED: '원래 터미널의 종료가 확인되었습니다.',
    ORIGINAL_UNAVAILABLE: '원래 터미널을 이 브리지에서 찾을 수 없습니다. 종료 확인은 아닙니다.',
    TERMINAL_IDENTITY_CHANGED: '소유 범위가 달라 다시 연결할 수 없습니다.',
    TERMINAL_BRIDGE_RESTARTED: '로컬 브리지가 다시 시작되어 원래 터미널에 연결할 수 없습니다.',
    TERMINAL_DETACH_EXPIRED: '유지 시간이 만료되었습니다. 종료가 확인된 것은 아닙니다.',
    TERMINAL_NOT_HELD: '이 터미널은 더 이상 다시 연결할 수 있는 상태가 아닙니다.',
    TERMINAL_REENTRY_UNCONFIRMED: '연결 여부를 확인하지 못했습니다. 같은 창에서 다시 시도하세요.',
  };
  function terminalTransport(view, url, init) {
    // A managed File check must revalidate the Board/project/root in this
    // terminal before sending PTY input. Allow only its exact local lookup.
    const projectLookup = !scopeClosed && url === bridgeOrigin + '/v1/files/projects/open' && init?.method === 'POST';
    if (!scope || (!projectLookup && (!url.startsWith(bridgeOrigin + '/terminal/') || !/^\/terminal\/[a-z-]+$/.test(url.slice(bridgeOrigin.length))))) throw new Error('Invalid terminal transport');
    return window.fetch(url, { ...init, ...(projectLookup ? { redirect: 'error' } : {}), headers: { ...init?.headers,
      'X-EGDesk-Terminal-Owner': scope, 'X-EGDesk-Terminal-View': view } });
  }
  function closeScope() {
    if (scopeClosed || !scope) return;
    scopeClosed = true;
    try { globalThis.Services?.obs.removeObserver(closeScope, 'quit-application-granted'); } catch {}
    heldSessions.clear();
    void terminalTransport(scope, bridgeOrigin + '/terminal/close-local-scope', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true,
    }).catch(() => {}); // Detached TTL is the fallback if the bridge is unreachable.
  }
  function ensureScope() {
    if (scopeClosed) return null;
    if (!scope && window.crypto?.randomUUID) {
      scope = window.crypto.randomUUID();
      window.addEventListener('unload', closeScope, { once: true });
      try { globalThis.Services?.obs.addObserver(closeScope, 'quit-application-granted'); } catch {}
    }
    return scope;
  }

  function spawnTerminalCard(options = {}) {
    const idle = options?.idle === true;
    const activate = options?.activate !== false;
    const reveal = options?.reveal !== false;
    const requestedShellId = typeof options?.shellId === 'string'
      && /^[a-z][a-z0-9-]{0,31}$/.test(options.shellId) ? options.shellId : null;
    const id = `egd-terminal-card-${allocCardSeq()}`;
    const sourceRef = makeSourceRef('terminal-session', {
      id,
      scope: 'local-pty',
    });
    const placement = resolveCanvasCardPlacement('terminal');
    // The shared Desk Window bar: dots, grip, kind icon, name, Board control.
    const shell = spawnDeskWindowShell({
      id,
      kind: 'terminal',
      className: 'egd-terminal-card',
      headerClassName: 'egd-terminal-header',
      bodyClassName: 'egd-terminal-body',
      activate,
      sourceRef,
      minWidth: 400,
      minHeight: 300,
      createDirtyReason: 'create-terminal-card',
      moveDirtyReason: 'move-terminal-card',
      resizeDirtyReason: 'resize-terminal-card',
      style: {
        top: placement.y + 'px',
        left: placement.x + 'px',
        width: placement.width + 'px',
        height: placement.height + 'px',
        zIndex: String(raiseCardZ()),
      },
    });
    const card = shell.root;
    const body = shell.slots.content;
    if (reveal) revealPlacedCanvasCard(card, placement, { kind: 'terminal', ...(options?.keepVisible ? { keepVisible: options.keepVisible } : {}) });

    // ---- Header: name and session state ----
    const title = el('strong', { class: 'egd-terminal-title', title: '터미널' }, '터미널');
    const sessionText = el('span', { class: 'egd-terminal-session', role: 'status', data: { testid: 'terminal-session' } }, '연결 중');
    shell.slots.identity.appendChild(title);
    shell.slots.identity.appendChild(sessionText);
    // The red dot opens the same choices as the close shortcut.
    const closeDot = shell.slots.topbar.querySelector?.('.egd-card-dot-close');
    if (closeDot) { closeDot.title = '터미널 닫기'; closeDot.setAttribute?.('aria-label', '터미널 닫기'); }
    // CODE-06: the latest test/build result of a command typed here, as a chip.
    const runChip = el('button', { type: 'button', class: 'egd-terminal-run-chip', hidden: true, 'aria-expanded': 'false',
      title: '최근 명령 결과 보기/숨기기', data: { testid: 'terminal-run-chip' },
      onclick: (ev) => { ev.stopPropagation(); runResultPanel.hidden = !runResultPanel.hidden; runChip.setAttribute('aria-expanded', String(!runResultPanel.hidden)); } });
    shell.slots.actions.appendChild(runChip);

    // ---- Addresses a program in this terminal asked to open (flag EGDESK_TERMINAL_OPEN_URL of the bridge; c34) ----
    // The bridge hands over only http(s) addresses of this session. Each opens in an EG-Desk Browser Card placed by the usual placement rule, in the BACKGROUND: the camera and the
    // active card stay where they are (the person is typing in this terminal). The card shows the page; nothing here reads the page or the code it may show.
    const openedUrls = new Map();
    const openRequestedUrls = (urls) => {
      if (!Array.isArray(urls) || typeof spawnBrowserCard !== 'function') return;
      for (const raw of urls.slice(0, 4)) {
        let url;
        try { url = new URL(String(raw)); } catch { continue; }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
        const at = Date.now(), last = openedUrls.get(url.href);
        if (last !== undefined && at - last < 5000) continue;
        openedUrls.set(url.href, at);
        try { spawnBrowserCard(url.href, { openMode: 'new', opener: card, background: true }); } catch (error) { console.warn(TAG, 'terminal address could not be opened in a Browser Card:', error?.message || error); }
      }
    };

    // ---- Result of a typed test/build command (CODE-06) ----
    // The bridge reads this session's own output; nothing is run for the card
    // (D-X6). The shared result card renders above the terminal; a failure's
    // file:line opens the selected Board's project File at that line.
    const runResultPanel = el('section', { class: 'egd-terminal-run-result', hidden: true, 'aria-label': '명령 결과', data: { testid: 'terminal-run-result' } });
    let runResultSeq = 0;
    const showRunResult = (runResult) => {
      if (!runResult || typeof runResult !== 'object' || typeof runResult.output !== 'string') return;
      let summary;
      try {
        summary = RunResult.summarizeRunResult({
          command: typeof runResult.command === 'string' ? runResult.command : null,
          output: runResult.output, status: 'completed',
          durationMs: Number.isFinite(runResult.durationMs) ? runResult.durationMs : null,
        });
      } catch (error) { console.warn(TAG, 'terminal run result could not be summarized:', error); return; }
      const seq = ++runResultSeq;
      const resultCard = RunResult.renderRunResultCard({ document, result: summary, onOpenLocation: (location) => {
        if (seq !== runResultSeq || !card.isConnected) return;
        if (location?.inProject === false) { boardNotice(`프로젝트 밖 경로입니다 · ${location.label || location.path || ''}`); return; }
        void Promise.resolve(openBoardProjectFileAt(location)).catch(error => boardNotice(`파일을 열지 못했습니다 · ${error?.message || ''}`));
      } });
      // The panel sits above the terminal, so it asks for the shared card's
      // compact output height on the card itself.
      resultCard.className = `${resultCard.className} egdesk-run-result-compact`;
      const bar = el('div', { class: 'egd-terminal-run-result-bar' },
        el('span', { class: 'egd-terminal-run-result-title' }, '명령 결과'),
        el('span', { class: 'egd-terminal-run-result-note' }, '직접 입력한 명령의 출력에서 읽었습니다'),
        el('button', { type: 'button', class: 'egd-terminal-run-result-close', 'aria-label': '명령 결과 닫기', data: { testid: 'terminal-run-result-close' },
          onclick: (ev) => { ev.stopPropagation(); runResultPanel.hidden = true; runChip.setAttribute('aria-expanded', 'false'); } }, '닫기'));
      runResultPanel.replaceChildren(bar, resultCard);
      runResultPanel.dataset.outcome = summary.outcome;
      runResultPanel.hidden = false;
      runChip.textContent = summary.headline;
      runChip.dataset.outcome = summary.outcome;
      runChip.title = [summary.label, summary.command, summary.headline].filter(Boolean).join(' · ');
      runChip.hidden = false;
      runChip.setAttribute('aria-expanded', 'true');
    };

    // ---- Close confirmation (B31) ----
    // Shown under the bar only while a session is running. 취소, Esc, or a
    // press elsewhere keeps the window and the session exactly as they are.
    const closeCancel = el('button', { type: 'button', class: 'egd-terminal-close-confirm-cancel', title: '닫지 않고 터미널로 돌아가기',
      data: { testid: 'terminal-close-cancel' },
      onclick: (ev) => { ev.stopPropagation(); dismissCloseConfirm({ restoreFocus: true }); } }, '취소');
    const closeGo = el('button', { type: 'button', class: 'egd-terminal-close-confirm-go', title: '터미널 세션을 종료하고 창 닫기',
      data: { testid: 'terminal-close-go' },
      onclick: (ev) => { ev.stopPropagation(); void terminateAndClose(); } }, '종료하고 닫기');
    const closeDetach = el('button', { type: 'button', hidden: true, class: 'egd-terminal-close-confirm-cancel',
      title: '이 Desk 창에서 최대 10분 동안 실행 유지', data: { testid: 'terminal-close-detach' },
      onclick: (ev) => { ev.stopPropagation(); void detachAndClose(); } }, '창만 닫고 실행 유지');
    const closeMessage = el('span', { class: 'egd-terminal-close-confirm-text' }, '터미널 세션도 함께 종료됩니다. 닫을까요?');
    const closeConfirm = el('div', { class: 'egd-terminal-close-confirm', role: 'alertdialog', 'aria-label': '터미널 닫기 확인', hidden: true,
      data: { testid: 'terminal-close-confirm' } },
      closeMessage, closeCancel, closeGo, closeDetach);

    card.insertBefore(runResultPanel, body);
    card.insertBefore(closeConfirm, body);

    // ---- Use iframe for terminal.html to isolate keyboard events ----
    const heldStatus = el('p', { role: 'status', data: { testid: 'terminal-held-status' } });
    const heldRows = el('div', { data: { testid: 'terminal-held-rows' } });
    const heldPanel = idle ? el('section', { class: 'egd-terminal-close-confirm egd-terminal-held', 'aria-label': '유지 중인 Terminal',
      style: { maxHeight: '35%', overflow: 'auto' } },
      el('strong', {}, '유지 중인 Terminal'), heldStatus, heldRows) : null;
    if (heldPanel) card.insertBefore(heldPanel, body);
    const renderHeld = () => {
      if (!heldPanel) return;
      let index = 0;
      heldRows.replaceChildren(...[...heldSessions.values()].map(ref => {
        const label = (ref.shellLabel || '터미널') + ' ' + (++index);
        return el('button', { type: 'button', class: 'egd-terminal-close-confirm-cancel',
          data: { testid: 'terminal-held-reconnect' }, onclick: (ev) => {
            ev.stopPropagation(); void reconnectHeld(ref);
          } }, label + ' · 다시 연결');
      }));
      heldStatus.textContent = heldSessions.size ? '원래 실행에 연결합니다. 이전 화면 전체는 복원되지 않습니다.' : '이 Desk 창에 유지 요청이 없습니다.';
    };
    let attaching = false;
    async function reconnectHeld(ref) {
      if (attaching || heldSessions.get(ref.sessionId) !== ref) return;
      const api = frameApi();
      if (!api?.attachLocal || api.ptyId) return;
      attaching = true;
      heldStatus.textContent = '같은 터미널에 다시 연결 중…';
      try {
        const result = await api.attachLocal(ref);
        if (result.ok) { heldSessions.delete(ref.sessionId); heldPanel.hidden = true; return; }
        if (['ORIGINAL_EXITED', 'ORIGINAL_UNAVAILABLE', 'TERMINAL_IDENTITY_CHANGED', 'TERMINAL_BRIDGE_RESTARTED',
          'TERMINAL_DETACH_EXPIRED', 'TERMINAL_NOT_HELD'].includes(result.code)) heldSessions.delete(ref.sessionId);
        renderHeld();
        heldStatus.textContent = reentryMessages[result.code] || '원래 터미널에 다시 연결하지 못했습니다.';
      } catch { heldStatus.textContent = reentryMessages.TERMINAL_REENTRY_UNCONFIRMED; }
      finally { attaching = false; }
    }
    renderHeld();
    // Desk iframes cannot start an unowned PTY. Wait for the current frame's
    // authenticated API before allocating this window's transport scope.
    const query = ['managed=1'];
    if (requestedShellId) query.push('shellId=' + encodeURIComponent(requestedShellId));
    if (!activate) query.push('autofocus=0');
    const terminalUrl = TERMINAL_HTML_URL + (query.length ? '?' + query.join('&') : '');
    const termBrowser = el('iframe', {
      src: terminalUrl,
      style: { width: '100%', height: '100%', border: '0', display: 'block' },
    });
    let terminalDisposed = false;
    let disposeCloseShortcut = null;
    const onTerminalFrameLoad = () => {
      disposeCloseShortcut?.();
      disposeCloseShortcut = null;
      try {
        const frameWindow = termBrowser.contentWindow;
        if (frameWindow && typeof state.registerDeskCloseShortcutTarget === 'function') {
          const dispose = state.registerDeskCloseShortcutTarget(frameWindow);
          if (typeof dispose === 'function') disposeCloseShortcut = dispose;
        }
      } catch (error) {
        console.warn(TAG, 'terminal close shortcut bridge unavailable:', error);
      }
    };
    termBrowser.addEventListener('load', onTerminalFrameLoad);
    body.appendChild(termBrowser);
    // ---- Card interactions ----
    // Presses on the card itself are focused by the shared window shell; the
    // frame reports its own presses through 'terminal-activate'.
    const activateCard = () => {
      if (state.panModifier) return;
      setActiveEntity(card);
    };
    // ---- Keyboard focus handoff ----
    // chrome 문서에서는 iframe 요소 자체가 chrome activeElement가 되어야
    // 키 이벤트가 서브문서(xterm)로 라우팅된다. xterm의 in-frame focus만으로는
    // 프레임 경계를 못 넘으므로 부모 쪽에서 명시적으로 핸드오프한다.
    const focusTerminal = () => {
      if (card.hidden || card.style.display === 'none'
        || (card.dataset.egdSemanticLevel && card.dataset.egdSemanticLevel !== 'detail')) return;
      try {
        termBrowser.focus();
        termBrowser.contentWindow?.terminalAPI?.focus?.();
      } catch {}
    };
    card.addEventListener('mousedown', (ev) => {
      if (state.panModifier) return;
      // The close question and the bar's own controls keep their focus.
      if (ev?.target?.closest?.('.egd-terminal-close-confirm, button, .egd-card-dot')) return;
      // xterm의 mousedown preventDefault 이후에 포커스가 잡히도록 defer
      setTimeout(focusTerminal, 0);
    }, true);
    // 최초 연결 완료 시 자동 포커스 (terminal.html이 terminal-ready postMessage 발송)
    let everConnected = false;
    const onTerminalReady = (ev) => {
      if (terminalDisposed || !terminalHostMessageMatches(ev, termBrowser, terminalUrl)) return;
      if (ev.data?.type === 'terminal-activate') {
        // A press inside the terminal is a press outside the close question.
        dismissCloseConfirm();
        if (state.activeEntityId !== card.id) activateCard();
        return;
      }
      if (ev.data?.type === 'terminal-run-result') { showRunResult(ev.data.runResult); return; }
      if (ev.data?.type === 'terminal-open-url') { openRequestedUrls(ev.data.urls); return; }
      if (ev.data?.type === 'terminal-new-session') {
        const shellId = ev.data.shellId;
        if (typeof shellId === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(shellId)) spawnTerminalCard({ shellId });
        return;
      }
      if (ev.data?.type === 'terminal-api-ready') {
        everConnected = false;
        sessionText.textContent = idle ? '세션 없음' : '연결 중';
        const api = frameApi();
        if (typeof api?.configureLocal === 'function' && ensureScope()) {
          const view = window.crypto.randomUUID();
          api.configureLocal((url, init) => terminalTransport(view, url, init), idle);
        } else {
          sessionText.textContent = '연결 실패';
        }
      }
      if (ev.data?.type === 'terminal-api-ready' || ev.data?.type === 'terminal-ready') {
        try {
          termBrowser.contentWindow?.terminalAPI?.setWheelHandler?.(
            event => routeTerminalFrameWheel(state, card, termBrowser, event));
        } catch (error) {
          console.warn(TAG, 'terminal wheel bridge unavailable:', error);
        }
      }
      if (ev.data?.type === 'terminal-ready') {
        everConnected = true;
        const label = ev.data.shellLabel;
        if (heldPanel) heldPanel.hidden = true;
        sessionText.textContent = ev.data.resumed ? '재연결 · 실행 중' : typeof label === 'string' && label && label.length <= 80 ? label : '실행 중';
        if (activate && state.activeEntityId === card.id) focusTerminal();
      }
      if (ev.data?.type === 'terminal-exit-confirmed') { sessionText.textContent = '종료됨'; dismissCloseConfirm(); }
      if (ev.data?.type === 'terminal-no-session') sessionText.textContent = '세션 없음';
      // A session that never came up failed to connect; one that was running lost its connection.
      if (ev.data?.type === 'terminal-disconnected') sessionText.textContent = everConnected ? '연결 끊김' : '연결 실패';
      if (ev.data?.type === 'terminal-connecting') sessionText.textContent = '연결 중';
      if (['terminal-ready', 'terminal-exit-confirmed', 'terminal-no-session'].includes(ev.data?.type)
          && boardCloseRequests.has(card.dataset.projectionId)) {
        void completeAgendaClose({ projectionId: card.dataset.projectionId });
      }
    };
    window.addEventListener('message', onTerminalReady);

    // ---- Close: ask first while a session is running ----
    const closeWindow = shell.requestClose;
    const frameApi = () => { try { return termBrowser.contentWindow?.terminalAPI || null; } catch { return null; } };
    const onPressOutsideConfirm = (ev) => {
      if (closeConfirm.contains?.(ev.target) || ev.target?.closest?.('.egd-card-dot-close')) return;
      dismissCloseConfirm();
    };
    function dismissCloseConfirm({ restoreFocus = false } = {}) {
      if (closeConfirm.hidden) return;
      closeConfirm.hidden = true;
      document.removeEventListener('mousedown', onPressOutsideConfirm, true);
      if (restoreFocus) focusTerminal();
    }
    let detaching = false, detached = false, terminating = false, terminated = false;
    async function terminateAndClose() {
      if (terminating || detaching) return;
      const api = frameApi();
      if (!api?.closeForBoard) { closeTerminalNow(); return; }
      terminating = true;
      closeGo.disabled = closeDetach.disabled = true;
      closeMessage.textContent = '실행 종료 확인 중…';
      try {
        terminated = await api.closeForBoard() === true;
        if (terminated) closeTerminalNow();
        else closeMessage.textContent = '종료 요청과 실제 종료는 다릅니다. 종료를 확인하지 못했습니다.';
      } catch { closeMessage.textContent = '실행 종료를 확인하지 못했습니다.'; }
      finally { terminating = false; closeGo.disabled = closeDetach.disabled = false; if (!terminated) closeDetach.hidden = true; }
    }
    async function detachAndClose() {
      if (terminating || detaching || terminalDisposed || !frameApi()?.canDetach?.()) return;
      detaching = true;
      closeGo.disabled = closeCancel.disabled = closeDetach.disabled = true;
      closeMessage.textContent = '실행 유지 확인 중…';
      try {
        const result = await frameApi().detachLocal();
        if (!result.ok) {
          closeMessage.textContent = result.code === 'TERMINAL_DETACH_LIMIT' ? '유지 가능한 터미널 수를 초과했습니다.'
            : '실행 유지를 확인하지 못했습니다. 닫지 않았습니다.';
          return;
        }
        if (!scopeClosed) {
          heldSessions.set(result.sessionId, result);
          while (heldSessions.size > 16) heldSessions.delete(heldSessions.keys().next().value);
        }
        detached = true;
        if (!terminalDisposed) {
          boardNotice('실행 유지 중 · Dock의 터미널에서 다시 연결 (최대 10분)');
          closeTerminalNow();
        }
      } catch { closeMessage.textContent = '실행 유지를 확인하지 못했습니다. 닫지 않았습니다.'; }
      finally { detaching = false; closeGo.disabled = closeCancel.disabled = closeDetach.disabled = false; }
    }
    function closeTerminalNow() {
      if (detaching && !detached) return false;
      dismissCloseConfirm();
      return closeWindow();
    }
    function requestTerminalClose() {
      if (detaching || attaching || terminating) return false;
      if (!terminalCloseNeedsConfirm(frameApi())) return closeTerminalNow();
      if (closeConfirm.hidden) {
        closeDetach.hidden = !frameApi()?.canDetach?.();
        closeMessage.textContent = closeDetach.hidden ? '터미널 세션도 함께 종료됩니다. 닫을까요?' : '창을 닫을 때 이 실행을 어떻게 할까요?';
        closeConfirm.hidden = false;
        document.addEventListener('mousedown', onPressOutsideConfirm, true);
      }
      focusCanvasCard(card);
      closeCancel.focus?.();
      return false;
    }
    closeConfirm.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      dismissCloseConfirm({ restoreFocus: true });
    });
    // The close shortcut reads shell.requestClose; the red dot is caught here
    // on its way down, so both ask the same question.
    shell.requestClose = requestTerminalClose;
    shell.slots.topbar.addEventListener('click', (ev) => {
      if (!ev.target?.closest?.('.egd-card-dot-close')) return;
      ev.stopPropagation();
      requestTerminalClose();
    }, true);

    // ---- Cleanup ----
    const cleanupCard = () => {
      terminalDisposed = true;
      document.removeEventListener('mousedown', onPressOutsideConfirm, true);
      window.removeEventListener('message', onTerminalReady);
      termBrowser.removeEventListener('load', onTerminalFrameLoad);
      disposeCloseShortcut?.();
      disposeCloseShortcut = null;
      // Kill PTY session via the browser's terminalAPI
      try {
        const contentWin = termBrowser.contentWindow || termBrowser.contentDocument?.defaultView;
        if (!detached && !terminated && contentWin && contentWin.terminalAPI) {
          void contentWin.terminalAPI.kill().catch(error => {
            console.warn(TAG, 'terminal cleanup was not confirmed:', error);
          });
        }
      } catch (e) {
        console.warn(TAG, 'terminal cleanup error:', e);
      }
    };

    console.warn(TAG, 'terminal card spawned (chrome:// + node bridge :39218)', id);
    shell.registerCleanup(cleanupCard);
    card._termBrowser = termBrowser;
    card._closeOwnedRuntime = async () => {
      const api = termBrowser.contentWindow?.terminalAPI;
      return api?.closeForBoard ? api.closeForBoard() : false;
    };
    return card;
  }

  return { spawnTerminalCard };
}
