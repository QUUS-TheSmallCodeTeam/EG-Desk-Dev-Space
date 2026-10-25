// Moved verbatim from overlay/JS/eg-desk-surface.uc.js.
// Loaded once per window: ChromeUtils.importESModule(url, { global: 'current' }).
// Never statically import a .sys.mjs here; shared modules arrive through deps.
export function createTerminalZone(deps) {
  const {
    TAG,
    allocCardSeq,
    bindCardSourceRef,
    boardCloseRequests,
    canvasZoom,
    closeCanvasCard,
    completeAgendaClose,
    el,
    focusCanvasCard,
    installCardHeaderFullscreenToggle,
    isCardFullscreen,
    makeSourceRef,
    markAgendaDirty,
    raiseCardZ,
    resolveCanvasCardPlacement,
    revealPlacedCanvasCard,
    setActiveEntity,
    state,
  } = deps;

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
    const card = el('div', {
      id,
      class: 'egd-canvas-card egd-terminal-card',
      style: {
        top: placement.y + 'px',
        left: placement.x + 'px',
        width: placement.width + 'px',
        height: placement.height + 'px',
        zIndex: String(raiseCardZ()),
      },
    });

    // ---- Header ----
    const header = el('div', { class: 'egd-card-header egd-terminal-header' },
      el('div', { class: 'egd-card-topbar' },
        el('div', { class: 'egd-card-dots-shell' },
          el('div', { class: 'egd-card-dots' },
            el('span', { class: 'egd-card-dot egd-card-dot-close', onclick: (ev) => { ev.stopPropagation(); closeCanvasCard(card, cleanupCard); } }),
            el('span', { class: 'egd-card-dot egd-card-dot-min' }),
            el('span', { class: 'egd-card-dot egd-card-dot-max' }),
          ),
        ),
        el('div', { class: 'egd-terminal-title' }, '>_ Terminal'),
      ),
    );

    // ---- Body with XUL browser ----
    const body = el('div', { class: 'egd-card-body egd-terminal-body' });

    // ---- Resize hit zones ----
    const resizeHits = [
      { cls: 'egd-card-resize-hit-n',  edges: { top: true } },
      { cls: 'egd-card-resize-hit-e',  edges: { right: true } },
      { cls: 'egd-card-resize-hit-s',  edges: { bottom: true } },
      { cls: 'egd-card-resize-hit-w',  edges: { left: true } },
      { cls: 'egd-card-resize-hit-nw', edges: { top: true, left: true } },
      { cls: 'egd-card-resize-hit-ne', edges: { top: true, right: true } },
      { cls: 'egd-card-resize-hit-se', edges: { bottom: true, right: true } },
      { cls: 'egd-card-resize-hit-sw', edges: { bottom: true, left: true } },
    ].map(({ cls, edges }) => el('div', {
      class: `egd-card-resize-hit ${cls}`,
      data: { edges: JSON.stringify(edges) },
    }));

    card.appendChild(header);
    card.appendChild(body);
    for (const hit of resizeHits) card.appendChild(hit);

    const host = document.getElementById('egd-canvas-layer') || document.documentElement;
    host.appendChild(card);
    bindCardSourceRef(card, sourceRef);
    markAgendaDirty('create-terminal-card', card);
    if (activate) setActiveEntity(card);
    if (reveal) revealPlacedCanvasCard(card, placement);

    // ---- Use iframe for terminal.html to isolate keyboard events ----
    const query = [];
    if (requestedShellId) query.push('shellId=' + encodeURIComponent(requestedShellId));
    if (!activate) query.push('autofocus=0');
    const termBrowser = el('iframe', {
      src: TERMINAL_HTML_URL + (query.length ? '?' + query.join('&') : ''),
      style: { width: '100%', height: '100%', border: '0', background: '#1a1a2e', display: 'block' },
    });
    body.appendChild(termBrowser);
    // ---- Card interactions ----
    const activateCard = () => {
      if (state.panModifier) return;
      setActiveEntity(card);
    };
    const focusCard = () => {
      focusCanvasCard(card);
    };
    const startPanIfNeeded = (ev) => {
      if (!state.panModifier || ev.button !== 0) return false;
      if (typeof state.startCanvasPanDrag !== 'function') return false;
      state.startCanvasPanDrag(ev);
      return true;
    };
    for (const target of [card, header]) {
      target.addEventListener('mousedown', () => activateCard(), true);
    }
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
    card.addEventListener('mousedown', () => {
      if (state.panModifier) return;
      // xterm의 mousedown preventDefault 이후에 포커스가 잡히도록 defer
      setTimeout(focusTerminal, 0);
    }, true);
    // 최초 연결 완료 시 자동 포커스 (terminal.html이 terminal-ready postMessage 발송)
    const onTerminalReady = (ev) => {
      if (ev.source !== termBrowser.contentWindow) return;
      if (ev.data?.type === 'terminal-new-session') {
        const shellId = ev.data.shellId;
        if (typeof shellId === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(shellId)) spawnTerminalCard({ shellId });
        return;
      }
      if (ev.data?.type === 'terminal-ready') {
        const label = ev.data.shellLabel;
        if (typeof label === 'string' && label.length <= 80) header.querySelector('.egd-terminal-title').textContent = '>_ ' + label;
        if (activate) focusTerminal();
      }
      if (['terminal-ready', 'terminal-exit-confirmed', 'terminal-no-session'].includes(ev.data?.type)
          && boardCloseRequests.has(card.dataset.projectionId)) {
        void completeAgendaClose({ projectionId: card.dataset.projectionId });
      }
    };
    window.addEventListener('message', onTerminalReady);

    // ---- Header drag (move) ----
    let drag = null;
    header.addEventListener('mousedown', (ev) => {
      if (startPanIfNeeded(ev)) return;
      if (isCardFullscreen(card)) return;
      if (ev.target.closest('.egd-card-dot')) return;
      focusCard();
      drag = { x: ev.clientX, y: ev.clientY, left: card.offsetLeft, top: card.offsetTop };
      ev.preventDefault();
    });
    installCardHeaderFullscreenToggle(card, header);

    // ---- Resize ----
    let resize = null;
    const MIN_W = 400;
    const MIN_H = 300;
    for (const hit of resizeHits) {
      hit.addEventListener('mousedown', (ev) => {
        if (startPanIfNeeded(ev)) return;
        if (isCardFullscreen(card)) return;
        focusCard();
        const edges = JSON.parse(hit.dataset.edges);
        resize = {
          x: ev.clientX, y: ev.clientY,
          left: card.offsetLeft, top: card.offsetTop,
          width: card.offsetWidth, height: card.offsetHeight,
          edges,
        };
        ev.preventDefault();
        ev.stopPropagation();
      });
    }

    const onMouseMove = (ev) => {
      if (drag) {
        const dx = ev.clientX - drag.x;
        const dy = ev.clientY - drag.y;
        const s = canvasZoom();
        card.style.left = (drag.left + dx / s) + 'px';
        card.style.top = (drag.top + dy / s) + 'px';
      }
      if (resize) {
        const s = canvasZoom();
        const dx = (ev.clientX - resize.x) / s;
        const dy = (ev.clientY - resize.y) / s;
        const e = resize.edges;
        let newW = resize.width;
        let newH = resize.height;
        let newL = resize.left;
        let newT = resize.top;
        if (e.right)  newW = Math.max(MIN_W, resize.width + dx);
        if (e.left)   { newW = Math.max(MIN_W, resize.width - dx); newL = resize.left + (resize.width - newW); }
        if (e.bottom) newH = Math.max(MIN_H, resize.height + dy);
        if (e.top)    { newH = Math.max(MIN_H, resize.height - dy); newT = resize.top + (resize.height - newH); }
        card.style.width = newW + 'px';
        card.style.height = newH + 'px';
        card.style.left = newL + 'px';
        card.style.top = newT + 'px';
      }
    };
    const onMouseUp = () => {
      if (drag) markAgendaDirty('move-terminal-card', card);
      if (resize) markAgendaDirty('resize-terminal-card', card);
      drag = null;
      resize = null;
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    // ---- Cleanup ----
    const cleanupCard = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('message', onTerminalReady);
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
    card._cleanup = cleanupCard;
    card._termBrowser = termBrowser;
    card._closeOwnedRuntime = async () => {
      const api = termBrowser.contentWindow?.terminalAPI;
      return api?.closeForBoard ? api.closeForBoard() : false;
    };
    return card;
  }

  return { spawnTerminalCard };
}
