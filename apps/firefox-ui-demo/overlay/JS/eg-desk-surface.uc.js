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
    { id: 'chat',     label: '채팅',    icon: '💬' },
    { id: 'shelf',    label: '서재',    icon: '📚' },
    { id: 'browser',  label: '브라우저', icon: '🌐' },
    { id: 'ide',      label: 'IDE',     icon: '‹›' },
    { id: 'settings', label: '설정',   icon: '⚙️' },
    { id: 'create',   label: '추가',      icon: '＋' },
  ];
  const DOCK_CENTER = [
    { id: 'pencil',   label: '펜',  icon: '✎' },
    { id: 'hand',     label: '손',    icon: '✋' },
    { id: 'square',   label: '사각형',  icon: '□' },
    { id: 'arrow',    label: '화살표',   icon: '↖', active: true },
  ];
  const DOCK_RIGHT = [
    { id: 'trash',    label: '휴지통',   icon: '🗑' },
  ];

  const SELF_MEMBER = '나';

  function uniqueNames(list) {
    return Array.from(new Set((Array.isArray(list) ? list : []).filter((name) => typeof name === 'string' && name.trim())));
  }

  function buildThreadSubtitle(type, participants) {
    if (type === 'group') {
      const count = Math.max(0, participants.length);
      return `멤버 ${count}명`;
    }
    const peer = participants.find((name) => name !== SELF_MEMBER) || '개인 채팅';
    return `개인 · ${peer}`;
  }

  function createCodexThread(type, title, subtitle = '', options = {}) {
    const participants = Array.isArray(options.participants) && options.participants.length > 0
      ? uniqueNames(options.participants)
      : type === 'group'
        ? [SELF_MEMBER, '코덱스 어시스턴트', '디자인 리뷰어']
        : [SELF_MEMBER, title];
    const participantRoles = { ...(options.participantRoles || {}) };
    for (const member of participants) {
      if (!participantRoles[member]) {
        participantRoles[member] = member === SELF_MEMBER ? 'owner' : 'member';
      }
    }
    if (type === 'group' && participants.includes('코덱스 어시스턴트') && participantRoles['코덱스 어시스턴트'] === 'member') {
      participantRoles['코덱스 어시스턴트'] = 'admin';
    }
    const safeSubtitle = subtitle || buildThreadSubtitle(type, participants);
    return {
      id: `thread-${type}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      title,
      subtitle: safeSubtitle,
      participants,
      participantRoles,
      pinned: Boolean(options.pinned),
      conversationId: null,
      messages: [],
      unreadCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function defaultCodexThreads() {
    return [
      createCodexThread('dm', '코덱스 어시스턴트', '', {
        participants: [SELF_MEMBER, '코덱스 어시스턴트'],
        participantRoles: {
          [SELF_MEMBER]: 'owner',
          '코덱스 어시스턴트': 'member',
        },
        pinned: true,
      }),
      createCodexThread('group', 'EG-Desk 팀', '', {
        participants: [SELF_MEMBER, '코덱스 어시스턴트', '미나', '디자이너'],
        participantRoles: {
          [SELF_MEMBER]: 'owner',
          '코덱스 어시스턴트': 'admin',
          미나: 'admin',
          디자이너: 'member',
        },
      }),
    ];
  }

  const state = {
    activeTool: 'arrow',
    hudOpen: false,
    hudApp: null,
    activeEntityId: null,
    pan: { x: 0, y: 0 },
    panTarget: { x: 0, y: 0 },
    zoom: 1,
    zoomTarget: 1,
    panCanvasByWheel: null,
    startCanvasPanDrag: null,
    panModifier: false,
    nativeGestureHook: null,
    codexBridge: null,
    codex: {
      provider: 'codex',
      protocolVersion: 0,
      authStatus: {
        isLoggedIn: false,
        authMode: null,
        accountId: null,
        accountEmail: null,
        lastRefresh: null,
        source: 'none',
        statusText: '로그인 필요',
        loginInProgress: false,
        authSessionId: null,
        authUrl: null,
        verificationUrl: null,
        userCode: null,
        callbackUrl: null,
        loginMode: 'browser',
      },
      conversationId: null,
      threads: defaultCodexThreads(),
      activeThreadId: null,
      messageThreadMap: {},
      pendingThreadId: null,
      threadNonce: 0,
      memberNonce: 0,
      threadQuery: '',
      threadFilter: 'all',
      hudView: 'list',
      memberMenu: null,
      threadMenu: null,
      draft: '',
      threadDrafts: {},
      loginLog: '',
      error: null,
      isSending: false,
      isStartingLogin: false,
      connected: false,
      lastBridgeLatency: null,
      showDiagnostics: false,
      authCardEntityId: null,
      chatDockMode: 'hud',
      chatCardEntityId: null,
    },
  };
  state.codex.activeThreadId = state.codex.threads[0]?.id || null;

  function getCodexThreadById(codex, threadId) {
    return codex.threads.find((thread) => thread.id === threadId) || null;
  }

  function getActiveCodexThread(codex) {
    const active = getCodexThreadById(codex, codex.activeThreadId);
    return active || codex.threads[0] || null;
  }

  function getCodexThreadDraft(codex, threadId) {
    if (!threadId) return '';
    const drafts = codex.threadDrafts || {};
    return typeof drafts[threadId] === 'string' ? drafts[threadId] : '';
  }

  function withCodexThread(codex, threadId, updater) {
    const nextThreads = codex.threads.map((thread) => {
      if (thread.id !== threadId) return thread;
      const updated = updater(thread);
      return { ...updated, updatedAt: Date.now() };
    });
    return nextThreads;
  }

  function codexThreadPreview(thread) {
    const lastMessage = thread.messages[thread.messages.length - 1];
    if (!lastMessage || !lastMessage.content) {
      return thread.type === 'group' ? '아직 그룹 메시지가 없습니다' : '아직 메시지가 없습니다';
    }
    const prefix = lastMessage.role === 'user' ? '나: ' : '';
    return `${prefix}${lastMessage.content}`.slice(0, 70);
  }

  function codexThreadTypeLabel(type) {
    return type === 'group' ? '그룹' : '개인';
  }

  function codexThreadRole(thread, memberName) {
    if (!thread || !memberName) return 'member';
    return thread.participantRoles?.[memberName] || (memberName === SELF_MEMBER ? 'owner' : 'member');
  }

  function codexThreadMatchesQuery(thread, query) {
    if (!query) return true;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [
      thread.title,
      thread.subtitle,
      codexThreadPreview(thread),
      ...(thread.participants || []),
    ]
      .filter(Boolean)
      .some((text) => String(text).toLowerCase().includes(q));
  }

  function normalizeThreadFilter(filter) {
    if (filter === 'dm' || filter === 'group') return filter;
    return 'all';
  }

  function normalizeHudView(view) {
    return view === 'conversation' ? 'conversation' : 'list';
  }

  function codexRoleLabel(role) {
    if (role === 'admin') return '관리자';
    if (role === 'owner') return '소유자';
    return '멤버';
  }

  function codexMessageRoleLabel(role) {
    if (role === 'user') return '사용자';
    if (role === 'assistant') return '어시스턴트';
    if (role === 'system') return '시스템';
    return role || '메시지';
  }

  function codexReadMeta(message, thread) {
    if (!message || message.role !== 'user') return '';
    const readBy = Array.isArray(message.readBy) ? message.readBy : [];
    const others = readBy.filter((name) => name !== SELF_MEMBER);
    if (others.length === 0) {
      return el('span', { class: 'egd-codex-bubble-read' },
        el('span', { class: 'egd-codex-read-icon' }, '\u2713'), ' \uc804\uc1a1\ub428');
    }
    if (thread?.type === 'dm') {
      return el('span', { class: 'egd-codex-bubble-read' },
        el('span', { class: 'egd-codex-read-icon egd-codex-read-icon-read' }, '\u2713\u2713'), ' \uc77d\uc74c');
    }
    return el('span', { class: 'egd-codex-bubble-read' },
      el('span', { class: 'egd-codex-read-icon egd-codex-read-icon-read' }, '\u2713\u2713'), ` ${others.length}\uba85 \uc77d\uc74c`);
  }
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 4.5;
  const WHEEL_PAN_SPEED = 1.15;
  const WHEEL_ZOOM_SPEED = 0.0044;
  const PAN_SMOOTHING = 0.24;
  const ZOOM_SMOOTHING = 0.22;
  const WHEEL_SESSION_IDLE_MS = 140;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') { if (typeof v === 'string') node.style.cssText = v; else Object.assign(node.style, v); }
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

  function setActiveEntity(entity) {
    for (const node of document.querySelectorAll('.egd-entity-active, .egd-entity-selected')) {
      node.classList.remove('egd-entity-active', 'egd-entity-selected');
    }
    if (!entity || !entity.isConnected) {
      state.activeEntityId = null;
      return;
    }
    entity.classList.add('egd-entity-selected', 'egd-entity-active');
    state.activeEntityId = entity.id || null;
  }

  function setSelectedEntities(entities, activeEntity = null) {
    for (const node of document.querySelectorAll('.egd-entity-active, .egd-entity-selected')) {
      node.classList.remove('egd-entity-active', 'egd-entity-selected');
    }
    const valid = entities.filter((entity) => entity && entity.isConnected);
    for (const entity of valid) entity.classList.add('egd-entity-selected');
    const active = activeEntity && valid.includes(activeEntity) ? activeEntity : valid[0] || null;
    if (!active) {
      state.activeEntityId = null;
      return;
    }
    active.classList.add('egd-entity-active');
    state.activeEntityId = active.id || null;
  }

  function viewportToCanvasPoint(clientX, clientY) {
    return {
      x: (clientX - state.panTarget.x) / state.zoomTarget,
      y: (clientY - state.panTarget.y) / state.zoomTarget,
    };
  }

  function resolveFloatingMenuPlacement(anchorRect, menuWidth = 152, menuHeight = 156) {
    const margin = 8;
    const viewportW = window.innerWidth || 1280;
    const viewportH = window.innerHeight || 720;
    const left = Math.max(
      margin,
      Math.min(viewportW - menuWidth - margin, anchorRect.right - menuWidth)
    );
    let top = anchorRect.bottom + 6;
    if (top + menuHeight > viewportH - margin) {
      top = Math.max(margin, anchorRect.top - menuHeight - 6);
    }
    return { left, top };
  }

  function syncPanModeCursor() {
    const root = document.documentElement;
    root.classList.toggle('egd-pan-ready', !!state.panModifier);
    root.classList.toggle('egd-pan-dragging', !!root.dataset.egdPanDragging);
  }

  // ============ Top: Desk Rail ============
  function buildDeskRail() {
    const rail = el('div', { id: 'egd-desk-rail', class: 'egd-edge egd-frosted' });

    const left = el('div', { class: 'egd-rail-section egd-rail-left' },
      el('div', { class: 'egd-rail-switcher' },
        el('span', { class: 'egd-rail-desk-dot' }),
        el('span', { class: 'egd-rail-desk-name' }, '메인 데스크'),
        el('span', { class: 'egd-rail-chevron' }, '▾'),
      ),
    );

    const searchInput = el('input', {
      type: 'text',
      class: 'egd-rail-search-input',
      placeholder: '검색 또는 AI에게 요청...',
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
      el('button', { class: 'egd-rail-icon', title: '미니맵' }, '◱'),
      el('button', { class: 'egd-rail-icon', title: '알림' },
        '🔔',
        el('span', { class: 'egd-rail-badge' }, '3'),
      ),
      el('div', { class: 'egd-rail-avatar', title: '프로필' }, 'M'),
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
              } else if (item.id === 'settings') {
                spawnSettingsCard();
              } else if (item.id === 'chat' && state.codex.chatDockMode === 'canvas' && state.codex.chatCardEntityId) {
                const chatCard = document.getElementById(state.codex.chatCardEntityId);
                if (chatCard) {
                  chatCard.style.zIndex = String(++cardZ);
                  setActiveEntity(chatCard);
                } else {
                  state.codex.chatDockMode = 'hud';
                  state.codex.chatCardEntityId = null;
                  toggleHUD(item.id, item.label);
                }
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

    bag.appendChild(el('div', { class: 'egd-bag-header', title: '프리셋 가방' }, '🎒'));

    const list = el('div', { class: 'egd-bag-list' });
    for (const preset of PRESETS) {
      const chip = el('button', {
        class: 'egd-bag-chip',
        title: `${preset.name} · ${preset.count}개 항목`,
        data: { id: preset.id },
      }, preset.label);
      list.appendChild(chip);
    }
    list.appendChild(el('button', { class: 'egd-bag-add', title: '새 프리셋' }, '+'));
    bag.appendChild(list);

    return bag;
  }

  // ============ Right: Contextual HUD ============
  function buildHUD() {
    const hud = el('div', { id: 'egd-hud', class: 'egd-edge egd-frosted egd-hud-hidden' });

    const pinButton = el('button', {
      class: 'egd-hud-pin',
      title: '캔버스로 이동',
      onclick: (ev) => {
        ev.stopPropagation();
        if (state.hudApp !== 'chat') return;
        detachCodexChatFromHud();
      },
    }, '⇲');

    const header = el('div', { class: 'egd-hud-header' },
      el('span', { class: 'egd-hud-title' }, '채팅'),
      el('div', { class: 'egd-hud-header-actions' },
        pinButton,
        el('button', {
          class: 'egd-hud-close',
          title: '닫기',
          onclick: () => toggleHUD(null),
        }, '×'),
      ),
    );

    const body = el('div', { class: 'egd-hud-body', id: 'egd-hud-body' },
      el('div', { class: 'egd-hud-placeholder' },
        el('div', { class: 'egd-hud-ph-title' }, '컨텍스트 패널'),
        el('div', { class: 'egd-hud-ph-sub' }, '도크 왼쪽 앱 클릭 시 여기에 전용 패널이 렌더됩니다.'),
      ),
    );

    let hudDrag = null;
    const cancelHudDrag = () => {
      hudDrag = null;
      header.classList.remove('egd-hud-header-dragging');
    };
    const onHudDragMove = (ev) => {
      if (!hudDrag) return;
      if (Math.hypot(ev.clientX - hudDrag.x, ev.clientY - hudDrag.y) > 8) {
        hudDrag.moved = true;
        header.classList.add('egd-hud-header-dragging');
      }
    };
    const onHudDragUp = (ev) => {
      if (!hudDrag) return;
      window.removeEventListener('mousemove', onHudDragMove, true);
      window.removeEventListener('mouseup', onHudDragUp, true);
      const moved = hudDrag.moved;
      cancelHudDrag();
      if (!moved || state.hudApp !== 'chat') return;
      const underPointer = document.elementFromPoint(ev.clientX, ev.clientY);
      if (underPointer && underPointer.closest('#egd-hud')) return;
      detachCodexChatFromHud(ev.clientX, ev.clientY);
    };
    header.addEventListener('mousedown', (ev) => {
      if (state.hudApp !== 'chat') return;
      if (ev.button !== 0 || ev.target.closest('button, input, textarea, a')) return;
      hudDrag = { x: ev.clientX, y: ev.clientY, moved: false };
      window.addEventListener('mousemove', onHudDragMove, true);
      window.addEventListener('mouseup', onHudDragUp, true);
      ev.preventDefault();
    });
    window.addEventListener('blur', () => {
      if (!hudDrag) return;
      window.removeEventListener('mousemove', onHudDragMove, true);
      window.removeEventListener('mouseup', onHudDragUp, true);
      cancelHudDrag();
    });

    hud.appendChild(header);
    hud.appendChild(body);
    return hud;
  }

  function trimLinkMatch(rawUrl) {
    let url = rawUrl;
    let trailing = '';
    while (url.length > 0 && /[),.;!?]+$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    return { url, trailing };
  }

  function appendLinkedText(container, text) {
    const pattern = /https?:\/\/[^\s]+/g;
    let lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const rawUrl = match[0];
      const start = match.index ?? 0;
      if (start > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, start)));
      }
      const { url, trailing } = trimLinkMatch(rawUrl);
      const anchor = el('a', {
        class: 'egd-codex-inline-link',
        href: url,
        title: url,
      }, url);
      anchor.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openUrlInBrowserCard(url);
      });
      container.appendChild(anchor);
      if (trailing) {
        container.appendChild(document.createTextNode(trailing));
      }
      lastIndex = start + rawUrl.length;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function openUrlInBrowserCard(url) {
    const card = spawnBrowserCard(url);
    setActiveEntity(card);
    return card;
  }


  function stripMarkdown(text) {
    if (!text) return '';
    return text.replace(/\*\*(.+?)\*\*/g, '$1')
               .replace(/__(.+?)__/g, '$1')
               .replace(/\*(.+?)\*/g, '$1')
               .replace(/_(.+?)_/g, '$1')
               .replace(/`(.+?)`/g, '$1')
               .replace(/```[\s\S]*?```/g, '[code]')
               .replace(/\n/g, ' ')
               .trim();
  }
  function appendRichText(container, text) {
    if (!text) return;
    // Split by code blocks first
    const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
    let lastIdx = 0;
    for (const m of text.matchAll(codeBlockRe)) {
      if (m.index > lastIdx) {
        appendInlineMarkdown(container, text.slice(lastIdx, m.index));
      }
      const lang = m[1] || '';
      const codeText = m[2].replace(/\n$/, '');
      const pre = el('pre', { class: 'egd-codex-code-block' });
      const codeEl = el('code', { class: lang ? `language-${lang}` : '' }, codeText);
      pre.appendChild(codeEl);
      container.appendChild(pre);
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) {
      appendInlineMarkdown(container, text.slice(lastIdx));
    }
  }
  function appendInlineMarkdown(container, text) {
    // Process inline markdown: **bold**, *italic*, `code`, links
    const inlineRe = /(\*\*(.+?)\*\*|__(.+?)__|`(.+?)`|\*(.+?)\*|_(.+?)_|https?:\/\/[^\s]+)/g;
    let lastIdx = 0;
    for (const m of text.matchAll(inlineRe)) {
      if (m.index > lastIdx) {
        // Plain text - split by newlines
        const plain = text.slice(lastIdx, m.index);
        appendPlainWithBreaks(container, plain);
      }
      if (m[2] || m[3]) {
        // **bold** or __bold__
        container.appendChild(el('strong', {}, m[2] || m[3]));
      } else if (m[4]) {
        // `code`
        container.appendChild(el('code', { class: 'egd-codex-inline-code' }, m[4]));
      } else if (m[5] || m[6]) {
        // *italic* or _italic_
        container.appendChild(el('em', {}, m[5] || m[6]));
      } else if (m[0].startsWith('http')) {
        // URL
        const { url, trailing } = trimLinkMatch(m[0]);
        const anchor = el('a', { class: 'egd-codex-inline-link', href: url, title: url }, url);
        anchor.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); openUrlInBrowserCard(url); });
        container.appendChild(anchor);
        if (trailing) container.appendChild(document.createTextNode(trailing));
      }
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) {
      appendPlainWithBreaks(container, text.slice(lastIdx));
    }
  }
  function appendPlainWithBreaks(container, text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) container.appendChild(document.createTextNode(lines[i]));
      if (i < lines.length - 1) container.appendChild(document.createElement('br'));
    }
  }
  function formatMessageTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, '0');
    const ampm = h < 12 ? '오전' : '오후';
    const h12 = h % 12 || 12;
    return `${ampm} ${h12}:${m}`;
  }
  function formatRelativeTime(ts) {
    if (!ts) return '';
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60000) return '방금';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}일 전`;
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function buildCodexVerificationUrl(status) {
    if (typeof status?.authUrl === 'string' && status.authUrl) {
      return status.authUrl;
    }
    const verificationUrl = typeof status?.verificationUrl === 'string' ? status.verificationUrl : '';
    const userCode = typeof status?.userCode === 'string' ? status.userCode : '';
    if (!verificationUrl) return '';
    if (!userCode) return verificationUrl;
    try {
      const url = new URL(verificationUrl);
      if (!url.searchParams.has('user_code')) {
        url.searchParams.set('user_code', userCode);
      }
      return url.toString();
    } catch {
      return verificationUrl;
    }
  }

  function getBrowserCardById(cardId) {
    if (!cardId) return null;
    const card = document.getElementById(cardId);
    if (!card || !card.classList.contains('egd-browser-card')) return null;
    return card;
  }

  function ensureCodexAuthBrowserCard(url, authSessionId) {
    const existing = getBrowserCardById(state.codex.authCardEntityId);
    if (existing) {
      existing.dataset.codexAuthSessionId = String(authSessionId);
      existing.dataset.codexRole = 'auth';
      try { existing._xulBrowser?.setAttribute('src', url); } catch (error) { console.warn(TAG, 'auth card src update failed', error); }
      existing.style.zIndex = String(++cardZ);
      setActiveEntity(existing);
      return existing;
    }

    const card = spawnBrowserCard(url);
    card.dataset.codexAuthSessionId = String(authSessionId);
    card.dataset.codexRole = 'auth';
    state.codex.authCardEntityId = card.id;
    setActiveEntity(card);
    return card;
  }

  function copyPlainText(text) {
    try {
      Cc['@mozilla.org/widget/clipboardhelper;1']
        .getService(Ci.nsIClipboardHelper)
        .copyString(text);
      return true;
    } catch (error) {
      console.warn(TAG, 'copy failed', error);
      return false;
    }
  }

  function codexAuthSummary(codex) {
    if (codex.authStatus.isLoggedIn) {
      return codex.authStatus.accountEmail
        ? `${codex.authStatus.accountEmail} 로그인됨`
        : codex.authStatus.statusText;
    }
    if (codex.isStartingLogin || codex.authStatus.loginInProgress) {
      return '로그인 중…';
    }
    return '로그아웃됨';
  }

  function codexBridgeSummary(codex) {
    if (!codex.connected) return '브리지 오프라인';
    if (codex.lastBridgeLatency != null) return `브리지 온라인 · ${codex.lastBridgeLatency}ms`;
    return '브리지 온라인';
  }

  function mountCodexHUD(body, codexBridge, options = {}) {
    let unsubscribe = null;
    const mode = options.mode || 'hud';
    const closeFloatingMenus = () => {
      codexBridge.closeMemberMenu();
      codexBridge.closeThreadMenu();
    };
    const onDocumentMouseDown = (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.egd-codex-thread-member-menu')) return;
      if (target.closest('.egd-codex-thread-member-clickable')) return;
      if (target.closest('.egd-codex-thread-menu')) return;
      if (target.closest('.egd-codex-thread-menu-trigger')) return;
      closeFloatingMenus();
    };
    const onViewportMutate = () => closeFloatingMenus();
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('wheel', onViewportMutate, { capture: true, passive: true });
    window.addEventListener('resize', onViewportMutate);

    const render = (codex) => {
      body.textContent = '';
      const explicitActiveThread = codex.activeThreadId
        ? getCodexThreadById(codex, codex.activeThreadId)
        : null;
      const activeThread = explicitActiveThread || codex.threads[0] || null;
      if (activeThread && codex.activeThreadId !== activeThread.id) {
        codex.activeThreadId = activeThread.id;
      }

      const hudView = mode === 'hud'
        ? ((normalizeHudView(codex.hudView) === 'conversation' && explicitActiveThread) ? 'conversation' : 'list')
        : 'split';
      const isHudListView = mode === 'hud' && hudView === 'list';
      const isHudConversationView = mode === 'hud' && hudView === 'conversation';

      const statusBridge = codex.error
        ? '오류 있음'
        : (codex.connected ? '연결됨' : '연결 대기');
      const statusAccount = codex.authStatus.isLoggedIn
        ? '로그인됨'
        : ((codex.isStartingLogin || codex.authStatus.loginInProgress) ? '로그인 중…' : '로그인 필요');
      const statusText = `${statusBridge} · ${statusAccount}`;
      const indicatorState = codex.error ? 'error' : (codex.connected ? 'ok' : 'idle');

      const chromeActions = [];
      if (!codex.authStatus.isLoggedIn) {
        chromeActions.push(el('button', {
          class: 'egd-codex-chip egd-codex-chip-primary',
          disabled: (codex.isStartingLogin || codex.authStatus.loginInProgress) ? 'true' : null,
          onclick: () => codexBridge.startLogin(),
        }, (codex.isStartingLogin || codex.authStatus.loginInProgress) ? '로그인 중…' : '로그인'));
      }
      if (codex.error || !codex.connected) {
        chromeActions.push(el('button', {
          class: 'egd-codex-chip egd-codex-chip-subtle',
          onclick: () => codexBridge.refreshAuthStatus(),
        }, '새로고침'));
      }
      if (mode === 'canvas' && typeof options.onMoveToHud === 'function') {
        chromeActions.push(el('button', {
          class: 'egd-codex-chip egd-codex-chip-subtle',
          onclick: () => options.onMoveToHud(),
        }, '우측 고정'));
      }

      const chromeRow = el('div', { class: 'egd-codex-chrome-row' },
        el('div', { class: 'egd-codex-chrome-main' },
          el('span', { class: `egd-codex-chrome-indicator egd-codex-chrome-indicator-${indicatorState}` }),
          el('div', { class: 'egd-codex-chrome-status' }, statusText),
        ),
        el('div', { class: 'egd-codex-chrome-actions' }, ...chromeActions),
      );

      const authCardNeeded = !codex.authStatus.isLoggedIn && (
        codex.isStartingLogin
        || codex.authStatus.loginInProgress
        || codex.authStatus.authUrl
        || codex.authStatus.verificationUrl
        || codex.authStatus.userCode
      );
      const authLaunchUrl = buildCodexVerificationUrl(codex.authStatus);
      const authUsesDeviceCode = codex.authStatus.loginMode === 'device' || (!codex.authStatus.authUrl && !!codex.authStatus.userCode);
      const authCard = authCardNeeded
        ? el('div', { class: 'egd-codex-auth-card' },
            el('div', { class: 'egd-codex-auth-title' }, '로그인이 필요합니다'),
            el('div', { class: 'egd-codex-auth-sub' },
              authUsesDeviceCode
                ? '인증 페이지를 연 뒤 디바이스 코드를 입력해 주세요.'
                : '전용 브라우저 카드에서 인증 페이지를 열어 로그인을 마무리해 주세요.',
            ),
            authLaunchUrl
              ? el('button', {
                  class: 'egd-codex-link-action',
                  onclick: () => ensureCodexAuthBrowserCard(
                    authLaunchUrl,
                    codex.authStatus.authSessionId ?? 'active'
                  ),
                }, authUsesDeviceCode ? '인증 창 열기' : '로그인 창 열기')
              : null,
            authUsesDeviceCode && codex.authStatus.userCode
              ? el('div', { class: 'egd-codex-auth-code-row' },
                  el('code', { class: 'egd-codex-auth-code' }, codex.authStatus.userCode),
                  el('button', {
                    class: 'egd-codex-chip',
                    onclick: () => copyPlainText(codex.authStatus.userCode),
                  }, '코드 복사'),
                )
              : null,
          )
        : null;

      const sortThreads = (threads) => threads.slice().sort((a, b) => {
        const pinOrder = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
        if (pinOrder !== 0) return pinOrder;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      const recentThreadsOnly = (threads) => threads.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const query = (codex.threadQuery || '').trim().toLowerCase();
      const matchedThreads = codex.threads.filter((thread) => codexThreadMatchesQuery(thread, query));
      const sortedMatchedThreads = sortThreads(matchedThreads);
      const recentThreads = recentThreadsOnly(matchedThreads);
      const pinnedThreads = sortedMatchedThreads.filter((thread) => thread.pinned);
      const unreadThreads = sortedMatchedThreads.filter((thread) => (thread.unreadCount || 0) > 0);
      const dmThreads = sortedMatchedThreads.filter((thread) => thread.type === 'dm');
      const groupThreads = sortedMatchedThreads.filter((thread) => thread.type === 'group');

      const threadRail = el('aside', {
        class: `egd-codex-thread-rail${mode === 'hud' ? ' egd-codex-thread-rail-hud' : ''}`,
      });
      const threadTop = el('div', {
        class: `egd-codex-thread-home-fixed${mode === 'hud' ? ' egd-codex-thread-home-fixed-hud' : ''}`,
      });

      if (mode === 'hud') {
        const unreadCountTotal = codex.threads.reduce((sum, thread) => sum + (thread.unreadCount || 0), 0);
        const recentCount = Math.min(recentThreads.length, 3);
        threadTop.appendChild(el('div', { class: 'egd-codex-thread-home-head' },
          el('div', { class: 'egd-codex-thread-home-title-row' },
            el('div', { class: 'egd-codex-thread-home-title' }, '채팅 홈'),
            el('button', {
              class: 'egd-codex-thread-home-new',
              title: '새 개인 채팅',
              onclick: () => codexBridge.createThread('dm', { openConversation: true }),
            }, '+'),
          ),
          el('div', { class: 'egd-codex-thread-home-sub' }, 'HUD 빠른 전환 · Canvas 집중 작업'),
          el('div', { class: 'egd-codex-thread-home-status' }, `${codexBridgeSummary(codex)} · ${codexAuthSummary(codex)}`),
          el('div', { class: 'egd-codex-thread-session-summary' },
            el('div', { class: 'egd-codex-thread-session-pill' }, `최근 작업 ${recentCount}`),
            el('div', { class: 'egd-codex-thread-session-pill' }, `읽지 않음 ${unreadCountTotal}`),
            el('div', { class: 'egd-codex-thread-session-pill' }, `고정 ${pinnedThreads.length}`),
          ),
        ));
      }

      const threadSearch = el('input', {
        type: 'text',
        class: 'egd-codex-thread-search',
        value: codex.threadQuery || '',
        placeholder: '대화방 찾기',
      });
      threadSearch.addEventListener('input', () => codexBridge.setThreadQuery(threadSearch.value));
      threadTop.appendChild(threadSearch);

      const threadFilter = normalizeThreadFilter(codex.threadFilter);
      const filterRow = el('div', { class: 'egd-codex-thread-filter-row' });
      const filterDefs = [
        { key: 'all', label: '전체' },
        { key: 'dm', label: '개인' },
        { key: 'group', label: '그룹' },
      ];
      for (const filterDef of filterDefs) {
        const selected = threadFilter === filterDef.key;
        filterRow.appendChild(el('button', {
          class: `egd-codex-thread-filter-chip${selected ? ' egd-codex-thread-filter-chip-active' : ''}`,
          onclick: () => codexBridge.setThreadFilter(filterDef.key),
          title: `${filterDef.label} 채팅방`,
        }, filterDef.label));
      }
      threadTop.appendChild(filterRow);
      threadRail.appendChild(threadTop);
      const typeScopedThreads = threadFilter === 'dm'
        ? dmThreads
        : (threadFilter === 'group' ? groupThreads : sortedMatchedThreads);
      const typeScopedRecent = recentThreadsOnly(typeScopedThreads);
      const typeScopedUnread = typeScopedThreads.filter((thread) => (thread.unreadCount || 0) > 0);
      const typeScopedPinned = typeScopedThreads.filter((thread) => thread.pinned);

      const renderThreadMenu = (thread) => el('div', {
        class: 'egd-codex-thread-menu',
        style: {
          left: `${Math.round(codex.threadMenu?.left ?? 12)}px`,
          top: `${Math.round(codex.threadMenu?.top ?? 12)}px`,
        },
        onclick: (ev) => ev.stopPropagation(),
      },
      el('button', {
        class: `egd-codex-thread-menu-item${thread.pinned ? ' egd-codex-thread-menu-item-active' : ''}`,
        onclick: () => codexBridge.toggleThreadPin(thread.id),
      }, thread.pinned ? '채팅방 고정 해제' : '채팅방 고정'),
      el('button', {
        class: 'egd-codex-thread-menu-item',
        onclick: () => codexBridge.renameThread(thread.id),
      }, '채팅방 이름 변경'),
      el('button', {
        class: 'egd-codex-thread-menu-item egd-codex-thread-menu-item-danger',
        onclick: () => codexBridge.deleteThread(thread.id),
      }, '채팅방 삭제'),
      el('button', {
        class: 'egd-codex-thread-menu-item',
        onclick: () => codexBridge.closeThreadMenu(),
      }, '닫기'),
      );

      const renderThreadSection = (label, threads, options = {}) => {
        const safeThreads = Array.isArray(threads) ? threads : [];
        const limitedThreads = Number.isInteger(options.limit) ? safeThreads.slice(0, Math.max(0, options.limit)) : safeThreads;
        const headChildren = [el('span', { class: 'egd-codex-thread-section-title' }, label)];
        if (options.allowCreate && options.type) {
          headChildren.push(el('button', {
            class: 'egd-codex-thread-add',
            title: options.type === 'group' ? '새 그룹 채팅' : '새 개인 채팅',
            onclick: () => codexBridge.createThread(options.type, { openConversation: mode === 'hud' }),
          }, '+'));
        }
        const section = el('div', { class: 'egd-codex-thread-section' },
          el('div', { class: 'egd-codex-thread-section-head' }, ...headChildren),
        );
        if (limitedThreads.length === 0) {
          if (!options.renderWhenEmpty) return null;
          section.appendChild(el('div', { class: 'egd-codex-thread-empty' }, query ? '검색 결과가 없습니다' : (options.emptyText || '채팅방이 없습니다')));
          return section;
        }
        for (const thread of limitedThreads) {
          const threadMenuOpen = Boolean(codex.threadMenu && codex.threadMenu.threadId === thread.id);
          const item = el('div', {
            class: `egd-codex-thread-item${activeThread && thread.id === activeThread.id ? ' egd-codex-thread-item-active' : ''}${threadMenuOpen ? ' egd-codex-thread-item-menu-open' : ''}`,
          });
          item.addEventListener('click', () => codexBridge.selectThread(thread.id, { openConversation: mode === 'hud' }));
          const lastMsg = thread.messages && thread.messages.length > 0 ? thread.messages[thread.messages.length - 1] : null;
          const lastTime = lastMsg && lastMsg.createdAt ? formatRelativeTime(lastMsg.createdAt) : '';
          const avatarInitial = (thread.title || '?')[0].toUpperCase();
          const avatarColors = ['#2D5A7B','#7B2D5A','#5A7B2D','#2D7B5A','#7B5A2D','#5A2D7B','#3D6B8B','#8B3D6B'];
          const avatarColor = avatarColors[Math.abs(thread.id.split('').reduce((a,c) => a + c.charCodeAt(0), 0)) % avatarColors.length];
          item.append(
            el('div', { class: 'egd-codex-thread-item-row' },
              el('div', { class: 'egd-codex-thread-avatar', style: { background: avatarColor } }, avatarInitial),
              el('div', { class: 'egd-codex-thread-item-body' },
                el('div', { class: 'egd-codex-thread-item-top' },
                  el('div', { class: 'egd-codex-thread-title' }, thread.title),
                  el('div', { class: 'egd-codex-thread-time' }, lastTime),
                ),
                el('div', { class: 'egd-codex-thread-item-bottom' },
                  el('div', { class: 'egd-codex-thread-preview' }, stripMarkdown(codexThreadPreview(thread))),
                  el('div', { class: 'egd-codex-thread-item-actions' },
                    thread.unreadCount > 0
                      ? el('span', { class: 'egd-codex-thread-unread' }, String(thread.unreadCount))
                      : null,
                    el('button', {
                      class: `egd-codex-thread-menu-trigger${threadMenuOpen ? ' egd-codex-thread-menu-trigger-active' : ''}`,
                      title: '채팅방 메뉴',
                      onclick: (ev) => {
                        ev.stopPropagation();
                        codexBridge.toggleThreadMenu(thread.id, ev.currentTarget);
                      },
                    }, '⋯'),
                  ),
                ),
              ),
            ),
          );
          if (threadMenuOpen) {
            item.appendChild(renderThreadMenu(thread));
          }
          section.appendChild(item);
        }
        return section;
      };

      if (mode === 'hud') {
        const summarySection = renderThreadSection('최근 작업', typeScopedRecent, {
          limit: 4,
          renderWhenEmpty: true,
          emptyText: '최근 작업 세션이 없습니다',
        });
        if (summarySection) threadRail.appendChild(summarySection);
        const unreadSection = renderThreadSection('읽지 않음', typeScopedUnread, {
          limit: 4,
          renderWhenEmpty: false,
        });
        if (unreadSection) threadRail.appendChild(unreadSection);
        const pinnedSection = renderThreadSection('고정', typeScopedPinned, {
          limit: 4,
          renderWhenEmpty: false,
        });
        if (pinnedSection) threadRail.appendChild(pinnedSection);
      }

      const allSection = renderThreadSection('전체', typeScopedThreads, {
        renderWhenEmpty: true,
        emptyText: '조건에 맞는 채팅방이 없습니다',
      });
      if (allSection) threadRail.appendChild(allSection);

      const hasConversation = Boolean(activeThread && activeThread.messages.length > 0);
      const showConversation = Boolean(activeThread);
      const conversation = showConversation ? el('div', { class: 'egd-codex-conversation-pane' }) : null;
      if (conversation && activeThread) {
        if (mode === 'hud') {
          const threadMenuOpen = Boolean(codex.threadMenu && codex.threadMenu.threadId === activeThread.id);
          const titleSubtitle = activeThread.subtitle || (activeThread.type === 'group' ? '그룹 채팅' : '개인 채팅');
          conversation.appendChild(el('div', { class: 'egd-codex-conversation-hud-head' },
            el('button', {
              class: 'egd-codex-conversation-back',
              title: '목록 홈으로',
              onclick: () => codexBridge.setHudView('list'),
            }, '←'),
            el('div', { class: 'egd-codex-conversation-hud-center' },
              el('div', { class: 'egd-codex-conversation-hud-title' }, activeThread.title),
              el('div', { class: 'egd-codex-conversation-hud-sub' }, titleSubtitle),
            ),
            el('button', {
              class: `egd-codex-conversation-menu-trigger${threadMenuOpen ? ' egd-codex-conversation-menu-trigger-active' : ''}`,
              title: '채팅방 메뉴',
              onclick: (ev) => {
                ev.stopPropagation();
                codexBridge.toggleThreadMenu(activeThread.id, ev.currentTarget);
              },
            }, '⋯'),
          ));
          if (threadMenuOpen) {
            conversation.appendChild(renderThreadMenu(activeThread));
          }
        } else {
          const memberRow = activeThread.type === 'group' ? el('div', { class: 'egd-codex-thread-members' }) : null;
          for (const member of (activeThread.participants || []).slice(0, 4)) {
            if (!memberRow) break;
            const role = codexThreadRole(activeThread, member);
            const canManageMember = activeThread.type === 'group' && member !== SELF_MEMBER;
            const menuOpen = Boolean(
              canManageMember
              && codex.memberMenu
              && codex.memberMenu.threadId === activeThread.id
              && codex.memberMenu.memberName === member
            );
            const chip = el('button', {
              class: `egd-codex-thread-member${canManageMember ? ' egd-codex-thread-member-clickable' : ''}${menuOpen ? ' egd-codex-thread-member-menu-open' : ''}`,
              title: canManageMember ? '멤버 관리' : '멤버',
            },
            el('span', { class: 'egd-codex-thread-member-name' }, member),
            canManageMember
              ? el('span', { class: 'egd-codex-thread-member-role' }, codexRoleLabel(role))
              : el('span', { class: 'egd-codex-thread-member-role-static' }, codexRoleLabel(role)),
            canManageMember ? el('span', { class: 'egd-codex-thread-member-caret' }, '▾') : null,
            );
            chip.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (!canManageMember) return;
              codexBridge.toggleMemberMenu(activeThread.id, member, ev.currentTarget);
            });
            if (menuOpen) {
              chip.appendChild(el('div', {
                class: 'egd-codex-thread-member-menu',
                style: {
                  left: `${Math.round(codex.memberMenu?.left ?? 12)}px`,
                  top: `${Math.round(codex.memberMenu?.top ?? 12)}px`,
                },
                onclick: (ev) => ev.stopPropagation(),
              },
              el('button', {
                class: `egd-codex-thread-member-menu-item${role === 'admin' ? ' egd-codex-thread-member-menu-item-active' : ''}`,
                onclick: () => codexBridge.setThreadMemberRole(activeThread.id, member, 'admin'),
              }, role === 'admin' ? '관리자 ✓' : '관리자로 변경'),
              el('button', {
                class: `egd-codex-thread-member-menu-item${role === 'member' ? ' egd-codex-thread-member-menu-item-active' : ''}`,
                onclick: () => codexBridge.setThreadMemberRole(activeThread.id, member, 'member'),
              }, role === 'member' ? '멤버 ✓' : '멤버로 변경'),
              el('button', {
                class: 'egd-codex-thread-member-menu-item egd-codex-thread-member-menu-item-danger',
                onclick: () => codexBridge.removeFromThread(activeThread.id, member),
              }, '그룹에서 제거'),
              el('button', {
                class: 'egd-codex-thread-member-menu-item',
                onclick: () => codexBridge.closeMemberMenu(),
              }, '닫기'),
              ));
            }
            memberRow.appendChild(chip);
          }
          if (memberRow && (activeThread.participants || []).length > 4) {
            memberRow.appendChild(el('span', { class: 'egd-codex-thread-member egd-codex-thread-member-more' }, `+${activeThread.participants.length - 4}`));
          }
          const memberActions = activeThread.type === 'group'
            ? el('button', {
                class: 'egd-codex-chip egd-codex-chip-subtle egd-codex-thread-members-action',
                onclick: () => codexBridge.inviteToThread(activeThread.id),
              }, '초대')
            : null;
          const memberRowWrap = memberRow
            ? el('div', { class: 'egd-codex-thread-members-row' }, memberRow, memberActions)
            : null;
          conversation.appendChild(el('div', { class: 'egd-codex-thread-active-head' },
            el('div', { class: 'egd-codex-thread-active-title' }, activeThread.title),
            memberRowWrap,
          ));
        }

        const messages = el('div', { class: 'egd-codex-messages' });
        if (!hasConversation) {
          messages.appendChild(el('div', { class: 'egd-codex-empty-state' },
            el('div', { class: 'egd-codex-empty-title' }, codex.authStatus.isLoggedIn ? '대화를 시작할 수 있습니다' : '로그인 후 대화를 시작해 주세요'),
            el('div', { class: 'egd-codex-empty-sub' },
              codex.authStatus.isLoggedIn
                ? '아래 입력창에서 새 코덱스 대화를 시작해 보세요.'
                : '먼저 브라우저 카드에서 로그인한 뒤 이곳으로 돌아와 메시지를 보내세요.',
            ),
          ));
        } else {
          for (const message of activeThread.messages) {
            const content = el('div', { class: 'egd-codex-bubble-content egd-codex-richtext' });
            appendRichText(content, message.content || (message.status === 'streaming' ? '…' : ''));
            const bubble = el('div', {
              class: `egd-codex-bubble egd-codex-bubble-${message.role}${message.status === 'error' ? ' egd-codex-bubble-error' : ''}`,
            },
            el('div', { class: 'egd-codex-bubble-role' }, codexMessageRoleLabel(message.role)),
            content,
            );
            if (message.role === 'user') {
              { const _rm = codexReadMeta(message, activeThread); if (_rm) bubble.appendChild(_rm); }
            if (message.createdAt) {
              bubble.appendChild(el('div', { class: 'egd-codex-bubble-time' }, formatMessageTime(message.createdAt)));
            }
            }
            if (message.status === 'streaming' && message.role === 'assistant') {
              bubble.appendChild(el('div', { class: 'egd-codex-streaming' }, el('div', { class: 'egd-codex-typing-dots' }, el('span'), el('span'), el('span')), '코덱스가 입력 중'));
            }
            if (message.role === 'assistant' && message.createdAt && message.status !== 'streaming') {
              bubble.appendChild(el('div', { class: 'egd-codex-bubble-time' }, formatMessageTime(message.createdAt)));
            }
            messages.appendChild(el('div', {
              class: `egd-codex-message-row egd-codex-message-row-${message.role || 'assistant'}`,
            }, bubble));
          }
        }
        conversation.appendChild(messages);
      }

      const hasDiagnostics = mode === 'hud' && hudView === 'conversation'
        ? Boolean(codex.error)
        : Boolean(codex.error || codex.loginLog);
      const diagnostics = hasDiagnostics ? el('div', { class: 'egd-codex-diagnostics-shell' }) : null;
      if (diagnostics) {
        const diagnosticsHeader = el('button', {
          class: 'egd-codex-diagnostics-toggle',
          onclick: () => {
            state.codex.showDiagnostics = !state.codex.showDiagnostics;
            render(state.codex);
          },
        }, state.codex.showDiagnostics ? '상태 접기' : '상태 보기');
        const diagnosticsHead = el('div', { class: 'egd-codex-diagnostics-head' }, diagnosticsHeader);
        diagnostics.appendChild(diagnosticsHead);

        if (state.codex.showDiagnostics) {
          const diagnosticsBody = el('div', { class: 'egd-codex-diagnostics' });
          const diagnosticsActions = [];
          if (codex.error || !codex.connected) {
            diagnosticsActions.push(el('button', {
              class: 'egd-codex-chip egd-codex-chip-subtle',
              onclick: () => codexBridge.refreshAuthStatus(),
            }, '상태 새로고침'));
          }
          if (codex.authStatus.isLoggedIn) {
            diagnosticsActions.push(el('button', {
              class: 'egd-codex-chip egd-codex-chip-subtle',
              onclick: () => codexBridge.signOut(),
            }, '로그아웃'));
          }
          if (diagnosticsActions.length > 0) {
            diagnosticsHead.appendChild(el('div', { class: 'egd-codex-diagnostics-actions' }, ...diagnosticsActions));
          }
          if (codex.error) {
            const errorBlock = el('div', { class: 'egd-codex-error egd-codex-richtext' });
            appendLinkedText(errorBlock, codex.error);
            diagnosticsBody.appendChild(errorBlock);
          }
          if (codex.loginLog && (mode !== 'hud' || hudView === 'list')) {
            const logBlock = el('pre', { class: 'egd-codex-log egd-codex-richtext' });
            appendLinkedText(logBlock, codex.loginLog);
            diagnosticsBody.appendChild(logBlock);
          }
          if (codex.authStatus.authMode) {
            diagnosticsBody.appendChild(el('div', { class: 'egd-codex-meta' }, `인증 모드 ${codex.authStatus.authMode}`));
          }
          if (activeThread?.conversationId) {
            diagnosticsBody.appendChild(el('div', { class: 'egd-codex-meta' }, `대화 ID ${activeThread.conversationId}`));
          }
          diagnostics.appendChild(diagnosticsBody);
        }
      }

      const allowComposer = Boolean(codex.authStatus.isLoggedIn && activeThread && (mode === 'canvas' || isHudConversationView));
      const footer = allowComposer
        ? (() => {
            const input = el('input', {
              type: 'text',
              class: 'egd-codex-input',
              value: getCodexThreadDraft(codex, activeThread.id),
              placeholder: `${activeThread.title}에 메시지 보내기…`,
              disabled: codex.isSending ? 'true' : null,
            });
            input.addEventListener('input', () => codexBridge.setDraft(input.value, activeThread.id));
            input.addEventListener('keydown', (ev) => {
              if (ev.key !== 'Enter') return;
              ev.preventDefault();
              void codexBridge.sendMessage();
            });
            return el('div', { class: 'egd-codex-footer' },
              el('div', { class: 'egd-codex-input-row' },
                input,
                el('button', {
                  class: 'egd-codex-send',
                  disabled: codex.isSending ? 'true' : null,
                  onclick: () => codexBridge.sendMessage(),
                }, codex.isSending ? '…' : '보내기'),
              ),
              el('div', { class: 'egd-codex-input-hint' }, '엔터로 전송'),
            );
          })()
        : null;

      const shellClasses = [
        'egd-codex-chat-shell',
        mode === 'canvas' ? 'egd-codex-chat-shell-canvas' : 'egd-codex-chat-shell-hud',
        mode === 'hud' ? `egd-codex-hud-view-${hudView}` : 'egd-codex-hud-view-split',
      ].join(' ');
      const contentChildren = [];
      if (mode === 'canvas') {
        const mainPane = el('div', { class: 'egd-codex-chat-main' },
          chromeRow,
          authCard || null,
          conversation || null,
          diagnostics || null,
          footer || null,
        );
        contentChildren.push(threadRail);
        contentChildren.push(mainPane);
      } else if (isHudListView) {
        const mainPane = el('div', { class: 'egd-codex-chat-main egd-codex-chat-main-list' },
          chromeRow,
          authCard || null,
          threadRail,
          diagnostics || null,
        );
        contentChildren.push(mainPane);
      } else {
        const mainPane = el('div', { class: 'egd-codex-chat-main egd-codex-chat-main-conversation' },
          authCard || null,
          conversation || null,
          diagnostics || null,
          footer || null,
        );
        contentChildren.push(mainPane);
      }
      body.appendChild(el('div', { class: shellClasses }, ...contentChildren));
      const msgEl = body.querySelector(".egd-codex-messages");
      if (msgEl) requestAnimationFrame(() => { msgEl.scrollTop = msgEl.scrollHeight; });
      // Auto-scroll messages to bottom
    };

    unsubscribe = codexBridge.subscribe(render)
    body._codexCleanup = () => {
      unsubscribe?.();
      document.removeEventListener('mousedown', onDocumentMouseDown, true);
      document.removeEventListener('wheel', onViewportMutate, true);
      window.removeEventListener('resize', onViewportMutate);
    }
  }

  function installNativeGestureHelperBridge() {
    const status = el('div', { id: 'egd-input-helper-status' }, '헬퍼: 꺼짐');
    document.documentElement.appendChild(status);

    let source = null;
    let retryTimer = null;
    let lastLatency = null;

    const updateStatus = (text, mode = 'off') => {
      status.textContent = text;
      status.dataset.mode = mode;
    };

    const scheduleReconnect = () => {
      if (retryTimer) return;
      updateStatus('헬퍼: 재연결 중', 'off');
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        connect();
      }, 1200);
    };

    const connect = () => {
      try {
        source = new EventSource('http://127.0.0.1:39217/events');
      } catch (error) {
        console.warn(TAG, 'helper EventSource init failed', error);
        scheduleReconnect();
        return;
      }

      source.addEventListener('ready', () => {
        updateStatus(lastLatency == null ? '헬퍼: 켜짐' : `헬퍼: ${lastLatency}ms`, 'on');
      });

      source.addEventListener('gesture', (event) => {
        try {
          const payload = JSON.parse(event.data);
          lastLatency = Math.max(0, Date.now() - payload.tsMs);
          updateStatus(`헬퍼 ${payload.kind.replace('gestureScroll', '')}: ${lastLatency}ms`, 'on');
          if (typeof state.nativeGestureHook === 'function') {
            state.nativeGestureHook(payload);
          }
        } catch (error) {
          console.warn(TAG, 'helper payload parse failed', error);
        }
      });

      source.onerror = () => {
        try { source?.close(); } catch {}
        source = null;
        scheduleReconnect();
      };
    };

    connect();
  }

  function createCodexMessage(role, content, status = 'complete', options = {}) {
    const readBy = Array.isArray(options.readBy) ? options.readBy : (role === 'user' ? [SELF_MEMBER] : []);
    return {
      id: `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      content,
      status,
      readBy,
      createdAt: Date.now(),
    };
  }

  function installCodexBridge() {
    const listeners = new Set();
    let source = null;
    let reconnectTimer = null;

    const normalizeThreads = () => {
      if (!Array.isArray(state.codex.threads) || state.codex.threads.length === 0) {
        state.codex.threads = defaultCodexThreads();
      }
      if (typeof state.codex.threadQuery !== 'string') {
        state.codex.threadQuery = '';
      }
      if (!state.codex.threadDrafts || typeof state.codex.threadDrafts !== 'object') {
        state.codex.threadDrafts = {};
      }
      if (!state.codex.memberMenu || typeof state.codex.memberMenu !== 'object') {
        state.codex.memberMenu = null;
      }
      if (!state.codex.threadMenu || typeof state.codex.threadMenu !== 'object') {
        state.codex.threadMenu = null;
      }
      state.codex.hudView = normalizeHudView(state.codex.hudView);
      state.codex.threads = state.codex.threads.map((thread) => {
        const participants = uniqueNames(thread.participants || []);
        const participantRoles = { ...(thread.participantRoles || {}) };
        for (const member of participants) {
          if (!participantRoles[member]) {
            participantRoles[member] = member === SELF_MEMBER ? 'owner' : 'member';
          }
        }
        return {
          ...thread,
          participants,
          participantRoles,
          pinned: Boolean(thread.pinned),
        };
      });
      if (!state.codex.activeThreadId || !getCodexThreadById(state.codex, state.codex.activeThreadId)) {
        state.codex.activeThreadId = state.codex.threads[0]?.id || null;
      }
      const validThreadIds = new Set(state.codex.threads.map((thread) => thread.id));
      state.codex.threadDrafts = Object.fromEntries(
        Object.entries(state.codex.threadDrafts).filter(([threadId]) => validThreadIds.has(threadId))
      );
      if (state.codex.memberMenu) {
        const menuThread = getCodexThreadById(state.codex, state.codex.memberMenu.threadId);
        if (!menuThread || !(menuThread.participants || []).includes(state.codex.memberMenu.memberName)) {
          state.codex.memberMenu = null;
        }
      }
      if (state.codex.threadMenu) {
        const menuThread = getCodexThreadById(state.codex, state.codex.threadMenu.threadId);
        if (!menuThread) {
          state.codex.threadMenu = null;
        }
      }
      const active = getActiveCodexThread(state.codex);
      state.codex.conversationId = active?.conversationId || null;
      state.codex.draft = getCodexThreadDraft(state.codex, active?.id || null);
    };

    const emit = () => {
      normalizeThreads();
      for (const listener of listeners) {
        try { listener(state.codex); } catch (error) { console.warn(TAG, 'codex listener failed', error); }
      }
    };
    const update = (patch) => {
      Object.assign(state.codex, patch);
      emit();
    };

    const findThreadIndexById = (threadId) => state.codex.threads.findIndex((thread) => thread.id === threadId);
    const findThreadIndexByConversationId = (conversationId) => {
      if (!conversationId) return -1;
      return state.codex.threads.findIndex((thread) => thread.conversationId === conversationId);
    };
    const pickAutoReader = (thread) => {
      if (!thread) return '코덱스 어시스턴트';
      const others = (thread.participants || []).filter((name) => name !== SELF_MEMBER);
      return others[0] || '코덱스 어시스턴트';
    };
    const markUserMessagesReadBy = (threadId, readerName) => {
      const safeReader = readerName || '코덱스 어시스턴트';
      updateThreadById(threadId, (thread) => ({
        ...thread,
        messages: thread.messages.map((message) => {
          if (message.role !== 'user') return message;
          const readBy = Array.isArray(message.readBy) ? message.readBy : [SELF_MEMBER];
          if (readBy.includes(safeReader)) return message;
          return { ...message, readBy: [...readBy, safeReader] };
        }),
      }));
    };
    const markThreadRead = (threadId) => {
      updateThreadById(threadId, (thread) => ({
        ...thread,
        unreadCount: 0,
      }));
    };
    const setActiveThread = (threadId) => {
      const index = findThreadIndexById(threadId);
      if (index < 0) return false;
      state.codex.activeThreadId = threadId;
      state.codex.threads[index] = {
        ...state.codex.threads[index],
        unreadCount: 0,
        updatedAt: Date.now(),
      };
      state.codex.conversationId = state.codex.threads[index].conversationId || null;
      markThreadRead(threadId);
      return true;
    };
    const updateThreadById = (threadId, updater) => {
      const index = findThreadIndexById(threadId);
      if (index < 0) return null;
      const current = state.codex.threads[index];
      const next = { ...updater(current), updatedAt: Date.now() };
      state.codex.threads = [
        ...state.codex.threads.slice(0, index),
        next,
        ...state.codex.threads.slice(index + 1),
      ];
      if (threadId === state.codex.activeThreadId) {
        state.codex.conversationId = next.conversationId || null;
      }
      return next;
    };
    const appendMessageToThread = (threadId, message, { countUnread = false } = {}) => {
      return updateThreadById(threadId, (thread) => ({
        ...thread,
        unreadCount: countUnread && thread.id !== state.codex.activeThreadId
          ? thread.unreadCount + 1
          : thread.unreadCount,
        messages: [...thread.messages, message],
      }));
    };
    const patchMessageInThread = (threadId, messageId, updater) => {
      return updateThreadById(threadId, (thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId ? updater(message) : message
        ),
      }));
    };
    const bindMessageToThread = (messageId, threadId) => {
      if (!messageId || !threadId) return;
      state.codex.messageThreadMap = {
        ...state.codex.messageThreadMap,
        [messageId]: threadId,
      };
    };
    const resolveThreadId = ({ conversationId = null, messageId = null } = {}) => {
      if (messageId && state.codex.messageThreadMap[messageId]) {
        return state.codex.messageThreadMap[messageId];
      }
      const byConversationIndex = findThreadIndexByConversationId(conversationId);
      if (byConversationIndex >= 0) {
        return state.codex.threads[byConversationIndex].id;
      }
      if (state.codex.pendingThreadId && findThreadIndexById(state.codex.pendingThreadId) >= 0) {
        return state.codex.pendingThreadId;
      }
      const active = getActiveCodexThread(state.codex);
      return active?.id || null;
    };
    const setThreadConversationId = (threadId, conversationId) => {
      if (!threadId || !conversationId) return;
      updateThreadById(threadId, (thread) => ({ ...thread, conversationId }));
    };
    const handleAssistantStart = (details) => {
      const threadId = resolveThreadId({
        conversationId: details.conversationId || null,
        messageId: details.messageId || null,
      });
      if (!threadId) return;
      if (details.conversationId) {
        setThreadConversationId(threadId, details.conversationId);
      }
      const messageId = details.messageId || createCodexMessage('assistant', '', 'streaming').id;
      appendMessageToThread(threadId, {
        id: messageId,
        role: details.role || 'assistant',
        content: '',
        status: details.status || 'streaming',
        readBy: [],
        createdAt: Date.now(),
      }, { countUnread: true });
      bindMessageToThread(messageId, threadId);
      const thread = getCodexThreadById(state.codex, threadId);
      markUserMessagesReadBy(threadId, pickAutoReader(thread));
      state.codex.pendingThreadId = threadId;
      emit();
    };
    const handleAssistantDelta = (details) => {
      const threadId = resolveThreadId({
        conversationId: details.conversationId || null,
        messageId: details.messageId || null,
      });
      if (!threadId || !details.messageId) return;
      patchMessageInThread(threadId, details.messageId, (message) => ({
        ...message,
        content: `${message.content}${details.delta || ''}`,
      }));
      emit();
    };
    const handleAssistantComplete = (details) => {
      const threadId = resolveThreadId({
        conversationId: details.conversationId || null,
        messageId: details.messageId || null,
      });
      if (!threadId || !details.messageId) return;
      patchMessageInThread(threadId, details.messageId, (message) => ({ ...message, status: 'complete' }));
      if (state.codex.pendingThreadId === threadId) {
        state.codex.pendingThreadId = null;
      }
      if (threadId === state.codex.activeThreadId) {
        markThreadRead(threadId);
      }
      state.codex.isSending = false;
      emit();
    };
    const handleAssistantError = (details) => {
      const threadId = resolveThreadId({
        conversationId: details.conversationId || null,
        messageId: details.messageId || null,
      });
      if (threadId && details.messageId) {
        patchMessageInThread(threadId, details.messageId, (message) => ({
          ...message,
          content: details.error || message.content,
          status: 'error',
        }));
      }
      if (state.codex.pendingThreadId === threadId) {
        state.codex.pendingThreadId = null;
      }
      state.codex.isSending = false;
      state.codex.error = details.error || '응답 생성에 실패했습니다.';
      emit();
    };
    const resetThreadConversations = () => {
      state.codex.threads = state.codex.threads.map((thread) => ({
        ...thread,
        conversationId: null,
        messages: [],
        unreadCount: 0,
        updatedAt: Date.now(),
      }));
      state.codex.pendingThreadId = null;
      state.codex.messageThreadMap = {};
      state.codex.memberMenu = null;
      state.codex.threadMenu = null;
      normalizeThreads();
    };

    const fetchJson = async (path, options = {}) => {
      const response = await fetch(`http://127.0.0.1:39218${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `${response.status} ${response.statusText}`);
      }
      return response.json();
    };

    const scheduleReconnect = () => {
      if (reconnectTimer) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1200);
    };

    const handleEvent = (event) => {
      switch (event.type) {
        case 'auth.status': {
          const status = event.status || state.codex.authStatus;
          if (
            status?.loginInProgress &&
            buildCodexVerificationUrl(status) &&
            status?.authSessionId
          ) {
            ensureCodexAuthBrowserCard(buildCodexVerificationUrl(status), status.authSessionId);
          }
          update({
            provider: event.provider || state.codex.provider,
            protocolVersion: Number(event.v || state.codex.protocolVersion || 0),
            authStatus: status,
            isStartingLogin: Boolean(status.loginInProgress),
          });
          return;
        }
        case 'auth.lifecycle':
          if (event.phase === 'started') {
            update({ isStartingLogin: true, error: null });
            return;
          }
          if (event.phase === 'finished') {
            const success = Boolean(event.details?.success);
            const errorText = event.details?.error || null;
            update({
              isStartingLogin: false,
              authStatus: event.status || state.codex.authStatus,
              error: success ? null : (errorText || '로그인이 완료되지 않았습니다.'),
            });
            return;
          }
          if (event.phase === 'failed') {
            update({
              isStartingLogin: false,
              error: event.details?.error || '로그인 요청에 실패했습니다.',
            });
            return;
          }
          return;
        case 'chat.event': {
          const details = event.details || {};
          if (event.event === 'assistant_start') {
            handleAssistantStart(details);
            return;
          }
          if (event.event === 'assistant_delta') {
            handleAssistantDelta(details);
            return;
          }
          if (event.event === 'assistant_complete') {
            handleAssistantComplete(details);
            return;
          }
          if (event.event === 'assistant_error') {
            handleAssistantError(details);
            return;
          }
          return;
        }
        case 'auth-status':
          if (
            event.status?.loginInProgress &&
            buildCodexVerificationUrl(event.status) &&
            event.status?.authSessionId
          ) {
            ensureCodexAuthBrowserCard(buildCodexVerificationUrl(event.status), event.status.authSessionId);
          }
          update({ authStatus: event.status, isStartingLogin: Boolean(event.status.loginInProgress) });
          return;
        case 'login-started':
          update({ isStartingLogin: true, loginLog: '', error: null });
          return;
        case 'login-output':
          update({ loginLog: `${state.codex.loginLog}${event.chunk}` });
          return;
        case 'login-finished':
          update({
            isStartingLogin: Boolean(event.status.loginInProgress),
            authStatus: event.status,
            error: event.success ? null : '코덱스 로그인이 완료되지 않았습니다. 아래 인증 로그를 확인해 주세요.',
          });
          return;
        case 'assistant-start':
          handleAssistantStart({
            conversationId: event.conversationId || null,
            messageId: event.message?.id || null,
            role: event.message?.role || 'assistant',
            status: event.message?.status || 'streaming',
          });
          if (event.message?.content) {
            handleAssistantDelta({
              conversationId: event.conversationId || null,
              messageId: event.message.id,
              delta: event.message.content,
            });
          }
          return;
        case 'assistant-delta':
          handleAssistantDelta({
            conversationId: event.conversationId || null,
            messageId: event.messageId,
            delta: event.delta,
          });
          return;
        case 'assistant-complete':
          handleAssistantComplete({
            conversationId: event.conversationId || null,
            messageId: event.messageId,
          });
          return;
        case 'assistant-error':
          handleAssistantError({
            conversationId: event.conversationId || null,
            messageId: event.messageId,
            error: event.error,
          });
          return;
      }
    };

    const connect = async () => {
      try {
        const bridgeState = await fetchJson('/v1/state');
        const status = bridgeState?.auth || state.codex.authStatus;
        if (
          status?.loginInProgress &&
          buildCodexVerificationUrl(status) &&
          status?.authSessionId
        ) {
          ensureCodexAuthBrowserCard(buildCodexVerificationUrl(status), status.authSessionId);
        }
        update({
          provider: bridgeState?.provider || state.codex.provider,
          protocolVersion: Number(bridgeState?.protocolVersion || 0),
          authStatus: status,
          isStartingLogin: Boolean(status.loginInProgress),
          connected: true,
          error: null,
        });
      } catch (error) {
        try {
          const status = await fetchJson('/auth/status');
          update({ authStatus: status, isStartingLogin: Boolean(status.loginInProgress), connected: true, error: null });
        } catch (fallbackError) {
          update({ connected: false, error: `코덱스 브리지에 연결할 수 없습니다: ${fallbackError.message}` });
          scheduleReconnect();
        }
      }

      try {
        source = new EventSource('http://127.0.0.1:39218/events');
      } catch (error) {
        scheduleReconnect();
        return;
      }

      source.addEventListener('ready', () => {
        update({ connected: true });
      });

      source.addEventListener('codex', (message) => {
        try {
          handleEvent(JSON.parse(message.data));
        } catch (error) {
          console.warn(TAG, 'codex event parse failed', error);
        }
      });

      source.onerror = () => {
        try { source?.close(); } catch {}
        source = null;
        update({ connected: false });
        scheduleReconnect();
      };
    };

    connect();

    return {
      subscribe(listener) {
        listeners.add(listener);
        normalizeThreads();
        listener(state.codex);
        return () => listeners.delete(listener);
      },
      setDraft(draft, threadId = state.codex.activeThreadId) {
        const value = typeof draft === 'string' ? draft : '';
        if (!threadId) {
          state.codex.draft = value;
          return;
        }
        state.codex.threadDrafts = {
          ...(state.codex.threadDrafts || {}),
          [threadId]: value,
        };
        if (threadId === state.codex.activeThreadId) {
          state.codex.draft = value;
        }
      },
      setThreadQuery(query) {
        state.codex.threadQuery = typeof query === 'string' ? query : '';
        emit();
      },
      setThreadFilter(filter) {
        state.codex.threadFilter = normalizeThreadFilter(filter);
        emit();
      },
      setHudView(view) {
        state.codex.hudView = normalizeHudView(view);
        if (state.codex.hudView === 'list') {
          state.codex.threadMenu = null;
          state.codex.memberMenu = null;
        }
        emit();
      },
      openHudHome() {
        state.codex.hudView = 'list';
        state.codex.threadMenu = null;
        state.codex.memberMenu = null;
        emit();
      },
      toggleThreadMenu(threadId, anchorEl = null) {
        if (!threadId) return;
        const alreadyOpen = state.codex.threadMenu && state.codex.threadMenu.threadId === threadId;
        if (alreadyOpen) {
          state.codex.threadMenu = null;
        } else {
          const rect = anchorEl?.getBoundingClientRect?.();
          const placement = rect
            ? resolveFloatingMenuPlacement(rect, 152, 146)
            : { left: 12, top: 12 };
          state.codex.threadMenu = { threadId, ...placement };
        }
        if (!alreadyOpen) state.codex.memberMenu = null;
        emit();
      },
      closeThreadMenu() {
        if (!state.codex.threadMenu) return;
        state.codex.threadMenu = null;
        emit();
      },
      toggleMemberMenu(threadId, memberName, anchorEl = null) {
        if (!threadId || !memberName) return;
        const alreadyOpen = state.codex.memberMenu
          && state.codex.memberMenu.threadId === threadId
          && state.codex.memberMenu.memberName === memberName;
        if (alreadyOpen) {
          state.codex.memberMenu = null;
        } else {
          const rect = anchorEl?.getBoundingClientRect?.();
          const placement = rect
            ? resolveFloatingMenuPlacement(rect, 152, 160)
            : { left: 12, top: 12 };
          state.codex.memberMenu = { threadId, memberName, ...placement };
        }
        if (!alreadyOpen) state.codex.threadMenu = null;
        emit();
      },
      closeMemberMenu() {
        if (!state.codex.memberMenu) return;
        state.codex.memberMenu = null;
        emit();
      },
      selectThread(threadId, options = {}) {
        if (!threadId) return;
        if (!setActiveThread(threadId)) return;
        state.codex.memberMenu = null;
        state.codex.threadMenu = null;
        const openConversation = options.openConversation !== false;
        if (state.codex.chatDockMode === 'hud' && openConversation) {
          state.codex.hudView = 'conversation';
        }
        state.codex.draft = getCodexThreadDraft(state.codex, threadId);
        emit();
      },
      toggleThreadPin(threadId) {
        if (!threadId) return;
        updateThreadById(threadId, (thread) => ({ ...thread, pinned: !thread.pinned }));
        state.codex.threadMenu = null;
        state.codex.memberMenu = null;
        emit();
      },
      renameThread(threadId) {
        if (!threadId) return;
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread) return;
        const nextTitle = (window.prompt('채팅방 이름 변경', thread.title) || '').trim();
        if (!nextTitle || nextTitle === thread.title) {
          state.codex.threadMenu = null;
          emit();
          return;
        }
        updateThreadById(threadId, (current) => {
          let nextParticipants = current.participants || [];
          let nextRoles = { ...(current.participantRoles || {}) };
          if (current.type === 'dm') {
            const peer = nextParticipants.find((name) => name !== SELF_MEMBER);
            if (peer) {
              nextParticipants = nextParticipants.map((name) => (name === peer ? nextTitle : name));
              const peerRole = nextRoles[peer];
              delete nextRoles[peer];
              nextRoles[nextTitle] = peerRole || 'member';
            }
          }
          return {
            ...current,
            title: nextTitle,
            participants: nextParticipants,
            participantRoles: nextRoles,
            subtitle: buildThreadSubtitle(current.type, nextParticipants),
          };
        });
        state.codex.threadMenu = null;
        emit();
      },
      deleteThread(threadId) {
        if (!threadId) return;
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread) return;
        const shouldDelete = window.confirm(`'${thread.title}' 채팅방을 완전히 삭제할까요?`);
        if (!shouldDelete) {
          state.codex.threadMenu = null;
          emit();
          return;
        }
        if (state.codex.threads.length <= 1) {
          state.codex.threadMenu = null;
          update({ error: '최소 1개의 채팅방은 남아 있어야 합니다.' });
          return;
        }
        const nextThreads = state.codex.threads.filter((entry) => entry.id !== threadId);
        state.codex.threads = nextThreads;
        if (state.codex.activeThreadId === threadId) {
          state.codex.activeThreadId = nextThreads[0]?.id || null;
        }
        state.codex.threadMenu = null;
        state.codex.memberMenu = null;
        state.codex.messageThreadMap = Object.fromEntries(
          Object.entries(state.codex.messageThreadMap).filter(([, mappedThreadId]) => mappedThreadId !== threadId)
        );
        state.codex.threadDrafts = Object.fromEntries(
          Object.entries(state.codex.threadDrafts || {}).filter(([savedThreadId]) => savedThreadId !== threadId)
        );
        const active = getActiveCodexThread(state.codex);
        state.codex.conversationId = active?.conversationId || null;
        state.codex.draft = getCodexThreadDraft(state.codex, active?.id || null);
        emit();
      },
      createThread(type = 'dm', options = {}) {
        const normalizedType = type === 'group' ? 'group' : 'dm';
        const nextNonce = state.codex.threadNonce + 1;
        const label = normalizedType === 'group' ? `새 그룹 ${nextNonce}` : `연락처 ${nextNonce}`;
        const participants = normalizedType === 'group'
          ? [SELF_MEMBER, '코덱스 어시스턴트', `멤버 ${nextNonce}`]
          : [SELF_MEMBER, label];
        const thread = createCodexThread(normalizedType, label, '', { participants });
        state.codex.threadNonce = nextNonce;
        state.codex.threads = [thread, ...state.codex.threads];
        state.codex.activeThreadId = thread.id;
        state.codex.conversationId = null;
        state.codex.memberMenu = null;
        state.codex.threadMenu = null;
        state.codex.threadDrafts = {
          ...(state.codex.threadDrafts || {}),
          [thread.id]: '',
        };
        state.codex.draft = '';
        if (state.codex.chatDockMode === 'hud' && options.openConversation !== false) {
          state.codex.hudView = 'conversation';
        }
        emit();
      },
      setThreadMemberRole(threadId, memberName, nextRole) {
        if (!threadId || !memberName || memberName === SELF_MEMBER) return;
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || thread.type !== 'group' || !(thread.participants || []).includes(memberName)) return;
        if (nextRole !== 'admin' && nextRole !== 'member') return;
        updateThreadById(threadId, (current) => {
          return {
            ...current,
            participantRoles: {
              ...(current.participantRoles || {}),
              [memberName]: nextRole,
            },
          };
        });
        state.codex.memberMenu = null;
        state.codex.threadMenu = null;
        emit();
      },
      cycleThreadMemberRole(threadId, memberName) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread) return;
        const currentRole = codexThreadRole(thread, memberName);
        const nextRole = currentRole === 'admin' ? 'member' : 'admin';
        this.setThreadMemberRole(threadId, memberName, nextRole);
      },
      removeFromThread(threadId, memberName) {
        if (!threadId || !memberName || memberName === SELF_MEMBER) return;
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || thread.type !== 'group') return;
        const nextParticipants = (thread.participants || []).filter((member) => member !== memberName);
        if (nextParticipants.length < 2) return;
        updateThreadById(threadId, (current) => {
          const nextRoles = { ...(current.participantRoles || {}) };
          delete nextRoles[memberName];
          return {
            ...current,
            participants: nextParticipants,
            participantRoles: nextRoles,
            subtitle: buildThreadSubtitle(current.type, nextParticipants),
          };
        });
        state.codex.memberMenu = null;
        state.codex.threadMenu = null;
        emit();
      },
      inviteToThread(threadId) {
        const targetId = threadId || state.codex.activeThreadId;
        if (!targetId) return;
        const thread = getCodexThreadById(state.codex, targetId);
        if (!thread || thread.type !== 'group') return;
        const nextMemberNonce = state.codex.memberNonce + 1;
        const memberName = `멤버 ${nextMemberNonce}`;
        state.codex.memberNonce = nextMemberNonce;
        updateThreadById(targetId, (current) => {
          const nextParticipants = uniqueNames([...(current.participants || []), memberName]);
          const nextRoles = { ...(current.participantRoles || {}), [memberName]: 'member' };
          return {
            ...current,
            participants: nextParticipants,
            participantRoles: nextRoles,
            subtitle: buildThreadSubtitle(current.type, nextParticipants),
          };
        });
        state.codex.memberMenu = null;
        state.codex.threadMenu = null;
        emit();
      },
      async refreshAuthStatus() {
        try {
          const bridgeState = await fetchJson('/v1/state');
          const status = bridgeState?.auth || state.codex.authStatus;
          update({
            provider: bridgeState?.provider || state.codex.provider,
            protocolVersion: Number(bridgeState?.protocolVersion || state.codex.protocolVersion || 0),
            authStatus: status,
            isStartingLogin: Boolean(status.loginInProgress),
            error: null,
          });
        } catch (error) {
          try {
            const status = await fetchJson('/auth/status');
            update({ authStatus: status, isStartingLogin: Boolean(status.loginInProgress), error: null });
          } catch (fallbackError) {
            update({ error: fallbackError.message });
          }
        }
      },
      async startLogin() {
        try {
          update({ error: null });
          const result = await fetchJson('/auth/start', { method: 'POST' });
          if (!result.started) {
            update({
              isStartingLogin: Boolean(result.loginInProgress),
              error: result.loginInProgress || result.alreadyLoggedIn ? null : result.message
            });
            await this.refreshAuthStatus();
          }
        } catch (error) {
          update({ error: error.message });
        }
      },
      async signOut() {
        try {
          const status = await fetchJson('/auth/signout', { method: 'POST' });
          resetThreadConversations();
          update({
            authStatus: status,
            isStartingLogin: Boolean(status.loginInProgress),
            conversationId: null,
            isSending: false,
            hudView: 'list',
            error: null,
          });
        } catch (error) {
          update({ error: error.message });
        }
      },
      async sendMessage() {
        const activeThread = getActiveCodexThread(state.codex);
        const content = getCodexThreadDraft(state.codex, activeThread?.id || null).trim();
        if (!activeThread || !content || state.codex.isSending || !state.codex.authStatus.isLoggedIn) return;
        appendMessageToThread(activeThread.id, createCodexMessage('user', content, 'complete', {
          readBy: [SELF_MEMBER],
        }), { countUnread: false });
        state.codex.error = null;
        state.codex.isSending = true;
        state.codex.pendingThreadId = activeThread.id;
        state.codex.threadDrafts = {
          ...(state.codex.threadDrafts || {}),
          [activeThread.id]: '',
        };
        state.codex.draft = '';
        emit();
        try {
          const result = await fetchJson('/chat/send', {
            method: 'POST',
            body: JSON.stringify({
              conversationId: activeThread.conversationId ?? undefined,
              message: content,
            }),
          });
          if (result.conversationId) {
            setThreadConversationId(activeThread.id, result.conversationId);
            state.codex.conversationId = result.conversationId;
          }
          if (!result.accepted && result.error) {
            update({ isSending: false, error: result.error });
          } else {
            emit();
          }
        } catch (error) {
          update({ isSending: false, error: error.message });
        }
      },
    };
  }

  function toggleHUD(appId, appLabel) {
    const hud = document.getElementById('egd-hud');
    if (!hud) return;
    const body = document.getElementById('egd-hud-body');
    body?._codexCleanup?.();
    if (appId === 'chat' && state.codex.chatDockMode === 'canvas' && state.codex.chatCardEntityId) {
      const chatCard = document.getElementById(state.codex.chatCardEntityId);
      if (chatCard) {
        chatCard.style.zIndex = String(++cardZ);
        setActiveEntity(chatCard);
        return;
      }
      state.codex.chatDockMode = 'hud';
      state.codex.chatCardEntityId = null;
    }
    if (!appId || (state.hudOpen && state.hudApp === appId)) {
      hud.classList.add('egd-hud-hidden');
      state.hudOpen = false;
      state.hudApp = null;
      hud.dataset.app = '';
      return;
    }
    state.hudOpen = true;
    state.hudApp = appId;
    hud.dataset.app = appId;
    hud.classList.remove('egd-hud-hidden');
    hud.querySelector('.egd-hud-title').textContent = appId === 'chat' ? '코덱스 채팅' : appLabel;
    body.textContent = '';
    if (appId === 'chat' && state.codexBridge) {
      state.codexBridge.openHudHome?.();
      mountCodexHUD(body, state.codexBridge, {
        mode: 'hud',
        onMoveToCanvas: () => detachCodexChatFromHud(),
      });
      return;
    }
    body.appendChild(el('div', { class: 'egd-hud-placeholder' },
      el('div', { class: 'egd-hud-ph-title' }, `${appLabel} 패널`),
      el('div', { class: 'egd-hud-ph-sub' }, `${appLabel} 전용 패널이 여기 렌더됩니다. 실제 기능은 2단계에서 연결됩니다.`),
    ));
  }

  function detachCodexChatFromHud(clientX = Math.round(window.innerWidth * 0.64), clientY = Math.round(window.innerHeight * 0.53)) {
    if (!state.codexBridge) return null;
    const card = spawnCodexChatCard(clientX, clientY);
    state.codex.chatDockMode = 'canvas';
    state.codex.chatCardEntityId = card.id;
    toggleHUD(null);
    setActiveEntity(card);
    return card;
  }

  function dockCodexChatToHud() {
    const card = document.getElementById(state.codex.chatCardEntityId);
    if (card && typeof card._cleanup === 'function') {
      card._cleanup();
      card.remove();
    }
    state.codex.chatDockMode = 'hud';
    state.codex.chatCardEntityId = null;
    toggleHUD('chat', '채팅');
  }

  function spawnCodexChatCard(anchorClientX = Math.round(window.innerWidth * 0.64), anchorClientY = Math.round(window.innerHeight * 0.53)) {
    const existing = state.codex.chatCardEntityId ? document.getElementById(state.codex.chatCardEntityId) : null;
    if (existing && existing.isConnected) {
      existing.style.zIndex = String(++cardZ);
      setActiveEntity(existing);
      return existing;
    }

    const id = `egd-chat-card-${++cardSeq}`;
    const width = 560;
    const height = 680;
    const center = viewportToCanvasPoint(anchorClientX, anchorClientY);
    const card = el('div', {
      id,
      class: 'egd-canvas-card egd-chat-card',
      style: {
        top: Math.round(center.y - height / 2) + 'px',
        left: Math.round(center.x - width / 2) + 'px',
        width: width + 'px',
        height: height + 'px',
        zIndex: String(++cardZ),
      },
    });

    const header = el('div', { class: 'egd-chat-card-header' },
      el('div', { class: 'egd-chat-card-title' }, '코덱스 채팅'),
      el('div', { class: 'egd-chat-card-actions' },
        el('button', {
          class: 'egd-chat-card-action',
          title: '우측 패널로 이동',
          onclick: (ev) => {
            ev.stopPropagation();
            dockCodexChatToHud();
          },
        }, '고정'),
        el('button', {
          class: 'egd-chat-card-action',
          title: '닫기',
          onclick: (ev) => {
            ev.stopPropagation();
            cleanup();
            card.remove();
          },
        }, '×'),
      ),
    );
    const body = el('div', { class: 'egd-chat-card-body' });
    card.appendChild(header);
    card.appendChild(body);

    const host = document.getElementById('egd-canvas-layer') || document.documentElement;
    host.appendChild(card);
    setActiveEntity(card);

    if (state.codexBridge) {
      mountCodexHUD(body, state.codexBridge, {
        mode: 'canvas',
        onMoveToHud: () => dockCodexChatToHud(),
      });
    }

    const activateCard = () => {
      if (state.panModifier) return;
      setActiveEntity(card);
    };
    const focusCard = () => {
      activateCard();
      card.style.zIndex = String(++cardZ);
    };
    const startPanIfNeeded = (ev) => {
      if (!state.panModifier || ev.button !== 0) return false;
      if (typeof state.startCanvasPanDrag !== 'function') return false;
      state.startCanvasPanDrag(ev);
      return true;
    };
    const routeWheelToCanvas = (ev) => {
      if (ev.ctrlKey || ev.metaKey) return;
      const allowCardScroll = state.activeEntityId === card.id && body.contains(ev.target);
      if (allowCardScroll) return;
      if (typeof state.panCanvasByWheel !== 'function') return;
      ev.preventDefault();
      ev.stopPropagation();
      state.panCanvasByWheel(ev);
    };

    let drag = null;
    header.addEventListener('mousedown', (ev) => {
      if (startPanIfNeeded(ev)) return;
      if (ev.button !== 0 || ev.target.closest('button')) return;
      focusCard();
      drag = { x: ev.clientX, y: ev.clientY, left: card.offsetLeft, top: card.offsetTop };
      ev.preventDefault();
    });
    body.addEventListener('wheel', routeWheelToCanvas, { passive: false });
    for (const target of [card, header, body]) {
      target.addEventListener('mousedown', () => activateCard(), true);
      target.addEventListener('wheel', routeWheelToCanvas, { passive: false, capture: true });
    }
    const onMove = (ev) => {
      const s = state.zoom || 1;
      if (!drag) return;
      card.style.left = (drag.left + (ev.clientX - drag.x) / s) + 'px';
      card.style.top = (drag.top + (ev.clientY - drag.y) / s) + 'px';
    };
    const onUp = () => {
      drag = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    const cleanup = () => {
      body?._codexCleanup?.();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (state.activeEntityId === card.id) setActiveEntity(null);
      if (state.codex.chatCardEntityId === card.id) {
        state.codex.chatCardEntityId = null;
        if (state.codex.chatDockMode === 'canvas') {
          state.codex.chatDockMode = 'hud';
        }
      }
    };
    card._cleanup = cleanup;
    state.codex.chatDockMode = 'canvas';
    state.codex.chatCardEntityId = card.id;
    return card;
  }

  // ============ Canvas Entity: Browser Card ============
  let cardZ = 40000;
  let cardSeq = 0;

  // Logical 데스크톱 뷰포트 — 너무 좁으면 일부 데스크톱 사이트(Naver 등)가
  // 내부 최소 폭에 걸려 가로 스크롤이 생긴다. 1440x900 기준으로 렌더 후 축소.
  const CARD_LOGICAL_W = 1440;
  const CARD_LOGICAL_H = 900;
  const CARD_HEADER_H = 50;
  const CARD_ASPECT = CARD_LOGICAL_H / CARD_LOGICAL_W;
  const cardHeightForWidth = (width) => Math.round(CARD_HEADER_H + width * CARD_ASPECT);

  // ============ Settings Canvas Card ============
  const SETTINGS_MODELS = [
    { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai', desc: 'OpenAI \uCD5C\uC2E0 \uB300\uD615 \uBAA8\uB378', icon: 'G', color: '#10A37F', enabled: true, isDefault: true },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'openai', desc: '\uBE60\uB974\uACE0 \uACBD\uC81C\uC801\uC778 \uC18C\uD615 \uBAA8\uB378', icon: 'g', color: '#10A37F', enabled: true, isDefault: false },
    { id: 'claude-4-sonnet', name: 'Claude 4 Sonnet', provider: 'anthropic', desc: 'Anthropic \uACE0\uC131\uB2A5 \uBAA8\uB378', icon: 'C', color: '#D97706', enabled: true, isDefault: false },
    { id: 'claude-4-haiku', name: 'Claude 4 Haiku', provider: 'anthropic', desc: '\uBE60\uB978 \uC751\uB2F5 \uC18C\uD615 \uBAA8\uB378', icon: 'c', color: '#D97706', enabled: false, isDefault: false },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', desc: 'Google \uCD5C\uC2E0 \uB300\uD615 \uBAA8\uB378', icon: 'G', color: '#4285F4', enabled: true, isDefault: false },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', desc: '\uBE60\uB978 \uC751\uB2F5 \uACBD\uC81C\uD615 \uBAA8\uB378', icon: 'f', color: '#4285F4', enabled: false, isDefault: false },
  ];
  const CODEX_ACCOUNT = {
    email: 'm8chaa@gmail.com',
    name: 'Minsoo Cha',
    avatar: 'M',
    plan: 'Pro',
    loggedIn: true,
    connectedProviders: ['openai', 'anthropic', 'google'],
  };
  const SETTINGS_PROVIDERS = [
    { id: 'openai', name: 'OpenAI', icon: '\u2B50', models: ['GPT-4.1', 'GPT-4.1 Mini', 'GPT-4.1 Nano'], quota: '\uBB34\uC81C\uD55C' },
    { id: 'anthropic', name: 'Anthropic', icon: '\u26A1', models: ['Claude 4 Sonnet', 'Claude 4 Haiku'], quota: '\uBB34\uC81C\uD55C' },
    { id: 'google', name: 'Google AI', icon: '\u2B22', models: ['Gemini 2.5 Pro', 'Gemini 2.5 Flash'], quota: '\uBB34\uC81C\uD55C' },
    { id: 'local', name: 'Local (Ollama)', icon: '\uD83D\uDDA5\uFE0F', models: ['Llama 3', 'Mistral'], quota: '\uB85C\uCEEC' },
  ];
  const SETTINGS_AGENTS = [
    { id: 'a1', name: '\uCF54\uB371\uC2A4 \uC5B4\uC2DC\uC2A4\uD134\uD2B8', desc: '\uAE30\uBCF8 AI \uC5B4\uC2DC\uC2A4\uD134\uD2B8', model: 'gpt-4.1', color: '#2D5A7B', prompt: '\uB2F9\uC2E0\uC740 \uB3C4\uC6C0\uC774 \uB418\uB294 AI \uC5B4\uC2DC\uC2A4\uD134\uD2B8\uC785\uB2C8\uB2E4.', active: true },
    { id: 'a2', name: '\uCF54\uB4DC \uB9AC\uBDF0\uC5B4', desc: '\uCF54\uB4DC \uB9AC\uBDF0 \uBC0F \uBC84\uADF8 \uD0D0\uC9C0 \uC804\uBB38', model: 'claude-4-sonnet', color: '#8B5CF6', prompt: '\uB2F9\uC2E0\uC740 \uCF54\uB4DC \uB9AC\uBDF0 \uC804\uBB38\uAC00\uC785\uB2C8\uB2E4.', active: true },
    { id: 'a3', name: '\uBC88\uC5ED\uAC00', desc: '\uB2E4\uAD6D\uC5B4 \uBC88\uC5ED \uC804\uBB38', model: 'gemini-2.5-pro', color: '#059669', prompt: '\uB2F9\uC2E0\uC740 \uC804\uBB38 \uBC88\uC5ED\uAC00\uC785\uB2C8\uB2E4.', active: false },
  ];

  function spawnSettingsCard() {
    const id = `egd-settings-card-${++cardSeq}`;
    const initialWidth = 560;
    const initialHeight = 480;
    const offset = ((cardSeq - 1) % 6) * 24;
    const center = viewportToCanvasPoint(
      window.innerWidth / 2 + offset,
      window.innerHeight / 2 + offset,
    );
    const card = el('div', {
      id,
      class: 'egd-canvas-card egd-settings-card',
      style: {
        top: Math.round(center.y - initialHeight / 2) + 'px',
        left: Math.round(center.x - initialWidth / 2) + 'px',
        width: initialWidth + 'px',
        height: initialHeight + 'px',
        zIndex: String(++cardZ),
      },
    });

    const header = el('div', { class: 'egd-card-header' },
      el('div', { class: 'egd-card-topbar' },
        el('div', { class: 'egd-card-dots-shell' },
          el('div', { class: 'egd-card-dots' },
            el('span', { class: 'egd-card-dot egd-card-dot-close', onclick: (ev) => { ev.stopPropagation(); card.remove(); } }),
            el('span', { class: 'egd-card-dot egd-card-dot-min' }),
            el('span', { class: 'egd-card-dot egd-card-dot-max' }),
          ),
        ),
      ),
    );

    const contentArea = el('div', { class: 'egd-settings-content' });
    let activeTab = 'models';

    const renderModelsTab = () => {
      contentArea.textContent = '';
      const section = el('div', { class: 'egd-settings-section' });
      section.appendChild(el('div', { class: 'egd-settings-section-title' }, 'AI \uBAA8\uB378 \uBAA9\uB85D'));
      for (const model of SETTINGS_MODELS) {
        const toggle = el('button', {
          class: 'egd-settings-toggle' + (model.enabled ? ' egd-settings-toggle-on' : ''),
          onclick: () => {
            model.enabled = !model.enabled;
            renderModelsTab();
          },
        });
        const row = el('div', { class: 'egd-settings-model-row' },
          el('div', { class: 'egd-settings-model-icon', style: { background: model.color } }, model.icon),
          el('div', { class: 'egd-settings-model-info' },
            el('div', { class: 'egd-settings-model-name' }, model.name),
            el('div', { class: 'egd-settings-model-desc' }, model.desc),
          ),
          ...(model.isDefault ? [el('span', { class: 'egd-settings-default-badge' }, '\uAE30\uBCF8')] : []),
          toggle,
        );
        section.appendChild(row);
      }
      contentArea.appendChild(section);
    };

    const renderProvidersTab = () => {
      contentArea.textContent = '';

      // --- Codex Account Section ---
      const acctSection = el('div', { class: 'egd-settings-section' });
      acctSection.appendChild(el('div', { class: 'egd-settings-section-title' }, 'Codex \uACC4\uC815'));
      if (CODEX_ACCOUNT.loggedIn) {
        const acctCard = el('div', { class: 'egd-settings-codex-account' },
          el('div', { class: 'egd-settings-codex-avatar', style: { background: '#2D5A7B' } }, CODEX_ACCOUNT.avatar),
          el('div', { class: 'egd-settings-codex-info' },
            el('div', { class: 'egd-settings-codex-name' },
              CODEX_ACCOUNT.name,
              el('span', { class: 'egd-settings-plan-badge' }, CODEX_ACCOUNT.plan),
            ),
            el('div', { class: 'egd-settings-codex-email' }, CODEX_ACCOUNT.email),
          ),
          el('button', { class: 'egd-settings-btn egd-settings-btn-danger', onclick: () => {
            CODEX_ACCOUNT.loggedIn = false;
            CODEX_ACCOUNT.connectedProviders = [];
            renderProvidersTab();
          } }, '\uB85C\uADF8\uC544\uC6C3'),
        );
        acctSection.appendChild(acctCard);
      } else {
        const loginCard = el('div', { class: 'egd-settings-codex-login' },
          el('div', { class: 'egd-settings-codex-login-icon' }, '\uD83D\uDD11'),
          el('div', { class: 'egd-settings-codex-login-text' },
            el('div', { style: { fontWeight: '600', marginBottom: '4px' } }, 'Codex\uC5D0 \uB85C\uADF8\uC778\uD558\uC138\uC694'),
            el('div', { style: { fontSize: '12px', color: '#666' } }, 'Codex \uACC4\uC815\uC73C\uB85C \uBAA8\uB4E0 AI Provider\uB97C \uD1B5\uD569 \uAD00\uB9AC\uD569\uB2C8\uB2E4.'),
          ),
          el('button', { class: 'egd-settings-btn egd-settings-btn-primary', onclick: () => {
            CODEX_ACCOUNT.loggedIn = true;
            CODEX_ACCOUNT.email = 'm8chaa@gmail.com';
            CODEX_ACCOUNT.name = 'Minsoo Cha';
            CODEX_ACCOUNT.connectedProviders = ['openai', 'anthropic', 'google'];
            renderProvidersTab();
          } }, '\uB85C\uADF8\uC778'),
        );
        acctSection.appendChild(loginCard);
      }
      contentArea.appendChild(acctSection);

      // --- Connected Providers Section ---
      const provSection = el('div', { class: 'egd-settings-section' });
      provSection.appendChild(el('div', { class: 'egd-settings-section-title' }, '\uC5F0\uACB0\uB41C AI Provider'));
      for (const prov of SETTINGS_PROVIDERS) {
        const isConnected = CODEX_ACCOUNT.loggedIn && CODEX_ACCOUNT.connectedProviders.includes(prov.id);
        const statusDot = isConnected ? 'egd-settings-status-dot-ok' : 'egd-settings-status-dot-off';
        const statusText = isConnected ? '\uC5F0\uACB0\uB428' : '\uBBF8\uC5F0\uACB0';
        const toggleBtn = CODEX_ACCOUNT.loggedIn
          ? el('button', {
              class: 'egd-settings-toggle' + (isConnected ? ' egd-settings-toggle-on' : ''),
              onclick: () => {
                if (isConnected) {
                  CODEX_ACCOUNT.connectedProviders = CODEX_ACCOUNT.connectedProviders.filter(p => p !== prov.id);
                } else {
                  CODEX_ACCOUNT.connectedProviders.push(prov.id);
                }
                renderProvidersTab();
              },
            })
          : null;
        const row = el('div', { class: 'egd-settings-provider-row' },
          el('div', { class: 'egd-settings-provider-logo' }, prov.icon),
          el('div', { class: 'egd-settings-provider-info' },
            el('div', { class: 'egd-settings-provider-name' }, prov.name),
            el('div', { class: 'egd-settings-provider-status' },
              el('span', { class: `egd-settings-status-dot ${statusDot}` }),
              statusText,
              ...(isConnected ? [' \u00B7 ', prov.models.join(', ')] : []),
            ),
            ...(isConnected ? [el('div', { class: 'egd-settings-provider-quota' }, '\uC0AC\uC6A9\uB7C9: ' + prov.quota)] : []),
          ),
          ...(toggleBtn ? [toggleBtn] : []),
        );
        provSection.appendChild(row);
      }
      contentArea.appendChild(provSection);
    };

    let showAgentForm = false;
    let editingAgent = null;
    const renderAgentsTab = () => {
      contentArea.textContent = '';
      if (showAgentForm) {
        const form = el('div', { class: 'egd-settings-form' });
        const nameInput = el('input', { class: 'egd-settings-form-input', type: 'text', value: editingAgent ? editingAgent.name : '', placeholder: 'Agent \uC774\uB984' });
        const descInput = el('input', { class: 'egd-settings-form-input', type: 'text', value: editingAgent ? editingAgent.desc : '', placeholder: '\uC124\uBA85' });
        const modelSelect = el('select', { class: 'egd-settings-form-select' });
        for (const m of SETTINGS_MODELS.filter(m => m.enabled)) {
          const opt = el('option', { value: m.id }, m.name);
          if (editingAgent && editingAgent.model === m.id) opt.selected = true;
          modelSelect.appendChild(opt);
        }
        const promptArea = el('textarea', { class: 'egd-settings-form-textarea', placeholder: '\uC2DC\uC2A4\uD15C \uD504\uB86C\uD504\uD2B8' });
        if (editingAgent) promptArea.value = editingAgent.prompt;
        form.appendChild(el('div', {}, el('div', { class: 'egd-settings-form-label' }, 'Agent \uC774\uB984'), nameInput));
        form.appendChild(el('div', {}, el('div', { class: 'egd-settings-form-label' }, '\uC124\uBA85'), descInput));
        form.appendChild(el('div', {}, el('div', { class: 'egd-settings-form-label' }, '\uC0AC\uC6A9 \uBAA8\uB378'), modelSelect));
        form.appendChild(el('div', {}, el('div', { class: 'egd-settings-form-label' }, '\uC2DC\uC2A4\uD15C \uD504\uB86C\uD504\uD2B8'), promptArea));
        form.appendChild(el('div', { class: 'egd-settings-form-actions' },
          el('button', { class: 'egd-settings-btn', onclick: () => { showAgentForm = false; editingAgent = null; renderAgentsTab(); } }, '\uCDE8\uC18C'),
          el('button', { class: 'egd-settings-btn egd-settings-btn-primary', onclick: () => {
            if (editingAgent) {
              editingAgent.name = nameInput.value || editingAgent.name;
              editingAgent.desc = descInput.value || editingAgent.desc;
              editingAgent.model = modelSelect.value;
              editingAgent.prompt = promptArea.value;
            } else {
              SETTINGS_AGENTS.push({
                id: 'a' + (SETTINGS_AGENTS.length + 1),
                name: nameInput.value || '\uC0C8 Agent',
                desc: descInput.value || '',
                model: modelSelect.value,
                color: '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0'),
                prompt: promptArea.value,
                active: true,
              });
            }
            showAgentForm = false; editingAgent = null; renderAgentsTab();
          } }, editingAgent ? '\uC800\uC7A5' : '\uC0DD\uC131'),
        ));
        contentArea.appendChild(form);
        return;
      }
      const section = el('div', { class: 'egd-settings-section' });
      section.appendChild(el('div', { class: 'egd-settings-section-title' }, 'Agent \uBAA9\uB85D'));
      if (SETTINGS_AGENTS.length === 0) {
        section.appendChild(el('div', { class: 'egd-settings-empty' }, '\uC0DD\uC131\uB41C Agent\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.'));
      }
      for (const agent of SETTINGS_AGENTS) {
        const toggle = el('button', {
          class: 'egd-settings-toggle' + (agent.active ? ' egd-settings-toggle-on' : ''),
          onclick: () => { agent.active = !agent.active; renderAgentsTab(); },
        });
        const modelName = SETTINGS_MODELS.find(m => m.id === agent.model)?.name || agent.model;
        const row = el('div', { class: 'egd-settings-agent-row' },
          el('div', { class: 'egd-settings-agent-avatar', style: { background: agent.color } }, agent.name.charAt(0)),
          el('div', { class: 'egd-settings-agent-info' },
            el('div', { class: 'egd-settings-agent-name' }, agent.name),
            el('div', { class: 'egd-settings-agent-desc' }, agent.desc),
            el('div', { class: 'egd-settings-agent-model' }, '\uBAA8\uB378: ' + modelName),
          ),
          el('div', { class: 'egd-settings-agent-actions' },
            el('button', { class: 'egd-settings-btn', onclick: () => { editingAgent = agent; showAgentForm = true; renderAgentsTab(); } }, '\uD3B8\uC9D1'),
            el('button', { class: 'egd-settings-btn egd-settings-btn-danger', onclick: () => {
              const idx = SETTINGS_AGENTS.indexOf(agent);
              if (idx >= 0) SETTINGS_AGENTS.splice(idx, 1);
              renderAgentsTab();
            } }, '\uC0AD\uC81C'),
          ),
          toggle,
        );
        section.appendChild(row);
      }
      section.appendChild(el('div', { style: { marginTop: '12px' } },
        el('button', { class: 'egd-settings-btn egd-settings-btn-primary', onclick: () => { showAgentForm = true; editingAgent = null; renderAgentsTab(); } }, '+ \uC0C8 Agent \uC0DD\uC131'),
      ));
      contentArea.appendChild(section);
    };

    const tabs = el('div', { class: 'egd-settings-tabs' });
    const tabDefs = [
      { id: 'models', label: 'AI \uBAA8\uB378', render: renderModelsTab },
      { id: 'providers', label: '\uACC4\uC815 & Provider', render: renderProvidersTab },
      { id: 'agents', label: 'Agent \uAD00\uB9AC', render: renderAgentsTab },
    ];
    const renderTabs = () => {
      tabs.textContent = '';
      for (const t of tabDefs) {
        tabs.appendChild(el('button', {
          class: 'egd-settings-tab' + (activeTab === t.id ? ' egd-settings-tab-active' : ''),
          onclick: () => { activeTab = t.id; renderTabs(); t.render(); },
        }, t.label));
      }
    };

    const shell = el('div', { class: 'egd-settings-shell' },
      el('div', { class: 'egd-settings-header' },
        el('span', { style: { fontSize: '18px' } }, '\u2699\uFE0F'),
        el('div', { class: 'egd-settings-header-title' }, '\uC0C1\uC138 \uC124\uC815'),
      ),
      tabs,
      contentArea,
    );

    const body = el('div', { class: 'egd-card-body', style: { overflow: 'hidden' } }, shell);
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
    setActiveEntity(card);

    renderTabs();
    renderModelsTab();

    // Drag support
    let drag = null;
    header.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('input, button, .egd-card-dot')) return;
      card.style.zIndex = String(++cardZ);
      setActiveEntity(card);
      drag = { x: ev.clientX, y: ev.clientY, left: card.offsetLeft, top: card.offsetTop };
      ev.preventDefault();
    });
    document.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      card.style.left = (drag.left + ev.clientX - drag.x) + 'px';
      card.style.top = (drag.top + ev.clientY - drag.y) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = null; });

    return card;
  }


  function spawnBrowserCard(initialUrl = 'https://duckduckgo.com') {
    const id = `egd-browser-card-${++cardSeq}`;
    const initialWidth = 720;
    const initialHeight = cardHeightForWidth(initialWidth);
    const offset = ((cardSeq - 1) % 6) * 24;
    const center = viewportToCanvasPoint(
      window.innerWidth / 2 + offset,
      window.innerHeight / 2 + offset,
    );

    const card = el('div', {
      id,
      class: 'egd-canvas-card egd-browser-card',
      style: {
        top: Math.round(center.y - initialHeight / 2) + 'px',
        left: Math.round(center.x - initialWidth / 2) + 'px',
        width: initialWidth + 'px',
        height: initialHeight + 'px',
        zIndex: String(++cardZ),
      },
    });

    const urlInput = el('input', {
      type: 'text',
      class: 'egd-card-url',
      value: initialUrl,
    });

    const header = el('div', { class: 'egd-card-header' },
      el('div', { class: 'egd-card-topbar' },
        el('div', { class: 'egd-card-dots-shell' },
          el('div', { class: 'egd-card-dots' },
            el('span', { class: 'egd-card-dot egd-card-dot-close', onclick: (ev) => { ev.stopPropagation(); card.remove(); cleanupCard(); } }),
            el('span', { class: 'egd-card-dot egd-card-dot-min' }),
            el('span', { class: 'egd-card-dot egd-card-dot-max' }),
          ),
        ),
      ),
      el('div', { class: 'egd-card-toolbar' },
        el('div', { class: 'egd-card-nav' },
          el('button', {
            class: 'egd-card-nav-btn',
            title: '뒤로',
            onclick: (ev) => {
              ev.stopPropagation();
              try { xulBrowser.goBack && xulBrowser.goBack(); } catch {}
            },
          }, '←'),
          el('button', {
            class: 'egd-card-nav-btn',
            title: '앞으로',
            onclick: (ev) => {
              ev.stopPropagation();
              try { xulBrowser.goForward && xulBrowser.goForward(); } catch {}
            },
          }, '→'),
          el('button', {
            class: 'egd-card-nav-btn egd-card-reload',
            title: '새로고침',
            onclick: (ev) => { ev.stopPropagation(); xulBrowser.reload && xulBrowser.reload(); },
          }, '↻'),
        ),
        el('div', { class: 'egd-card-omnibox' },
          el('span', { class: 'egd-card-omnibox-icon' }, '⌕'),
          urlInput,
        ),
        el('button', {
          class: 'egd-card-menu',
          title: '더보기',
          onclick: (ev) => ev.stopPropagation(),
        }, '⋮'),
      ),
    );

    // ---- Body → wrap (logical 1440×900) → XUL browser ----
    const wrap = el('div', { class: 'egd-card-wrap' });
    wrap.style.width = CARD_LOGICAL_W + 'px';
    wrap.style.height = CARD_LOGICAL_H + 'px';

    const bodyCapture = el('div', { class: 'egd-card-body-capture' });
    const body = el('div', { class: 'egd-card-body' }, wrap, bodyCapture);
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
    setActiveEntity(card);

    let xulBrowser;
    try {
      xulBrowser = document.createXULElement('browser');
      xulBrowser.setAttribute('type', 'content');
      xulBrowser.setAttribute('remote', 'true');
      xulBrowser.setAttribute('maychangeremoteness', 'true');
      xulBrowser.setAttribute('disableglobalhistory', 'true');
      xulBrowser.setAttribute('flex', '1');
      xulBrowser.style.cssText = 'width:100%; height:100%; background:#fff; display:block;';
      wrap.appendChild(xulBrowser);
      xulBrowser.setAttribute('src', initialUrl);
    } catch (e) {
      console.error(TAG, 'XUL browser create failed, falling back to iframe', e);
      const frame = el('iframe', { src: initialUrl, style: { width: '100%', height: '100%', border: '0' } });
      wrap.appendChild(frame);
      xulBrowser = frame;
    }

    const activateCard = () => {
      if (state.panModifier) return;
      setActiveEntity(card);
    };
    const focusCard = () => {
      activateCard();
      card.style.zIndex = String(++cardZ);
    };
    const startPanIfNeeded = (ev) => {
      if (!state.panModifier || ev.button !== 0) return false;
      if (typeof state.startCanvasPanDrag !== 'function') return false;
      state.startCanvasPanDrag(ev);
      return true;
    };
    const routeWheelToCanvas = (ev) => {
      if (ev.ctrlKey || ev.metaKey) return;
      const allowCardScroll = state.activeEntityId === card.id
        && (ev.target === xulBrowser || ev.target === wrap || ev.target === body || body.contains(ev.target));
      if (allowCardScroll) return;
      if (typeof state.panCanvasByWheel !== 'function') return;
      ev.preventDefault();
      ev.stopPropagation();
      state.panCanvasByWheel(ev);
    };
    bodyCapture.addEventListener('mousedown', (ev) => {
      if (startPanIfNeeded(ev)) return;
      focusCard();
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
    bodyCapture.addEventListener('wheel', routeWheelToCanvas, { passive: false });
    for (const target of [card, header, body, wrap, xulBrowser]) {
      target.addEventListener('mousedown', () => activateCard(), true);
      target.addEventListener('wheel', routeWheelToCanvas, { passive: false, capture: true });
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

    // ---- Fit-to-card scaling: width 기준 scale, height 는 logical viewport 로 흡수 ----
    const updateFitScale = () => {
      const bw = body.clientWidth;
      const bh = body.clientHeight;
      if (bw < 10 || bh < 10) return;
      // Subpixel rounding 때문에 일부 사이트(Naver 등) 우측 1px 정도가 잘릴 수 있다.
      // Width 에 아주 작은 안전 여유를 두고 가운데 정렬해서 clipping 을 피한다.
      const safeBw = Math.max(1, bw - 2);
      const scale = safeBw / CARD_LOGICAL_W;
      const logicalHeight = Math.max(1, Math.round(bh / scale));
      wrap.style.left = Math.max(0, Math.round((bw - safeBw) / 2)) + 'px';
      wrap.style.height = logicalHeight + 'px';
      wrap.style.transform = `scale(${scale})`;
    };
    const ro = new ResizeObserver(updateFitScale);
    ro.observe(body);
    queueMicrotask(updateFitScale);

    // ---- Card header drag (이동) ----
    let drag = null;
    header.addEventListener('mousedown', (ev) => {
      if (startPanIfNeeded(ev)) return;
      if (ev.target.closest('input, button, .egd-card-dot')) return;
      focusCard();
      drag = { x: ev.clientX, y: ev.clientY, left: card.offsetLeft, top: card.offsetTop };
      ev.preventDefault();
    });

    // ---- Resize hit zones (4변 + 4코너) ----
    let resize = null;
    const MIN_W = 320;
    const MIN_H = 250;
    const RESIZE_EDGE_X = 10;
    const RESIZE_EDGE_Y = 7;
    const RESIZE_CORNER_X = 15;
    const RESIZE_CORNER_Y = 13;
    const getResizeEdges = (ev) => {
      const rect = card.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const left = x >= 0 && x <= RESIZE_EDGE_X;
      const right = x >= rect.width - RESIZE_EDGE_X && x <= rect.width;
      const top = y >= 0 && y <= RESIZE_EDGE_Y;
      const bottom = y >= rect.height - RESIZE_EDGE_Y && y <= rect.height;
      const cornerLeft = x >= 0 && x <= RESIZE_CORNER_X;
      const cornerRight = x >= rect.width - RESIZE_CORNER_X && x <= rect.width;
      const cornerTop = y >= 0 && y <= RESIZE_CORNER_Y;
      const cornerBottom = y >= rect.height - RESIZE_CORNER_Y && y <= rect.height;
      if (cornerTop && cornerLeft) return { left: true, top: true, right: false, bottom: false };
      if (cornerTop && cornerRight) return { left: false, top: true, right: true, bottom: false };
      if (cornerBottom && cornerRight) return { left: false, top: false, right: true, bottom: true };
      if (cornerBottom && cornerLeft) return { left: true, top: false, right: false, bottom: true };
      if (!left && !right && !top && !bottom) return null;
      return { left, right, top, bottom };
    };
    const resizeCursor = (edges) => {
      if (!edges) return 'default';
      if ((edges.top && edges.left) || (edges.bottom && edges.right)) return 'nwse-resize';
      if ((edges.top && edges.right) || (edges.bottom && edges.left)) return 'nesw-resize';
      if (edges.left || edges.right) return 'ew-resize';
      if (edges.top || edges.bottom) return 'ns-resize';
      return 'default';
    };
    const updateResizeCursor = (ev) => {
      if (drag || resize) return;
      card.style.cursor = resizeCursor(getResizeEdges(ev));
    };
    const beginResize = (ev, edges) => {
      if (startPanIfNeeded(ev)) return;
      focusCard();
      resize = {
        edges,
        x: ev.clientX, y: ev.clientY,
        left: card.offsetLeft,
        top: card.offsetTop,
        w: card.offsetWidth,
        h: card.offsetHeight,
      };
      ev.preventDefault();
      ev.stopPropagation();
    };
    card.addEventListener('mousemove', updateResizeCursor);
    card.addEventListener('mouseleave', () => {
      if (!drag && !resize) card.style.cursor = 'default';
    });
    card.addEventListener('mousedown', (ev) => {
      const edges = getResizeEdges(ev);
      if (!edges) return;
      beginResize(ev, edges);
    }, true);
    for (const hit of resizeHits) {
      hit.addEventListener('mousedown', (ev) => beginResize(ev, JSON.parse(hit.dataset.edges)));
    }

    const onMove = (ev) => {
      const s = state.zoom || 1;
      if (drag) {
        card.style.left = (drag.left + (ev.clientX - drag.x) / s) + 'px';
        card.style.top  = (drag.top  + (ev.clientY - drag.y) / s) + 'px';
      } else if (resize) {
        const dx = (ev.clientX - resize.x) / s;
        const dy = (ev.clientY - resize.y) / s;
        let nextLeft = resize.left;
        let nextTop = resize.top;
        let nextWidth = resize.w;
        let nextHeight = resize.h;

        if (resize.edges.right) nextWidth = Math.max(MIN_W, resize.w + dx);
        if (resize.edges.bottom) nextHeight = Math.max(MIN_H, resize.h + dy);
        if (resize.edges.left) {
          const rawWidth = resize.w - dx;
          nextWidth = Math.max(MIN_W, rawWidth);
          nextLeft = resize.left + (resize.w - nextWidth);
        }
        if (resize.edges.top) {
          const rawHeight = resize.h - dy;
          nextHeight = Math.max(MIN_H, rawHeight);
          nextTop = resize.top + (resize.h - nextHeight);
        }

        card.style.left = nextLeft + 'px';
        card.style.top = nextTop + 'px';
        card.style.width = nextWidth + 'px';
        card.style.height = nextHeight + 'px';
        card.style.cursor = resizeCursor(resize.edges);
      }
    };
    const onUp = () => {
      drag = null;
      resize = null;
      card.style.cursor = 'default';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    card.addEventListener('mousedown', (ev) => {
      if (startPanIfNeeded(ev)) return;
      focusCard();
    });

    const cleanupCard = () => {
      if (state.codex.authCardEntityId === card.id) {
        state.codex.authCardEntityId = null;
      }
      if (state.activeEntityId === card.id) setActiveEntity(null);
      try { ro.disconnect(); } catch {}
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    console.warn(TAG, 'browser card spawned', id, initialUrl);
    card._xulBrowser = xulBrowser;
    card._wrap = wrap;
    card._cleanup = cleanupCard;
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
  function installCanvasPanZoom(viewport, layer) {
    const indicator = el('div', { id: 'egd-zoom-indicator' }, '100%');
    const marquee = el('div', { id: 'egd-selection-marquee' });
    document.documentElement.appendChild(indicator);
    document.documentElement.appendChild(marquee);
    state.panTarget = { ...state.pan };
    state.zoomTarget = state.zoom;

    const normalizeWheelDelta = (ev) => {
      if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) return 16;
      if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) return window.innerHeight;
      return 1;
    };

    function apply() {
      layer.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
      indicator.textContent = Math.round(state.zoom * 100) + '%';
    }
    let frame = 0;
    const animateToTargets = () => {
      frame = 0;
      const panDx = state.panTarget.x - state.pan.x;
      const panDy = state.panTarget.y - state.pan.y;
      const zoomDelta = state.zoomTarget - state.zoom;

      state.pan.x += panDx * PAN_SMOOTHING;
      state.pan.y += panDy * PAN_SMOOTHING;
      state.zoom += zoomDelta * ZOOM_SMOOTHING;

      const settled = Math.abs(panDx) < 0.25 && Math.abs(panDy) < 0.25 && Math.abs(zoomDelta) < 0.0015;
      if (settled) {
        state.pan.x = state.panTarget.x;
        state.pan.y = state.panTarget.y;
        state.zoom = state.zoomTarget;
      }
      apply();
      if (!settled) frame = window.requestAnimationFrame(animateToTargets);
    };
    const scheduleAnimate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(animateToTargets);
    };
    const panCanvasByWheel = (ev) => {
      const unit = normalizeWheelDelta(ev);
      state.panTarget.x -= ev.deltaX * unit * WHEEL_PAN_SPEED;
      state.panTarget.y -= ev.deltaY * unit * WHEEL_PAN_SPEED;
      scheduleAnimate();
    };
    state.panCanvasByWheel = panCanvasByWheel;
    apply();

    const shouldAllowActiveEntityScroll = (target) => {
      if (!(target instanceof Element)) return false;
      if (!state.activeEntityId) return false;
      const activeEntity = document.getElementById(state.activeEntityId);
      if (!activeEntity || !activeEntity.contains(target)) return false;
      const chatBody = activeEntity.querySelector('.egd-chat-card-body');
      if (chatBody && chatBody.contains(target)) return true;
      const body = activeEntity.querySelector('.egd-card-body');
      const capture = activeEntity.querySelector('.egd-card-body-capture');
      if (!body || !body.contains(target)) return false;
      if (target.closest('.egd-card-header, .egd-card-resize-hit')) return false;
      return !capture || capture.offsetParent === null;
    };
    const shouldAllowHudScroll = (target) => {
      if (!(target instanceof Element)) return false;
      return !!target.closest('#egd-hud');
    };
    const wheelSession = {
      owner: null,
      entityId: null,
      lastTs: 0,
      nativeActive: false,
    };
    const resetWheelSession = () => {
      wheelSession.owner = null;
      wheelSession.entityId = null;
      wheelSession.lastTs = 0;
      wheelSession.nativeActive = false;
    };
    const resolveWheelSessionOwner = (target) => {
      if (shouldAllowActiveEntityScroll(target)) {
        wheelSession.owner = 'entity';
        wheelSession.entityId = state.activeEntityId;
        return;
      }
      wheelSession.owner = 'canvas';
      wheelSession.entityId = null;
    };
    state.nativeGestureHook = (payload) => {
      if (!payload || typeof payload.kind !== 'string') return;
      if (payload.kind === 'gestureScrollBegin') {
        wheelSession.nativeActive = true;
        wheelSession.owner = null;
        wheelSession.entityId = null;
        wheelSession.lastTs = performance.now();
        return;
      }
      if (payload.kind === 'gestureScrollEnd') {
        resetWheelSession();
      }
    };
    const zoomCanvasByWheel = (ev) => {
      const unit = normalizeWheelDelta(ev);
      const delta = -ev.deltaY * unit * WHEEL_ZOOM_SPEED;
      const factor = Math.exp(delta);
      const prevZoom = state.zoomTarget;
      const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prevZoom * factor));
      if (nextZoom === prevZoom) return;
      const cx = ev.clientX;
      const cy = ev.clientY;
      const ratio = nextZoom / prevZoom;
      state.panTarget.x = cx - (cx - state.panTarget.x) * ratio;
      state.panTarget.y = cy - (cy - state.panTarget.y) * ratio;
      state.zoomTarget = nextZoom;
      scheduleAnimate();
    };

    const beginCanvasPan = (ev) => {
      setActiveEntity(null);
      pan = { x: ev.clientX, y: ev.clientY, px: state.panTarget.x, py: state.panTarget.y };
      document.documentElement.dataset.egdPanDragging = 'true';
      syncPanModeCursor();
      ev.preventDefault();
    };
    state.startCanvasPanDrag = beginCanvasPan;

    // Pan: 빈 캔버스 영역 mousedown + drag (카드 위에서는 pan 안 함)
    let pan = null;
    let marqueeSel = null;
    viewport.addEventListener('mousedown', (ev) => {
      if (ev.target !== viewport && ev.target !== layer) return;   // 카드/오버레이 클릭은 별도 처리
      if (ev.button !== 0) return;
      if (state.panModifier) {
        beginCanvasPan(ev);
        return;
      }
      setActiveEntity(null);
      marqueeSel = { x: ev.clientX, y: ev.clientY, lastX: ev.clientX, lastY: ev.clientY };
      marquee.style.display = 'block';
      marquee.style.left = ev.clientX + 'px';
      marquee.style.top = ev.clientY + 'px';
      marquee.style.width = '0px';
      marquee.style.height = '0px';
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (pan) {
        state.panTarget.x = pan.px + (ev.clientX - pan.x);
        state.panTarget.y = pan.py + (ev.clientY - pan.y);
        scheduleAnimate();
        return;
      }
      if (!marqueeSel) return;
      marqueeSel.lastX = ev.clientX;
      marqueeSel.lastY = ev.clientY;
      const left = Math.min(marqueeSel.x, marqueeSel.lastX);
      const top = Math.min(marqueeSel.y, marqueeSel.lastY);
      const width = Math.abs(marqueeSel.lastX - marqueeSel.x);
      const height = Math.abs(marqueeSel.lastY - marqueeSel.y);
      marquee.style.left = left + 'px';
      marquee.style.top = top + 'px';
      marquee.style.width = width + 'px';
      marquee.style.height = height + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (pan) {
        pan = null;
        delete document.documentElement.dataset.egdPanDragging;
        syncPanModeCursor();
      }
      if (!marqueeSel) return;
      marquee.style.display = 'none';
      const left = Math.min(marqueeSel.x, marqueeSel.lastX);
      const top = Math.min(marqueeSel.y, marqueeSel.lastY);
      const right = Math.max(marqueeSel.x, marqueeSel.lastX);
      const bottom = Math.max(marqueeSel.y, marqueeSel.lastY);
      const hasArea = Math.abs(right - left) > 4 && Math.abs(bottom - top) > 4;
      if (hasArea) {
        const hits = Array.from(document.querySelectorAll('.egd-canvas-card')).filter((card) => {
          const rect = card.getBoundingClientRect();
          return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
        });
        setSelectedEntities(hits, hits[0] || null);
      }
      marqueeSel = null;
    });

    // Global wheel capture:
    // - gesture start on active card body: native page scroll for that session
    // - gesture start anywhere else: desk pan for that session
    // - ctrl/cmd wheel or pinch: desk zoom anywhere
    document.addEventListener('wheel', (ev) => {
      const now = performance.now();
      const sessionExpired = !wheelSession.nativeActive
        && (!wheelSession.owner || (now - wheelSession.lastTs) > WHEEL_SESSION_IDLE_MS);
      if (sessionExpired || (wheelSession.nativeActive && !wheelSession.owner)) {
        resolveWheelSessionOwner(ev.target);
      }
      wheelSession.lastTs = now;
      if (ev.ctrlKey || ev.metaKey) {
        wheelSession.owner = 'canvas';
        wheelSession.entityId = null;
        zoomCanvasByWheel(ev);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (shouldAllowHudScroll(ev.target)) {
        resetWheelSession();
        return;
      }
      if (wheelSession.owner === 'entity') {
        const sessionEntityActive = wheelSession.entityId && wheelSession.entityId === state.activeEntityId;
        if (sessionEntityActive && shouldAllowActiveEntityScroll(ev.target)) return;
        // If the gesture started inside the active browser card, do not suddenly
        // switch to canvas pan mid-flight when the pointer grazes another overlay.
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      panCanvasByWheel(ev);
      ev.preventDefault();
      ev.stopPropagation();
    }, { passive: false, capture: true });

    // 리셋 단축키: Ctrl+0
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Shift') {
        state.panModifier = true;
        syncPanModeCursor();
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === '0') {
        state.panTarget = { x: 0, y: 0 };
        state.zoomTarget = 1;
        scheduleAnimate();
        ev.preventDefault();
      }
    });
    window.addEventListener('keyup', (ev) => {
      if (ev.key !== 'Shift') return;
      state.panModifier = false;
      if (!pan) delete document.documentElement.dataset.egdPanDragging;
      syncPanModeCursor();
    });
    window.addEventListener('blur', () => {
      resetWheelSession();
      state.panModifier = false;
      if (!pan) delete document.documentElement.dataset.egdPanDragging;
      syncPanModeCursor();
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
      const canvasViewport = el('div', { id: 'egd-canvas-viewport' });
      const canvasLayer = el('div', { id: 'egd-canvas-layer' });
      canvasViewport.appendChild(canvasLayer);
      host.appendChild(canvasViewport);
      installCanvasPanZoom(canvasViewport, canvasLayer);
      installNativeGestureHelperBridge();
      state.codexBridge = installCodexBridge();
      window.__egdesk = { state, codexBridge: state.codexBridge };
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
