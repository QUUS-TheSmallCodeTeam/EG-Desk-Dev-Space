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

  // B31: closing the window ends the session with it, so only a session that
  // is still running asks first. A frame that never connected has nothing to lose.
  function terminalCloseNeedsConfirm(api) {
    try {
      if (!api) return false;
      return (typeof api.ptyId === 'string' && api.ptyId !== '') || api.isConnected?.() === true;
    } catch { return false; }
  }

  // ============ Terminal Canvas Card ============
  const EGDESK_HELPER_PORT = 39218;
  const TERMINAL_HTML_URL = 'chrome://userchrome/content/terminal.html';

  function spawnTerminalCard(options = {}) {
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
    if (reveal) revealPlacedCanvasCard(card, placement);

    // ---- Header: name and session state ----
    const title = el('strong', { class: 'egd-terminal-title', title: '터미널' }, '터미널');
    const sessionText = el('span', { class: 'egd-terminal-session', role: 'status', data: { testid: 'terminal-session' } }, '연결 중');
    shell.slots.identity.appendChild(title);
    shell.slots.identity.appendChild(sessionText);
    // CODE-06: the latest test/build result of a command typed here, as a chip.
    const runChip = el('button', { type: 'button', class: 'egd-terminal-run-chip', hidden: true, 'aria-expanded': 'false',
      title: '최근 명령 결과 보기/숨기기', data: { testid: 'terminal-run-chip' },
      onclick: (ev) => { ev.stopPropagation(); runResultPanel.hidden = !runResultPanel.hidden; runChip.setAttribute('aria-expanded', String(!runResultPanel.hidden)); } });
    shell.slots.actions.appendChild(runChip);

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
      onclick: (ev) => { ev.stopPropagation(); closeTerminalNow(); } }, '종료하고 닫기');
    const closeConfirm = el('div', { class: 'egd-terminal-close-confirm', role: 'alertdialog', 'aria-label': '터미널 닫기 확인', hidden: true,
      data: { testid: 'terminal-close-confirm' } },
      el('span', { class: 'egd-terminal-close-confirm-text' }, '터미널 세션도 함께 종료됩니다. 닫을까요?'),
      closeCancel, closeGo);

    card.insertBefore(runResultPanel, body);
    card.insertBefore(closeConfirm, body);

    // ---- Use iframe for terminal.html to isolate keyboard events ----
    const query = [];
    if (requestedShellId) query.push('shellId=' + encodeURIComponent(requestedShellId));
    if (!activate) query.push('autofocus=0');
    const termBrowser = el('iframe', {
      src: TERMINAL_HTML_URL + (query.length ? '?' + query.join('&') : ''),
      style: { width: '100%', height: '100%', border: '0', display: 'block' },
    });
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
    const onTerminalReady = (ev) => {
      if (ev.source !== termBrowser.contentWindow) return;
      if (ev.data?.type === 'terminal-activate') {
        // A press inside the terminal is a press outside the close question.
        dismissCloseConfirm();
        if (state.activeEntityId !== card.id) activateCard();
        return;
      }
      if (ev.data?.type === 'terminal-run-result') { showRunResult(ev.data.runResult); return; }
      if (ev.data?.type === 'terminal-new-session') {
        const shellId = ev.data.shellId;
        if (typeof shellId === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(shellId)) spawnTerminalCard({ shellId });
        return;
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
        const label = ev.data.shellLabel;
        sessionText.textContent = typeof label === 'string' && label && label.length <= 80 ? label : '실행 중';
        if (activate && state.activeEntityId === card.id) focusTerminal();
      }
      if (ev.data?.type === 'terminal-exit-confirmed') { sessionText.textContent = '종료됨'; dismissCloseConfirm(); }
      if (ev.data?.type === 'terminal-no-session') sessionText.textContent = '세션 없음';
      if (ev.data?.type === 'terminal-disconnected') sessionText.textContent = '연결 끊김';
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
    function closeTerminalNow() {
      dismissCloseConfirm();
      return closeWindow();
    }
    function requestTerminalClose() {
      if (!terminalCloseNeedsConfirm(frameApi())) return closeTerminalNow();
      if (closeConfirm.hidden) {
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
      document.removeEventListener('mousedown', onPressOutsideConfirm, true);
      window.removeEventListener('message', onTerminalReady);
      termBrowser.removeEventListener('load', onTerminalFrameLoad);
      disposeCloseShortcut?.();
      disposeCloseShortcut = null;
      // Kill PTY session via the browser's terminalAPI
      try {
        const contentWin = termBrowser.contentWindow || termBrowser.contentDocument?.defaultView;
        if (contentWin && contentWin.terminalAPI) {
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
