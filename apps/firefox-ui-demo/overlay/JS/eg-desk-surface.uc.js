// ==UserScript==
// @name           EG-Desk Surface (4-Edge Framework)
// @description    Firefox chrome 을 EG-Desk Surface 로 재구성. Top Desk Rail + Bottom Dock
//                 + Left Preset Bag + Right Contextual HUD. Light mode warm palette,
//                 frosted glass, Inter typography. Spec: DESIGN_SYSTEM_SPEC.md
// @include        main
// ==/UserScript==
(function eg_desk_surface() {
  'use strict';
  const TAG = '[eg-desk-surface]';
  console.warn(TAG, 'loaded, readyState =', document.readyState);

  const PRESETS = [
    { id: 'react-dev',  label: 'RD', name: 'React 개발',  count: 5 },
    { id: 'meeting',    label: 'MT', name: '회의 준비',    count: 4 },
    { id: 'research',   label: 'RS', name: '리서치 모드',  count: 3 },
    { id: 'writing',    label: 'WR', name: '글쓰기',      count: 2 },
  ];

  const DOCK_LEFT = [
    { id: 'chat',     label: 'Chat',    icon: '💬' },
    { id: 'shelf',    label: 'Shelf',   icon: '📚' },
    { id: 'browser',  label: 'Browser', icon: '🌐' },
    { id: 'ide',      label: 'IDE',     icon: '‹›' },
    { id: 'create',   label: '＋',      icon: '＋' },
  ];
  const DOCK_CENTER = [
    { id: 'pencil',   label: 'Pencil',  icon: '✎' },
    { id: 'hand',     label: 'Hand',    icon: '✋' },
    { id: 'square',   label: 'Square',  icon: '□' },
    { id: 'arrow',    label: 'Arrow',   icon: '↖', active: true },
  ];
  const DOCK_RIGHT = [
    { id: 'trash',    label: 'Trash',   icon: '🗑' },
  ];

  const state = {
    activeTool: 'arrow',
    hudOpen: false,
    hudApp: null,
    pan: { x: 0, y: 0 },
    zoom: 1,
  };
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 3.0;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ============ Top: Desk Rail ============
  function buildDeskRail() {
    const rail = el('div', { id: 'egd-desk-rail', class: 'egd-edge egd-frosted' });

    const left = el('div', { class: 'egd-rail-section egd-rail-left' },
      el('div', { class: 'egd-rail-switcher' },
        el('span', { class: 'egd-rail-desk-dot' }),
        el('span', { class: 'egd-rail-desk-name' }, 'Main Desk'),
        el('span', { class: 'egd-rail-chevron' }, '▾'),
      ),
    );

    const searchInput = el('input', {
      type: 'text',
      class: 'egd-rail-search-input',
      placeholder: 'Search or ask AI...',
      onkeydown: (ev) => {
        if (ev.key === 'Enter' && searchInput.value.trim()) {
          const q = searchInput.value.trim();
          try {
            const url = /^https?:\/\//i.test(q) ? q
              : /^[\w-]+(\.[\w-]+)+/.test(q) ? 'https://' + q
              : 'https://duckduckgo.com/?q=' + encodeURIComponent(q);
            gBrowser.loadURI(Services.io.newURI(url), {
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
            });
          } catch (e) { console.error(TAG, 'loadURI failed', e); }
          searchInput.value = '';
        }
      },
    });

    const center = el('div', { class: 'egd-rail-section egd-rail-center' },
      el('div', { class: 'egd-rail-search' },
        el('span', { class: 'egd-rail-search-icon' }, '⌕'),
        searchInput,
        el('span', { class: 'egd-rail-kbd' }, '⌘K'),
      ),
    );

    const right = el('div', { class: 'egd-rail-section egd-rail-right' },
      el('button', { class: 'egd-rail-icon', title: 'Minimap' }, '◱'),
      el('button', { class: 'egd-rail-icon', title: 'Notifications' },
        '🔔',
        el('span', { class: 'egd-rail-badge' }, '3'),
      ),
      el('div', { class: 'egd-rail-avatar', title: 'Profile' }, 'M'),
    );

    rail.appendChild(left);
    rail.appendChild(center);
    rail.appendChild(right);
    return rail;
  }

  // ============ Bottom: Dock ============
  function buildDock() {
    const dock = el('div', { id: 'egd-dock', class: 'egd-edge egd-frosted' });

    const makeGroup = (items, kind) => {
      const g = el('div', { class: `egd-dock-group egd-dock-${kind}` });
      for (const item of items) {
        const btn = el('button', {
          class: 'egd-dock-btn' + (kind === 'center' && state.activeTool === item.id ? ' egd-dock-btn-active' : ''),
          title: item.label,
          data: { id: item.id, kind },
          onclick: () => {
            if (kind === 'center') {
              state.activeTool = item.id;
              for (const b of g.querySelectorAll('.egd-dock-btn')) {
                b.classList.toggle('egd-dock-btn-active', b.dataset.id === item.id);
              }
            } else if (kind === 'left') {
              if (item.id === 'browser') {
                spawnBrowserCard();
              } else {
                toggleHUD(item.id, item.label);
              }
            }
          },
        }, el('span', { class: 'egd-dock-icon' }, item.icon));
        g.appendChild(btn);
      }
      return g;
    };

    const divider = () => el('span', { class: 'egd-dock-divider' });

    dock.appendChild(makeGroup(DOCK_LEFT, 'left'));
    dock.appendChild(divider());
    dock.appendChild(makeGroup(DOCK_CENTER, 'center'));
    dock.appendChild(divider());
    dock.appendChild(makeGroup(DOCK_RIGHT, 'right'));
    return dock;
  }

  // ============ Left: Preset Bag ============
  function buildPresetBag() {
    const bag = el('div', { id: 'egd-preset-bag', class: 'egd-edge egd-frosted' });

    bag.appendChild(el('div', { class: 'egd-bag-header', title: 'Preset Bag' }, '🎒'));

    const list = el('div', { class: 'egd-bag-list' });
    for (const preset of PRESETS) {
      const chip = el('button', {
        class: 'egd-bag-chip',
        title: `${preset.name} · ${preset.count} items`,
        data: { id: preset.id },
      }, preset.label);
      list.appendChild(chip);
    }
    list.appendChild(el('button', { class: 'egd-bag-add', title: 'New preset' }, '+'));
    bag.appendChild(list);

    return bag;
  }

  // ============ Right: Contextual HUD ============
  function buildHUD() {
    const hud = el('div', { id: 'egd-hud', class: 'egd-edge egd-frosted egd-hud-hidden' });

    const header = el('div', { class: 'egd-hud-header' },
      el('span', { class: 'egd-hud-title' }, 'Chat'),
      el('button', {
        class: 'egd-hud-close',
        title: 'Close',
        onclick: () => toggleHUD(null),
      }, '×'),
    );

    const body = el('div', { class: 'egd-hud-body', id: 'egd-hud-body' },
      el('div', { class: 'egd-hud-placeholder' },
        el('div', { class: 'egd-hud-ph-title' }, 'Contextual HUD'),
        el('div', { class: 'egd-hud-ph-sub' }, 'Dock 좌측 앱 클릭 시 여기에 전용 패널이 렌더됩니다.'),
      ),
    );

    hud.appendChild(header);
    hud.appendChild(body);
    return hud;
  }

  function toggleHUD(appId, appLabel) {
    const hud = document.getElementById('egd-hud');
    if (!hud) return;
    if (!appId || (state.hudOpen && state.hudApp === appId)) {
      hud.classList.add('egd-hud-hidden');
      state.hudOpen = false;
      state.hudApp = null;
      return;
    }
    state.hudOpen = true;
    state.hudApp = appId;
    hud.classList.remove('egd-hud-hidden');
    hud.querySelector('.egd-hud-title').textContent = appLabel;
    const body = document.getElementById('egd-hud-body');
    body.textContent = '';
    body.appendChild(el('div', { class: 'egd-hud-placeholder' },
      el('div', { class: 'egd-hud-ph-title' }, `${appLabel} HUD`),
      el('div', { class: 'egd-hud-ph-sub' }, `${appLabel} 전용 패널이 여기 렌더됩니다. 실제 기능은 Phase 2 에서 연결.`),
    ));
  }

  // ============ Canvas Entity: Browser Card ============
  let cardZ = 40000;
  let cardSeq = 0;

  function spawnBrowserCard(initialUrl = 'https://duckduckgo.com') {
    const id = `egd-browser-card-${++cardSeq}`;
    const offset = (cardSeq % 6) * 28;

    const card = el('div', {
      id,
      class: 'egd-canvas-card egd-browser-card',
      style: {
        top: (120 + offset) + 'px',
        left: (120 + offset) + 'px',
        zIndex: String(++cardZ),
      },
    });

    // ---- drag handle + url bar + close ----
    const urlInput = el('input', {
      type: 'text',
      class: 'egd-card-url',
      value: initialUrl,
    });

    const header = el('div', { class: 'egd-card-header' },
      el('div', { class: 'egd-card-dots' },
        el('span', { class: 'egd-card-dot egd-card-dot-close', onclick: (ev) => { ev.stopPropagation(); card.remove(); } }),
        el('span', { class: 'egd-card-dot egd-card-dot-min' }),
        el('span', { class: 'egd-card-dot egd-card-dot-max' }),
      ),
      urlInput,
      el('button', {
        class: 'egd-card-reload',
        title: 'Reload',
        onclick: (ev) => { ev.stopPropagation(); xulBrowser.reload && xulBrowser.reload(); },
      }, '↻'),
    );

    // ---- Real web content via XUL browser ----
    const body = el('div', { class: 'egd-card-body' });
    card.appendChild(header);
    card.appendChild(body);

    const host = document.getElementById('egd-canvas-layer') || document.documentElement;
    host.appendChild(card);

    let xulBrowser;
    try {
      xulBrowser = document.createXULElement('browser');
      xulBrowser.setAttribute('type', 'content');
      xulBrowser.setAttribute('remote', 'true');
      xulBrowser.setAttribute('maychangeremoteness', 'true');
      xulBrowser.setAttribute('disableglobalhistory', 'true');
      xulBrowser.setAttribute('flex', '1');
      xulBrowser.style.cssText = 'flex:1; width:100%; height:100%; background:#fff;';
      body.appendChild(xulBrowser);
      xulBrowser.setAttribute('src', initialUrl);
    } catch (e) {
      console.error(TAG, 'XUL browser create failed, falling back to iframe', e);
      const frame = el('iframe', { src: initialUrl, style: { flex: '1', width: '100%', height: '100%', border: '0' } });
      body.appendChild(frame);
      xulBrowser = frame;
    }

    urlInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      let url = urlInput.value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) {
        url = /^[\w-]+(\.[\w-]+)+/.test(url) ? 'https://' + url : 'https://duckduckgo.com/?q=' + encodeURIComponent(url);
      }
      try { xulBrowser.setAttribute('src', url); } catch (e) { console.error(TAG, e); }
    });

    // ---- drag ----
    let drag = null;
    header.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('input, button, .egd-card-dot')) return;
      drag = { x: ev.clientX, y: ev.clientY, left: card.offsetLeft, top: card.offsetTop };
      card.style.zIndex = String(++cardZ);
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      const s = state.zoom || 1;
      card.style.left = (drag.left + (ev.clientX - drag.x) / s) + 'px';
      card.style.top  = (drag.top  + (ev.clientY - drag.y) / s) + 'px';
    });
    window.addEventListener('mouseup', () => { drag = null; });

    card.addEventListener('mousedown', () => { card.style.zIndex = String(++cardZ); });

    console.warn(TAG, 'browser card spawned', id, initialUrl);
    card._xulBrowser = xulBrowser;
    return card;
  }

  // ============ Popup capture (window.open / target=_blank → card) ============
  function installPopupCapture() {
    const BDW = {
      QueryInterface: ChromeUtils.generateQI(['nsIBrowserDOMWindow']),

      isTabContentWindow(aWindow) { return true; },
      canClose() { return true; },
      get tabCount() {
        return document.querySelectorAll('.egd-browser-card').length;
      },

      createContentWindow(aURI, aOpenWindowInfo, aWhere, aFlags, aTriggeringPrincipal, aCsp) {
        const url = aURI ? aURI.spec : 'about:blank';
        console.warn(TAG, 'BDW.createContentWindow →', url);
        const card = spawnBrowserCard(url);
        try { return card._xulBrowser.contentWindow; }
        catch (e) { console.warn(TAG, 'contentWindow not ready', e); return null; }
      },

      openURI(aURI, aOpenWindowInfo, aWhere, aFlags, aTriggeringPrincipal, aCsp) {
        const url = aURI ? aURI.spec : 'about:blank';
        console.warn(TAG, 'BDW.openURI →', url);
        const card = spawnBrowserCard(url);
        try { return card._xulBrowser.contentWindow; }
        catch (e) { return null; }
      },

      createContentWindowInFrame(aURI, aParams, aWhere, aFlags, aName) {
        const url = aURI ? aURI.spec : 'about:blank';
        console.warn(TAG, 'BDW.createContentWindowInFrame →', url, 'name=', aName);
        const card = spawnBrowserCard(url);
        return card._xulBrowser;
      },

      openURIInFrame(aURI, aParams, aWhere, aFlags, aName) {
        const url = aURI ? aURI.spec : 'about:blank';
        console.warn(TAG, 'BDW.openURIInFrame →', url, 'name=', aName);
        const card = spawnBrowserCard(url);
        return card._xulBrowser;
      },
    };

    try {
      window.browserDOMWindow = BDW;
      console.warn(TAG, 'popup capture installed: window.open → card');
    } catch (e) {
      console.error(TAG, 'failed to install popup capture', e);
    }
  }

  // ============ Firefox chrome 정리 ============
  function hideFirefoxChrome() {
    const toHide = ['TabsToolbar', 'navigator-toolbox'];
    for (const id of toHide) {
      const el2 = document.getElementById(id);
      if (el2) el2.style.visibility = 'collapse';
    }
    const browserEl = document.getElementById('browser');
    if (browserEl) browserEl.style.background = '#F5F3EF';

    // 메인 탭 panel 을 display:none 처리 + content process discard (0 프로세스)
    const panels = document.getElementById('tabbrowser-tabpanels');
    if (panels) panels.style.display = 'none';
    try {
      if (typeof gBrowser !== 'undefined' && gBrowser.discardBrowser) {
        for (const tab of Array.from(gBrowser.tabs)) {
          if (!tab.selected) gBrowser.discardBrowser(tab);
        }
      }
    } catch (e) { console.warn(TAG, 'discardBrowser unavailable', e); }
  }

  // ============ Canvas Pan / Zoom ============
  function installCanvasPanZoom(layer) {
    const indicator = el('div', { id: 'egd-zoom-indicator' }, '100%');
    document.documentElement.appendChild(indicator);

    function apply() {
      layer.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
      indicator.textContent = Math.round(state.zoom * 100) + '%';
    }
    apply();

    // Pan: 빈 캔버스 영역 mousedown + drag (카드 위에서는 pan 안 함)
    let pan = null;
    layer.addEventListener('mousedown', (ev) => {
      if (ev.target !== layer) return;   // 카드 클릭은 pan 아님
      if (ev.button !== 0) return;
      pan = { x: ev.clientX, y: ev.clientY, px: state.pan.x, py: state.pan.y };
      document.body.style.cursor = 'grabbing';
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!pan) return;
      state.pan.x = pan.px + (ev.clientX - pan.x);
      state.pan.y = pan.py + (ev.clientY - pan.y);
      apply();
    });
    window.addEventListener('mouseup', () => {
      if (!pan) return;
      pan = null;
      document.body.style.cursor = '';
    });

    // Zoom: Ctrl/Cmd + wheel, 또는 트랙패드 pinch. 커서 위치 기준 zoom-to-cursor
    layer.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      const delta = -ev.deltaY * 0.0015;
      const factor = Math.exp(delta);
      const prevZoom = state.zoom;
      const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prevZoom * factor));
      if (nextZoom === prevZoom) return;
      // zoom-to-cursor: 커서 화면 좌표를 고정점으로 유지
      const cx = ev.clientX;
      const cy = ev.clientY;
      const ratio = nextZoom / prevZoom;
      state.pan.x = cx - (cx - state.pan.x) * ratio;
      state.pan.y = cy - (cy - state.pan.y) * ratio;
      state.zoom = nextZoom;
      apply();
    }, { passive: false });

    // 리셋 단축키: Ctrl+0
    window.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === '0') {
        state.pan = { x: 0, y: 0 };
        state.zoom = 1;
        apply();
        ev.preventDefault();
      }
    });
  }

  function paintSurface() {
    const root = document.documentElement;
    root.style.setProperty('--egd-surface', '#F5F3EF');
    root.style.setProperty('--egd-surface-elevated', '#FFFFFF');
    root.style.setProperty('--egd-primary', '#2D5A7B');
    root.style.setProperty('--egd-primary-container', '#E3EEF5');
    root.style.setProperty('--egd-secondary', '#6B7B8D');
    root.style.setProperty('--egd-outline', '#D4D0CA');
    root.style.setProperty('--egd-outline-variant', '#E8E4DE');
    root.style.setProperty('--egd-on-surface', '#1A1A1A');
    root.style.setProperty('--egd-on-surface-variant', '#5A5A5A');
    document.body.style.background = '#F5F3EF';
  }

  function boot() {
    try {
      if (document.getElementById('egd-desk-rail')) return;
      paintSurface();
      hideFirefoxChrome();
      const host = document.documentElement;
      const canvasLayer = el('div', { id: 'egd-canvas-layer' });
      host.appendChild(canvasLayer);
      installCanvasPanZoom(canvasLayer);
      host.appendChild(buildDeskRail());
      host.appendChild(buildDock());
      host.appendChild(buildPresetBag());
      host.appendChild(buildHUD());
      installPopupCapture();
      console.warn(TAG, 'ready ✅');
    } catch (err) {
      console.error(TAG, 'boot failed:', err, err.stack);
    }
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
})();
