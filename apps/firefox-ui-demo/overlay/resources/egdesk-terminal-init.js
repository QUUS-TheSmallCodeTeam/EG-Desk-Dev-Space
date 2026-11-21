'use strict';
(async () => {
  const { createTerminalCloseController, createTerminalWriteQueue, createTerminalKeyEventGuard, createTerminalCompositionGate, createTerminalScriptRun, terminalExitEvidence, terminalResponsePacket } = await import('chrome://userchrome/content/EGDeskTerminalState.sys.mjs');
  const HELPER_PORT = 39218;
  const HELPER_ORIGIN = `http://127.0.0.1:${HELPER_PORT}`;
  const statusEl = document.getElementById('status-overlay');
  const containerEl = document.getElementById('terminal-container');
  const shellSelect = document.getElementById('terminal-shell-select');
  const shellButton = document.getElementById('terminal-shell-start');
  const shellLabel = document.getElementById('terminal-shell-label');
  const operationStatus = document.getElementById('terminal-operation-status');

  // This key belongs to this document, not the reusable iframe WindowProxy.
  const hostEventKey = window.crypto.randomUUID();
  function notifyTerminalHost(message) {
    try {
      window.parent.postMessage({ ...message, hostEventKey }, '*');
      return true;
    } catch { return false; }
  }

  // ---- Host colours (A23) ----
  // The page cannot inherit the Desk stylesheet, so it reads the Terminal
  // window's own tokens from the frame element that hosts it. Opened alone, the
  // page keeps the fallbacks declared in terminal.html.
  const TERMINAL_TOKENS = ['bg', 'ink', 'muted', 'line', 'control', 'control-line'];
  const hostTokens = (() => {
    const found = {};
    try {
      const frame = window.frameElement;
      const hostStyle = frame ? window.parent.getComputedStyle(frame) : null;
      for (const name of TERMINAL_TOKENS) {
        const value = hostStyle?.getPropertyValue('--egd-terminal-' + name).trim();
        if (!value) continue;
        found[name] = value;
        document.documentElement.style.setProperty('--egd-terminal-' + name, value);
      }
    } catch {}
    return found;
  })();

  // ---- xterm.js setup ----
  const term = new Terminal({
    cursorBlink: true,
    disableStdin: true,
    cursorStyle: 'bar',
    fontSize: 13,
    fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: hostTokens.bg || '#262925',
      foreground: hostTokens.ink || '#EDECE7',
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
    if (!managed) return connectBridge();
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
  let activeScript = null;
  let inputRevision = 0;
  let frameWheelHandler = null;
  let spawnPhase = 'idle', noSessionClosed = false;
  const definiteSpawnRejection = error => [
    'WINDOWS_PTY_UNAVAILABLE', 'WINDOWS_CONPTY_UNSUPPORTED', 'INVALID_TERMINAL_SHELL',
    'TERMINAL_SHELL_UNAVAILABLE', 'INVALID_TERMINAL_SIZE',
  ].includes(error.code) && Number.isInteger(error.httpStatus) && error.httpStatus >= 400;
  const managed = new URLSearchParams(window.location.search).get('managed') === '1';
  let scopedFetch = null, bridgeInstance = null, detachSupported = false, detachPending = null, detachUnconfirmed = false;
  let pendingAttach = null, resumed = false, renderingResumedOutput = 0;
  const requestedShellId = new URLSearchParams(window.location.search).get('shellId');
  const autoFocus = new URLSearchParams(window.location.search).get('autofocus') !== '0';
  const shellIdIsValid = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
  const reportAsyncError = error => console.warn('EG-Desk Terminal:', error.message || error);

  async function postTerminal(path, body, options = {}) {
    const controller = options.timeoutMs ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    try {
      if (managed && !scopedFetch) throw new Error('터미널 소유 범위를 확인하지 못했습니다.');
      const response = await (scopedFetch || fetch)(`${HELPER_ORIGIN}${path}`, {
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

  function invalidateScriptRun() {
    if (!activeScript) return;
    activeScript.cancelled = true;
    activeScript.run?.cancel();
  }

  // Only the PTY output transport feeds the receipt collector. term.onData is
  // keyboard/input traffic, even when it happens to contain an exit marker.
  function receiveTerminalOutput(data, sessionId) {
    if (typeof data !== 'string' || !data) return;
    // xterm may emit device replies during output parsing. A restored view
    // must never send those replies (or any previously queued input) to the PTY.
    if (resumed) { renderingResumedOutput++; term.write(data, () => { renderingResumedOutput--; }); }
    else term.write(data);
    if (activeScript && !activeScript.cancelled && activeScript.sessionId === sessionId
        && activeScript.generation === connectionGeneration) activeScript.run?.onData(data);
  }

  function showDisconnected(message) {
    if (closeRequested) { renderCloseState({ phase: 'offline', error: message }); return; }
    // The window bar shows the session state; tell it the connection is lost.
    try { notifyTerminalHost({ type: 'terminal-disconnected' }); } catch {}
    statusEl.textContent = message || '연결이 끊겼습니다. 눌러서 다시 연결합니다.';
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
    const generationAtRead = connectionGeneration;
    readPending = true;
    try {
      const result = await postTerminal('/terminal/read', { sessionId: sessionAtRead }, { timeoutMs: 5000 });
      if (ptyId !== sessionAtRead || connectionGeneration !== generationAtRead || unloaded) return;
      if (result.sessionId !== sessionAtRead || result.status === 'UNKNOWN') throw new Error('터미널 출력의 세션을 확인하지 못했습니다.');
      receiveTerminalOutput(result.data, sessionAtRead);
      if (result.outputTruncated && resumed) showOperationError('일부 출력은 보존 한도를 초과해 생략되었습니다.');
      if (result.status !== 'RUNNING') detachSupported = false;
      // CODE-06: a test/build result the bridge read from this session's own output.
      if (result.runResult && typeof result.runResult === 'object') {
        try { notifyTerminalHost({ type: 'terminal-run-result', sessionId: sessionAtRead, runResult: result.runResult }); } catch {}
      }
      if (terminalExitEvidence(result, sessionAtRead)) {
        invalidateScriptRun();
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
      if (ptyId !== sessionAtRead || connectionGeneration !== generationAtRead || closeRequested || unloaded) return;
      invalidateScriptRun();
      connected = false;
      term.options.disableStdin = true;
      stopPolling();
      writeQueue.invalidate();
      composition.invalidate();
      showDisconnected('연결이 끊겼습니다. 눌러서 같은 세션 연결을 다시 확인합니다.');
      showStatusDetail(e.message);
    } finally { readPending = false; }
  }

  function notifyTerminalExit() {
    try { notifyTerminalHost({ type: 'terminal-exit-confirmed' }); } catch {}
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
    onOutput: data => receiveTerminalOutput(data, terminalCloser.snapshot().sessionId),
    onState: closeState => {
      if (ptyId && closeState.sessionId !== ptyId) return;
      renderCloseState(closeState);
      if (closeState.phase === 'confirmed') {
        invalidateScriptRun();
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

  function canDetach() {
    return !!(scopedFetch && bridgeInstance && detachSupported && ptyId && !closeRequested
      && !unloaded && !activeScript && (connected || detachUnconfirmed));
  }

  function detachLocal() {
    if (detachPending) return detachPending;
    if (!canDetach()) return Promise.resolve({ ok: false, code: 'TERMINAL_DETACH_UNAVAILABLE' });
    const sessionId = ptyId;
    detachUnconfirmed = true;
    connected = false;
    term.options.disableStdin = true;
    writeQueue.invalidate();
    composition.invalidate();
    connectionGeneration++;
    stopPolling();
    detachPending = (async () => {
      try {
        const result = await postTerminal('/terminal/detach', { sessionId, bridgeInstance }, { timeoutMs: 3000, passErrors: true });
        if (result.httpStatus !== 200 || result.ok !== true || result.status !== 'HELD' ||
            result.sessionId !== sessionId || result.bridgeInstance !== bridgeInstance || !Number.isFinite(result.expiresAt)) {
          if (result.code === 'TERMINAL_DETACH_LIMIT') {
            detachUnconfirmed = false;
            markConnected();
          }
          return { ok: false, code: result.code || 'TERMINAL_DETACH_UNCONFIRMED' };
        }
        ptyId = null;
        connected = false;
        spawnPhase = 'idle';
        return { ok: true, sessionId, bridgeInstance, expiresAt: result.expiresAt, shellLabel: sessionInfo?.shellLabel };
      } catch { return { ok: false, code: 'TERMINAL_DETACH_UNCONFIRMED' }; }
    })().finally(() => {
      detachPending = null;
      if (!ptyId || closeRequested || unloaded) return;
      // A lost ACK may have left the original held. Do not enable input until
      // a distinct retry/read has proved its attached channel is still owned.
      showOperationError('창 분리 여부를 확인하지 못했습니다. 다시 시도할 수 있습니다.');
    });
    return detachPending;
  }

  async function attachLocal(ref) {
    if (!managed || !scopedFetch || unloaded || closeRequested || ptyId || connectPending || spawnPhase !== 'idle'
        || (pendingAttach && pendingAttach.sessionId !== ref.sessionId)) return { ok: false, code: 'TERMINAL_REENTRY_UNAVAILABLE' };
    pendingAttach = ref;
    shellButton.disabled = true;
    try {
      const result = await postTerminal('/terminal/attach', { sessionId: ref.sessionId, bridgeInstance: ref.bridgeInstance },
        { timeoutMs: 3000, passErrors: true });
      if (result.httpStatus !== 200 || result.ok !== true || result.status !== 'RUNNING' || result.usePty !== true ||
          result.sessionId !== ref.sessionId || result.bridgeInstance !== ref.bridgeInstance) {
        pendingAttach = null;
        return { ok: false, code: result.code || 'TERMINAL_REENTRY_UNAVAILABLE' };
      }
      if (unloaded || closeRequested) {
        void postTerminal('/terminal/kill', { sessionId: ref.sessionId }).catch(reportAsyncError);
        return { ok: false, code: 'TERMINAL_REENTRY_UNAVAILABLE' };
      }
      pendingAttach = null;
      ptyId = ref.sessionId;
      setSessionInfo(result);
      resumed = true;
      spawnPhase = 'active';
      // This is an explicit attach. No spawn path or queued writes are used.
      markConnected();
      return { ok: true };
    } catch { return { ok: false, code: 'TERMINAL_REENTRY_UNCONFIRMED' }; }
    finally { if (!closeRequested && !pendingAttach) shellButton.disabled = false; }
  }

  async function closeForBoard() {
    if (detachPending) return false;
    if (exitConfirmed) return true;
    closeRequested = true;
    invalidateScriptRun();
    term.options.disableStdin = true;
    shellButton.disabled = true;
    connectionGeneration++;
    writeQueue.invalidate();
    composition.invalidate();
    if (!ptyId) {
      if (pendingAttach) {
        // A lost attach ACK can have transferred ownership only to this view.
        // Kill is view-scoped and cannot stop a session still held or elsewhere.
        const prior = pendingAttach;
        return terminalCloser.close(prior.sessionId);
      }
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
    write: (sessionId, data) => postTerminal('/terminal/write', { sessionId, data }, { timeoutMs: 10000 }),
    onError: (error, sessionId) => {
      if (ptyId !== sessionId || unloaded) return;
      invalidateScriptRun();
      connected = false;
      term.options.disableStdin = true;
      stopPolling();
      composition.invalidate();
      showDisconnected('입력을 보내지 못했습니다. 명령을 자동으로 다시 보내지 않습니다.');
      showStatusDetail(error.message);
    },
  });
  const writeToTerminal = data => { inputRevision++; return writeQueue.enqueue(data); };
  const composition = createTerminalCompositionGate({
    send: writeToTerminal,
    sessionKey: () => writeQueue.snapshot().generation,
    onFallback: () => {
      const textarea = containerEl.querySelector('.xterm-helper-textarea');
      if (textarea) textarea.value = '';
    },
    onError: reportAsyncError,
  });

  async function runScript(request = {}) {
    const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
    if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['boardId', 'projectId', 'rootId', 'script'].includes(key))) {
      fail('TERMINAL_RUN_REQUEST', '프로젝트 검사에는 임의 실행 경로를 전달할 수 없습니다.');
    }
    const { boardId, projectId, rootId } = request;
    const script = request.script ? { ...request.script } : null;
    if (![boardId, projectId, rootId].every(id => typeof id === 'string' && id && id.length <= 512)
        || !script || typeof script.id !== 'string' || typeof script.name !== 'string' || typeof script.command !== 'string') {
      fail('TERMINAL_RUN_REQUEST', '프로젝트와 저장된 검사 명령이 필요합니다.');
    }
    if (activeScript) fail('TERMINAL_RUN_BUSY', '이 터미널에서 이미 검사를 진행 중입니다.');
    if (!ptyId || !connected || closeRequested || unloaded) fail('TERMINAL_INPUT_INACTIVE', '연결된 터미널이 없습니다.');
    const runContext = { sessionId: ptyId, generation: connectionGeneration, inputRevision, cancelled: false, run: null };
    // Human input can take an idle shell into a REPL during either authority
    // lookup or queue wait. Fence only undispatched scripts, not that input or
    // the receipt collection for a command already sent to the terminal.
    const current = () => activeScript === runContext && !runContext.cancelled && connected && !unloaded && !closeRequested
      && ptyId === runContext.sessionId && connectionGeneration === runContext.generation && inputRevision === runContext.inputRevision;
    activeScript = runContext;
    try {
      // Resolve authority from the existing helper-owned Board association.
      // A display path supplied by the File renderer is never executable input.
      const packet = await postTerminal('/v1/files/projects/open', { boardId }, { timeoutMs: 5000 });
      const project = packet.ok === true ? packet.result?.project : null;
      if (!current()) fail('TERMINAL_INPUT_STALE', '터미널 연결이 바뀌었거나 사용자 입력이 발생해 검사를 시작하지 않았습니다.');
      if (project?.status !== 'connected' || project.projectId !== projectId || project.rootId !== rootId
          || typeof project.displayPath !== 'string' || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(project.displayPath)
          || !project.scripts?.some(saved => saved.id === script.id && saved.name === script.name && saved.command === script.command)) {
        fail('TERMINAL_PROJECT_CHANGED', '프로젝트 폴더 또는 저장된 명령을 다시 확인하세요.');
      }
      const shell = shellCatalog?.platform === 'win32'
        ? ['powershell', 'pwsh'].includes(sessionInfo?.shellId) ? 'powershell' : null
        : /(?:^|[\s/(])(bash|zsh|sh|dash|ksh)(?:$|[\s)])/i.test(sessionInfo?.shellLabel || '') ? 'posix' : null;
      if (!shell) fail('TERMINAL_RUN_SHELL', '이 셸에서는 프로젝트 검사를 지원하지 않습니다.');
      const cwd = project.displayPath;
      const run = createTerminalScriptRun({ command: script.command, cwd, shell,
        write: data => writeQueue.enqueue(data, {
          isCurrent: () => current() && run.active,
          beforeWrite: async () => {
            // The queue may have waited behind human input. Revalidate at its
            // dispatch point, then fence again before the transport call.
            try {
              const fresh = await postTerminal('/v1/files/projects/open', { boardId }, { timeoutMs: 5000 });
              const checked = fresh.ok === true ? fresh.result?.project : null;
              return checked?.status === 'connected' && checked.projectId === projectId && checked.rootId === rootId && checked.displayPath === cwd
                && checked.scripts?.some(saved => saved.id === script.id && saved.name === script.name && saved.command === script.command)
                ? { ok: true } : { ok: false, code: 'TERMINAL_PROJECT_CHANGED' };
            } catch { return { ok: false, code: 'TERMINAL_PROJECT_UNCONFIRMED' }; }
          },
        }) });
      runContext.run = run;
      const result = await run.start();
      return { ...result, projectId, rootId, sessionId: runContext.sessionId, cwd };
    } finally { if (activeScript === runContext) activeScript = null; }
  }

  function exposeTerminalApi() {
    window.terminalAPI = {
      get hostEventKey() { return hostEventKey; },
      closeForBoard,
      configureLocal: (transport, idle) => {
        if (!managed || scopedFetch || typeof transport !== 'function') return;
        scopedFetch = transport;
        if (!idle) { void connectBridge(); return; }
        statusEl.textContent = '유지 중인 Terminal에 다시 연결하거나 새 터미널을 열 수 있습니다.';
        shellButton.textContent = '새 터미널 열기';
        shellButton.disabled = true;
        void loadShellCatalog().catch(error => showStatusDetail(error.message));
        notifyTerminalHost({ type: 'terminal-no-session' });
      },
      canDetach, detachLocal, attachLocal,
      runScript,
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
      setWheelHandler: handler => {
        if (handler !== null && typeof handler !== 'function') throw new TypeError('Wheel handler must be a function');
        frameWheelHandler = handler;
      },
      paste: (data) => {
        composition.boundary();
        term.paste(String(data ?? ''));
      },
      dataEventCount: () => dataEvents,
      inputRevision: () => inputRevision,
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

  // The raw error under the status line, folded. Opening it never reconnects.
  function showStatusDetail(raw) {
    if (!raw || closeRequested) return;
    const details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('div');
    summary.textContent = '자세히';
    text.textContent = String(raw);
    details.appendChild(summary); details.appendChild(text);
    details.addEventListener('click', event => event.stopPropagation());
    statusEl.appendChild(details);
  }

  function setSessionInfo(result, shellId = null) {
    bridgeInstance = typeof result.bridgeInstance === 'string' ? result.bridgeInstance : null;
    detachSupported = result.detachSupported === true;
    const build = result.windowsBuildNumber ?? shellCatalog?.windowsBuildNumber;
    if (result.transport === 'conpty' && Number.isSafeInteger(build) && build > 0) {
      term.options.windowsPty = { backend: 'conpty', buildNumber: build };
    }
    sessionInfo = { shellId: result.shellId || shellId,
      shellLabel: result.shellLabel || shellCatalog?.shells.find(shell => shell.id === shellId)?.label || '터미널',
      transport: result.transport || (result.usePty ? 'pty' : 'pipe'),
      usePty: result.usePty === true, degraded: result.degraded === true,
      windowsBuildNumber: Number.isSafeInteger(build) ? build : null };
    shellLabel.textContent = sessionInfo.shellLabel + ' · ' + sessionInfo.transport;
    if (!sessionInfo.usePty) showOperationError('파이프 연결: 대화형 PTY와 크기 변경을 지원하지 않습니다.');
  }

  function markConnected() {
    connected = true;
    term.options.disableStdin = false;
    exitConfirmed = false;
    confirmedExitSessionId = null;
    composition.invalidate();
    writeQueue.bind(ptyId);
    statusEl.classList.add('hidden');
    if (sessionInfo?.usePty) operationStatus.classList.add('hidden');
    shellButton.textContent = '새 터미널 열기';
    notifyTerminalHost({ type: 'terminal-ready', ptyId,
      shellId: sessionInfo?.shellId, shellLabel: sessionInfo?.shellLabel, resumed });
    readTimer = setInterval(readTerminalOutput, 80);
    void readTerminalOutput();
    if (autoFocus && window.parent === window) term.focus();
  }

  async function connectBridge() {
    if (unloaded || closeRequested || pendingAttach || detachPending) return false;
    if (spawnPhase === 'unknown' && !ptyId) {
      showSpawnUnconfirmed();
      return false;
    }
    if (connectPending) return connectPending;
    invalidateScriptRun();
    const generation = ++connectionGeneration;
    const current = () => !unloaded && !closeRequested && generation === connectionGeneration;
    statusEl.textContent = ptyId ? '같은 터미널 세션 연결 확인 중…' : '터미널 연결 중…';
    // The window bar and the shell line say the same thing as the middle of the window.
    try { notifyTerminalHost({ type: 'terminal-connecting' }); } catch {}
    if (!sessionInfo) shellLabel.textContent = '연결 준비 중';
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
          if (result.sessionId !== sessionId || result.status === 'UNKNOWN') throw new Error('터미널 출력의 세션을 확인하지 못했습니다.');
          receiveTerminalOutput(result.data, sessionId);
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
          setSessionInfo(result, shellId);
        }
        if (!current() || !ptyId) return false;
        markConnected();
        return true;
      } catch (error) {
        if (spawnPhase === 'pending') spawnPhase = definiteSpawnRejection(error) ? 'rejected' : 'unknown';
        if (!current()) {
          if (closeRequested && !unloaded && spawnPhase === 'rejected') {
            notifyTerminalHost({ type: 'terminal-no-session' });
          }
          return false;
        }
        connected = false;
        term.options.disableStdin = true;
        writeQueue.invalidate();
        composition.invalidate();
        shellButton.disabled = false;
        if (spawnPhase === 'unknown') showSpawnUnconfirmed();
        else {
          // One Korean line; the raw transport error stays folded under '자세히'.
          showDisconnected('터미널을 연결하지 못했습니다. 눌러서 다시 연결합니다.');
          if (!sessionInfo) shellLabel.textContent = '연결 실패';
          showStatusDetail(error.message);
        }
        return false;
      }
    })();
    try { return await connectPending; }
    finally { connectPending = null; }
  }

  shellButton.addEventListener('click', () => {
    if (pendingAttach || detachPending || detachUnconfirmed || closeRequested || unloaded) return;
    if (ptyId || sessionInfo) {
      if (!shellCatalog?.shells.some(shell => shell.id === shellSelect.value && shell.available)) return;
      notifyTerminalHost({ type: 'terminal-new-session', shellId: shellSelect.value });
    } else if (!unloaded && !closeRequested) {
      void connectBridge().catch(reportAsyncError);
    }
  });

  // ---- Terminal input -> PTY ----
  let dataEvents = 0; // 진단용: xterm이 사용자 입력을 인식한 횟수
  const keyGuard = createTerminalKeyEventGuard();
  term.attachCustomKeyEventHandler(event => keyGuard.keyEvent(event));
  term.onKey(event => keyGuard.onKey(event));
  term.onData((data) => {
    if (renderingResumedOutput) return;
    dataEvents += 1;
    void composition.data(data).catch(reportAsyncError);
  });

  // 프레임 내부 어디를 클릭해도 xterm으로 포커스 복귀
  // (chrome host의 프레임 포커스 핸드오프는 부모(eg-desk-surface)가 담당)
  const activateTerminalCard = () => {
    if (!unloaded) notifyTerminalHost({ type: 'terminal-activate' });
  };
  window.addEventListener('mousedown', event => {
    activateTerminalCard();
    if (event.target?.closest?.('#terminal-toolbar, #status-overlay button')) return;
    setTimeout(() => { if (!unloaded) term.focus(); }, 0);
  });
  window.addEventListener('wheel', event => {
    if (frameWheelHandler?.(event) !== true) return;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, passive: false });

  // xterm's target listener schedules native composition output at timer(0).
  // Observe at bubble phase and retain a delayed, session-bound fallback for
  // privileged frames where native onData was previously absent.
  containerEl.addEventListener('compositionstart', () => {
    keyGuard.reset();
    activateTerminalCard();
    composition.start();
  }, true);
  containerEl.addEventListener('compositionend', event => composition.end(event.data));
  containerEl.addEventListener('keydown', event => {
    activateTerminalCard();
    if (!event.isComposing && event.keyCode !== 229) composition.boundary();
  }, true);
  containerEl.addEventListener('input', event => keyGuard.input(event), true);
  containerEl.addEventListener('paste', () => {
    keyGuard.reset();
    activateTerminalCard();
    composition.boundary();
  }, true);
  window.addEventListener('blur', () => keyGuard.reset());

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
  notifyTerminalHost({ type: 'terminal-api-ready' });
  window.addEventListener('unload', () => {
    unloaded = true;
    frameWheelHandler = null;
    keyGuard.reset();
    invalidateScriptRun();
    connected = false;
    term.options.disableStdin = true;
    connectionGeneration++;
    writeQueue.invalidate();
    composition.invalidate();
    clearTimeout(resizeTimeout);
    stopPolling();
    const cleanupId = ptyId || pendingAttach?.sessionId;
    if (cleanupId && !detachPending) {
      void postTerminal('/terminal/kill', { sessionId: cleanupId }).catch(reportAsyncError);
    }
    try { ro.disconnect(); term.dispose?.(); } catch (error) { reportAsyncError(error); }
  });
})();
