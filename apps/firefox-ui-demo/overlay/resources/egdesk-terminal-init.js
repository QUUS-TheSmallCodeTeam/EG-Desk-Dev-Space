'use strict';
(async () => {
  const { createTerminalCloseController, createTerminalWriteQueue, createTerminalCompositionGate, terminalExitEvidence, terminalResponsePacket } = await import('chrome://userchrome/content/EGDeskTerminalState.sys.mjs');
  const HELPER_PORT = 39218;
  const HELPER_ORIGIN = `http://127.0.0.1:${HELPER_PORT}`;
  const statusEl = document.getElementById('status-overlay');
  const containerEl = document.getElementById('terminal-container');
  const shellSelect = document.getElementById('terminal-shell-select');
  const shellButton = document.getElementById('terminal-shell-start');
  const shellLabel = document.getElementById('terminal-shell-label');
  const operationStatus = document.getElementById('terminal-operation-status');

  // ---- xterm.js setup ----
  const term = new Terminal({
    cursorBlink: true,
    disableStdin: true,
    cursorStyle: 'bar',
    fontSize: 13,
    fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1a1a2e',
      foreground: '#e0e0e0',
      cursor: '#f8f8f2',
      selectionBackground: 'rgba(248,248,242,0.2)',
      black: '#21222c',
      red: '#ff5555',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      blue: '#bd93f9',
      magenta: '#ff79c6',
      cyan: '#8be9fd',
      white: '#f8f8f2',
      brightBlack: '#6272a4',
      brightRed: '#ff6e6e',
      brightGreen: '#69ff94',
      brightYellow: '#ffffa5',
      brightBlue: '#d6acff',
      brightMagenta: '#ff92df',
      brightCyan: '#a4ffff',
      brightWhite: '#ffffff',
    },
    allowProposedApi: true,
    scrollback: 5000,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  if (typeof WebLinksAddon !== 'undefined') {
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
  }

  term.open(containerEl);

  // Initial fit
  requestAnimationFrame(() => {
    fitAddon.fit();
    return connectBridge();
  });

  // ---- HTTP PTY bridge ----
  let ptyId = null;
  let readTimer = null;
  let connected = false;
  let exitConfirmed = false;
  let confirmedExitSessionId = null;
  let closeRequested = false;
  let unloaded = false, connectionGeneration = 0, connectPending = null, readPending = false;
  let shellCatalog = null, sessionInfo = null;
  let spawnPhase = 'idle', noSessionClosed = false;
  const definiteSpawnRejection = error => [
    'WINDOWS_PTY_UNAVAILABLE', 'WINDOWS_CONPTY_UNSUPPORTED', 'INVALID_TERMINAL_SHELL',
    'TERMINAL_SHELL_UNAVAILABLE', 'INVALID_TERMINAL_SIZE',
  ].includes(error.code) && Number.isInteger(error.httpStatus) && error.httpStatus >= 400;
  const requestedShellId = new URLSearchParams(window.location.search).get('shellId');
  const shellIdIsValid = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
  const reportAsyncError = error => console.warn('EG-Desk Terminal:', error.message || error);

  async function postTerminal(path, body, options = {}) {
    const controller = options.timeoutMs ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    try {
      const response = await fetch(`${HELPER_ORIGIN}${path}`, {
        method: options.method || 'POST', headers: { 'Content-Type': 'application/json' },
        ...(options.method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const result = await response.json().catch(() => ({}));
      // Preserve the native body status (EXITED/UNKNOWN/STOP_REQUESTED).
      // Transport status is a separate field, never an overwrite of body.status.
      const packet = terminalResponsePacket(result, response.status);
      if (options.passErrors) return packet;
      if (!response.ok || result.error || result.ok === false) {
        const error = new Error(typeof result.error === 'string' ? result.error
          : result.error?.message || result.code || 'HTTP ' + response.status);
        error.code = result.code || result.error?.code || 'TERMINAL_REQUEST_FAILED';
        error.httpStatus = response.status;
        throw error;
      }
      return packet;
    } finally { if (timeout) clearTimeout(timeout); }
  }

  function stopPolling() {
    if (readTimer) {
      clearInterval(readTimer);
      readTimer = null;
    }
  }

  function showDisconnected(message) {
    if (closeRequested) { renderCloseState({ phase: 'offline', error: message }); return; }
    statusEl.textContent = message || 'Disconnected. Click to reconnect.';
    statusEl.classList.remove('hidden');
    statusEl.style.pointerEvents = 'auto';
    statusEl.style.cursor = 'pointer';
    statusEl.onclick = () => {
      statusEl.style.pointerEvents = 'none';
      statusEl.style.cursor = 'default';
      statusEl.onclick = null;
      connectBridge();
    };
  }

  async function readTerminalOutput() {
    if (!ptyId || !connected || readPending || unloaded) return;
    const sessionAtRead = ptyId;
    readPending = true;
    try {
      const result = await postTerminal('/terminal/read', { sessionId: sessionAtRead });
      if (ptyId !== sessionAtRead) return;
      if (result.data) term.write(result.data);
      if (terminalExitEvidence(result, sessionAtRead)) {
        exitConfirmed = true;
        confirmedExitSessionId = sessionAtRead;
        spawnPhase = 'exited';
        term.write(`\r\n\x1b[90m[Process exited with code ${result.exitCode ?? ''}]\x1b[0m\r\n`);
        connected = false;
        term.options.disableStdin = true;
        ptyId = null;
        stopPolling();
        writeQueue.invalidate();
        composition.invalidate();
        notifyTerminalExit();
      }
    } catch (e) {
      if (ptyId !== sessionAtRead || closeRequested || unloaded) return;
      connected = false;
      term.options.disableStdin = true;
      stopPolling();
      writeQueue.invalidate();
      composition.invalidate();
      showDisconnected('연결이 끊겼습니다. 같은 세션 연결 다시 확인: ' + e.message);
    } finally { readPending = false; }
  }

  function notifyTerminalExit() {
    try { window.parent.postMessage({ type: 'terminal-exit-confirmed' }, '*'); } catch {}
  }

  function renderCloseState(closeState) {
    statusEl.classList.remove('hidden');
    statusEl.textContent = closeState.phase === 'confirmed'
      ? '터미널 세션 종료 확인됨'
      : closeState.phase === 'offline' ? '연결이 끊겨 종료 여부를 확인하지 못했습니다.'
      : closeState.phase === 'unknown' ? '세션이 조회되지 않지만 실행 종료는 확인되지 않았습니다.'
      : closeState.phase === 'timeout' ? '아직 실행 종료가 확인되지 않았습니다.' : '터미널 종료 확인 중…';
    statusEl.style.pointerEvents = 'none';
    statusEl.onclick = null;
    if (['offline', 'timeout', 'unknown'].includes(closeState.phase)) {
      const retry = document.createElement('button');
      retry.textContent = '종료 상태 다시 확인';
      retry.setAttribute('aria-label', '터미널 종료 상태 다시 확인');
      retry.dataset.testid = 'terminal-close-retry';
      retry.style.cssText = 'display:block;margin:10px auto;padding:6px 10px;pointer-events:auto;';
      retry.onclick = () => { void closeForBoard(); };
      statusEl.appendChild(retry);
    }
  }

  const terminalCloser = createTerminalCloseController({
    requestKill: sessionId => postTerminal('/terminal/kill', { sessionId }, { timeoutMs: 1500, passErrors: true }),
    readStatus: sessionId => postTerminal('/terminal/read', { sessionId }, { timeoutMs: 1500, passErrors: true }),
    wait: ms => new Promise(resolve => window.setTimeout(resolve, ms)),
    onOutput: data => term.write(data),
    onState: closeState => {
      if (ptyId && closeState.sessionId !== ptyId) return;
      renderCloseState(closeState);
      if (closeState.phase === 'confirmed') {
        exitConfirmed = true;
        confirmedExitSessionId = closeState.sessionId;
        spawnPhase = 'exited';
        connected = false;
        term.options.disableStdin = true;
        ptyId = null;
        stopPolling();
        writeQueue.invalidate();
        composition.invalidate();
        notifyTerminalExit();
      }
    },
  });

  async function closeForBoard() {
    if (exitConfirmed) return true;
    closeRequested = true;
    term.options.disableStdin = true;
    shellButton.disabled = true;
    connectionGeneration++;
    writeQueue.invalidate();
    composition.invalidate();
    if (!ptyId) {
      if (spawnPhase === 'idle' || spawnPhase === 'rejected') {
        noSessionClosed = true;
        statusEl.textContent = '실행된 터미널 세션이 없어 카드를 닫을 수 있습니다.';
        return true; // Card closure permission, not a native EXITED receipt.
      }
      return false;
    }
    const sessionAtClose = ptyId;
    // Replace normal output polling with a bounded observation loop; a kill ACK
    // alone never resolves the close. No spawn or command replay occurs on retry.
    stopPolling();
    const confirmed = await terminalCloser.close(sessionAtClose);
    return confirmed || confirmedExitSessionId === sessionAtClose;
  }

  const writeQueue = createTerminalWriteQueue({
    write: (sessionId, data) => postTerminal('/terminal/write', { sessionId, data }),
    onError: (error, sessionId) => {
      if (ptyId !== sessionId || unloaded) return;
      connected = false;
      term.options.disableStdin = true;
      stopPolling();
      composition.invalidate();
      showDisconnected('입력을 보내지 못했습니다. 명령을 자동으로 다시 보내지 않습니다. ' + error.message);
    },
  });
  const writeToTerminal = data => writeQueue.enqueue(data);
  const composition = createTerminalCompositionGate({
    send: writeToTerminal,
    sessionKey: () => writeQueue.snapshot().generation,
    onFallback: () => {
      const textarea = containerEl.querySelector('.xterm-helper-textarea');
      if (textarea) textarea.value = '';
    },
    onError: reportAsyncError,
  });

  function exposeTerminalApi() {
    window.terminalAPI = {
      closeForBoard,
      closeState: () => terminalCloser.snapshot(),
      get ptyId() {
        return ptyId;
      },
      isConnected: () => connected,
      bufferText: () => {
        const buffer = term.buffer.active;
        const lines = [];
        for (let index = 0; index < buffer.length; index += 1) {
          lines.push(buffer.getLine(index)?.translateToString(true) || '');
        }
        return lines.join('\n');
      },
      write: (data) => {
        composition.boundary();
        return writeToTerminal(data);
      },
      focus: () => {
        term.focus();
      },
      paste: (data) => {
        composition.boundary();
        term.paste(String(data ?? ''));
      },
      dataEventCount: () => dataEvents,
      kill: async () => {
        const sessionId = ptyId || confirmedExitSessionId;
        const confirmed = await closeForBoard();
        if (noSessionClosed) return { ok: true, sessionId: null, status: 'NO_SESSION', exited: false, exitConfirmed: false };
        return { ok: confirmed, sessionId, status: confirmed ? 'EXITED' : 'STOP_UNCONFIRMED', exitConfirmed: confirmed };
      },
      resize: resizeTerminal,
      sessionInfo: () => sessionInfo ? { ...sessionInfo } : null,
    };
  }

  function showOperationError(message) {
    operationStatus.textContent = message;
    operationStatus.classList.remove('hidden');
  }

  async function resizeTerminal(cols, rows) {
    if (!ptyId || !connected || closeRequested || unloaded) return { ok: false, code: 'TERMINAL_INPUT_INACTIVE' };
    const sessionId = ptyId;
    try {
      const result = await postTerminal('/terminal/resize', { sessionId, cols, rows });
      if (result.resized === false || result.resizeSupported === false) throw new Error('이 연결은 PTY 크기 변경을 지원하지 않습니다.');
      if (ptyId === sessionId && !unloaded) operationStatus.classList.add('hidden');
      return result;
    } catch (error) {
      if (ptyId === sessionId && !unloaded) showOperationError('크기 변경을 적용하지 못했습니다. ' + error.message);
      throw error;
    }
  }

  async function loadShellCatalog() {
    const result = await postTerminal('/terminal/shells', null, { method: 'GET', timeoutMs: 5000 });
    if (!Array.isArray(result.shells) || result.shells.length > 16
        || result.shells.some(shell => !shellIdIsValid(shell.id) || typeof shell.label !== 'string'
          || shell.label.length > 80 || typeof shell.available !== 'boolean')
        || new Set(result.shells.map(shell => shell.id)).size !== result.shells.length
        || !shellIdIsValid(result.defaultShellId)) throw new Error('셸 목록을 확인하지 못했습니다.');
    const priorSelection = shellSelect.value;
    shellCatalog = result;
    while (shellSelect.firstChild) shellSelect.removeChild(shellSelect.firstChild);
    for (const shell of result.shells) {
      const option = document.createElement('option');
      option.value = shell.id;
      option.textContent = shell.label + (shell.available ? '' : ' (사용 불가)');
      option.disabled = !shell.available;
      shellSelect.appendChild(option);
    }
    shellSelect.value = shellIdIsValid(priorSelection) ? priorSelection
      : shellIdIsValid(requestedShellId) ? requestedShellId : result.defaultShellId;
    shellSelect.disabled = false;
    shellButton.disabled = false;
    const selected = result.shells.find(shell => shell.id === shellSelect.value && shell.available);
    if (!selected) throw new Error('선택한 셸이 설치되어 있지 않습니다.');
    if (result.platform === 'win32' && result.transport !== 'conpty') {
      throw new Error('이 Windows 환경에서 ConPTY 터미널을 사용할 수 없습니다. ' + (result.reason || ''));
    }
    return result;
  }

  function showSpawnUnconfirmed() {
    statusEl.textContent = '터미널 시작 요청이 접수됐는지 확인하지 못했습니다. 중복 실행을 막기 위해 다시 시작하지 않습니다.';
    statusEl.classList.remove('hidden');
    statusEl.style.pointerEvents = 'none';
    statusEl.onclick = null;
    shellButton.disabled = true;
  }

  async function connectBridge() {
    if (unloaded || closeRequested) return false;
    if (spawnPhase === 'unknown' && !ptyId) {
      showSpawnUnconfirmed();
      return false;
    }
    if (connectPending) return connectPending;
    const generation = ++connectionGeneration;
    const current = () => !unloaded && !closeRequested && generation === connectionGeneration;
    statusEl.textContent = ptyId ? '같은 터미널 세션 연결 확인 중…' : '터미널 연결 중…';
    statusEl.classList.remove('hidden');
    statusEl.style.pointerEvents = 'none';
    statusEl.onclick = null;
    stopPolling();
    connectPending = (async () => {
      try {
        // Reconnecting a known PTY only reads that PTY; no replacement shell,
        // command replay, or automatic kill is allowed after a network error.
        if (ptyId) {
          const sessionId = ptyId;
          const result = await postTerminal('/terminal/read', { sessionId }, { timeoutMs: 5000 });
          if (!current() || ptyId !== sessionId) return false;
          if (result.data) term.write(result.data);
          if (terminalExitEvidence(result, sessionId)) {
            exitConfirmed = true; confirmedExitSessionId = sessionId; ptyId = null;
            spawnPhase = 'exited';
            notifyTerminalExit();
            statusEl.textContent = '터미널 세션 종료 확인됨';
            return false;
          }
        } else {
          await loadShellCatalog();
          if (!current()) return false;
          const shellId = shellSelect.value;
          spawnPhase = 'pending';
          const result = await postTerminal('/terminal/spawn', {
            shellId, cols: term.cols, rows: term.rows,
          }, { timeoutMs: 10000 });
          if (!current()) {
            if (typeof result.sessionId === 'string' && result.sessionId) {
              if (unloaded) {
                void postTerminal('/terminal/kill', { sessionId: result.sessionId }).catch(reportAsyncError);
              } else if (closeRequested) {
                ptyId = result.sessionId;
                spawnPhase = 'active';
                void closeForBoard().catch(reportAsyncError);
              }
            }
            return false;
          }
          if (typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('터미널 세션 ID를 확인하지 못했습니다.');
          ptyId = result.sessionId;
          spawnPhase = 'active';
          if (shellCatalog.platform === 'win32'
              && (result.transport !== 'conpty' || result.usePty !== true || result.degraded === true)) {
            showOperationError('Windows ConPTY 연결이 아닙니다. 소유한 세션의 종료를 확인하고 있습니다.');
            await closeForBoard();
            return false;
          }
          const windowsBuildNumber = result.windowsBuildNumber ?? shellCatalog.windowsBuildNumber;
          if (shellCatalog.platform === 'win32' && Number.isSafeInteger(windowsBuildNumber) && windowsBuildNumber > 0) {
            term.options.windowsPty = { backend: 'conpty', buildNumber: windowsBuildNumber };
          }
          sessionInfo = { shellId: result.shellId || shellId,
            shellLabel: result.shellLabel || shellCatalog.shells.find(shell => shell.id === shellId).label,
            transport: result.transport || (result.usePty ? 'pty' : 'pipe'),
            usePty: result.usePty === true, degraded: result.degraded === true,
            windowsBuildNumber: Number.isSafeInteger(windowsBuildNumber) ? windowsBuildNumber : null };
          shellLabel.textContent = sessionInfo.shellLabel + ' · ' + sessionInfo.transport;
          if (!sessionInfo.usePty) showOperationError('파이프 연결: 대화형 PTY와 크기 변경을 지원하지 않습니다.');
        }
        if (!current() || !ptyId) return false;
        connected = true;
        term.options.disableStdin = false;
        exitConfirmed = false;
        confirmedExitSessionId = null;
        composition.invalidate();
        writeQueue.bind(ptyId);
        statusEl.classList.add('hidden');
        shellButton.textContent = '새 터미널 열기';
        window.parent.postMessage({ type: 'terminal-ready', ptyId,
          shellId: sessionInfo?.shellId, shellLabel: sessionInfo?.shellLabel }, '*');
        readTimer = setInterval(readTerminalOutput, 80);
        void readTerminalOutput();
        term.focus();
        return true;
      } catch (error) {
        if (spawnPhase === 'pending') spawnPhase = definiteSpawnRejection(error) ? 'rejected' : 'unknown';
        if (!current()) {
          if (closeRequested && !unloaded && spawnPhase === 'rejected') {
            window.parent.postMessage({ type: 'terminal-no-session' }, '*');
          }
          return false;
        }
        connected = false;
        term.options.disableStdin = true;
        writeQueue.invalidate();
        composition.invalidate();
        shellButton.disabled = false;
        if (spawnPhase === 'unknown') showSpawnUnconfirmed();
        else showDisconnected('터미널 연결을 확인해 주세요. ' + error.message);
        term.write('\r\n\x1b[31m' + error.message + '\x1b[0m\r\n');
        return false;
      }
    })();
    try { return await connectPending; }
    finally { connectPending = null; }
  }

  shellButton.addEventListener('click', () => {
    if (ptyId || sessionInfo) {
      if (!shellCatalog?.shells.some(shell => shell.id === shellSelect.value && shell.available)) return;
      window.parent.postMessage({ type: 'terminal-new-session', shellId: shellSelect.value }, '*');
    } else if (!unloaded && !closeRequested) {
      void connectBridge().catch(reportAsyncError);
    }
  });

  // ---- Terminal input -> PTY ----
  let dataEvents = 0; // 진단용: xterm이 사용자 입력을 인식한 횟수
  term.onData((data) => {
    dataEvents += 1;
    void composition.data(data).catch(reportAsyncError);
  });

  // 프레임 내부 어디를 클릭해도 xterm으로 포커스 복귀
  // (chrome host의 프레임 포커스 핸드오프는 부모(eg-desk-surface)가 담당)
  window.addEventListener('mousedown', event => {
    if (event.target?.closest?.('#terminal-toolbar, #status-overlay button')) return;
    setTimeout(() => { if (!unloaded) term.focus(); }, 0);
  });

  // xterm's target listener schedules native composition output at timer(0).
  // Observe at bubble phase and retain a delayed, session-bound fallback for
  // privileged frames where native onData was previously absent.
  containerEl.addEventListener('compositionstart', () => composition.start(), true);
  containerEl.addEventListener('compositionend', event => composition.end(event.data));
  containerEl.addEventListener('keydown', event => {
    if (!event.isComposing && event.keyCode !== 229) composition.boundary();
  }, true);
  containerEl.addEventListener('paste', () => composition.boundary(), true);

  // ---- Resize handling ----
  let resizeTimeout = null;
  const doResize = () => {
    fitAddon.fit();
    if (ptyId && connected) {
      void resizeTerminal(term.cols, term.rows).catch(reportAsyncError);
    }
  };

  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(doResize, 50);
  });
  ro.observe(containerEl);

  // ---- Cleanup on unload ----
  exposeTerminalApi();
  window.addEventListener('unload', () => {
    unloaded = true;
    connected = false;
    term.options.disableStdin = true;
    connectionGeneration++;
    writeQueue.invalidate();
    composition.invalidate();
    clearTimeout(resizeTimeout);
    stopPolling();
    if (ptyId) {
      void postTerminal('/terminal/kill', { sessionId: ptyId }).catch(reportAsyncError);
    }
    try { ro.disconnect(); term.dispose?.(); } catch (error) { reportAsyncError(error); }
  });
})();
