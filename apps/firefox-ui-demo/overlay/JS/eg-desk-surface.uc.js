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
  const BROWSER_AGENT_ACTOR_NAME = 'EGDeskBrowserAgentRuntime';
  const BROWSER_AGENT_HISTORY_LIMIT = 100;
  let browserAgentActorReady = false;
  console.warn(TAG, 'loaded, readyState =', document.readyState);

  function ensureBrowserAgentActor() {
    if (browserAgentActorReady) return true;
    try {
      const { ActorManagerParent } = ChromeUtils.importESModule('resource://gre/modules/ActorManagerParent.sys.mjs');
      ActorManagerParent.addJSWindowActors({
        [BROWSER_AGENT_ACTOR_NAME]: {
          parent: {
            esModuleURI: 'chrome://userchrome/content/EGDeskBrowserAgentRuntimeParent.sys.mjs',
          },
          child: {
            esModuleURI: 'chrome://userchrome/content/EGDeskBrowserAgentRuntimeChild.sys.mjs',
            events: {
              DOMWindowCreated: {},
              DOMContentLoaded: {},
            },
          },
          allFrames: false,
        },
      });
      browserAgentActorReady = true;
      return true;
    } catch (err) {
      const message = err?.message || String(err);
      if (/already|duplicate|exists/i.test(message)) {
        browserAgentActorReady = true;
        return true;
      }
      console.warn(TAG, 'browser agent actor registration failed', err);
      return false;
    }
  }

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
    { id: 'terminal', label: '터미널',  icon: '>_' },
    { id: 'settings', label: '설정',   icon: '⚙️' },
    { id: 'create',   label: '추가',      icon: '＋' },
  ];
  const DOCK_CENTER = [
    { id: 'pencil',   label: '펜',  icon: '✎' },
    { id: 'hand',     label: '손',    icon: '✋' },
    { id: 'square',   label: '사각형',  icon: '□' },
    { id: 'ellipse',  label: '원',      icon: '○' },
    { id: 'line',     label: '선',      icon: '╱' },
    { id: 'arrow',    label: '화살표',   icon: '↖', active: true },
  ];
  const DOCK_RIGHT = [
    { id: 'trash',    label: '휴지통',   icon: '🗑' },
  ];

  const SELF_MEMBER = '나';
  const THREAD_KIND_META = {
    dm: {
      label: 'Agent',
      longLabel: 'Agent DM',
      createTitle: '새 Agent DM',
      emptyPreview: '아직 Agent DM 메시지가 없습니다',
    },
    group: {
      label: 'Agenda',
      longLabel: 'Agenda Thread',
      createTitle: '새 Agenda Thread',
      emptyPreview: '아직 Agenda 메시지가 없습니다',
    },
  };

  function codexThreadKindMeta(type) {
    return type === 'group' ? THREAD_KIND_META.group : THREAD_KIND_META.dm;
  }

  function codexThreadKindLabel(type) {
    return codexThreadKindMeta(type).label;
  }

  function codexThreadLongLabel(type) {
    return codexThreadKindMeta(type).longLabel;
  }

  function codexThreadSessionLabel(thread) {
    return thread?.conversationId ? 'Resumed' : 'Fresh';
  }

  function uniqueNames(list) {
    return Array.from(new Set((Array.isArray(list) ? list : []).filter((name) => typeof name === 'string' && name.trim())));
  }

  function buildThreadSubtitle(type, participants) {
    if (type === 'group') {
      const count = Math.max(0, participants.length);
      return `Agenda Thread · 멤버 ${count}명`;
    }
    const peer = participants.find((name) => name !== SELF_MEMBER) || 'Agent';
    return `Agent DM · ${peer}`;
  }

  function codexThreadHeaderSubtitle(thread) {
    if (!thread) return '';
    const kind = codexThreadLongLabel(thread.type);
    const session = codexThreadSessionLabel(thread);
    if (thread.type === 'group') {
      const count = Math.max(0, (thread.participants || []).length);
      return `${kind} · 멤버 ${count}명 · ${session}`;
    }
    const peer = (thread.participants || []).find((name) => name !== SELF_MEMBER) || 'Agent';
    return `${kind} · ${peer} · ${session}`;
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
      createCodexThread('group', 'EG-Desk Agenda', '', {
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
    cardFullscreen: null,
    pan: { x: 0, y: 0 },
    panTarget: { x: 0, y: 0 },
    zoom: 1,
    zoomTarget: 1,
    panCanvasByWheel: null,
    setCanvasPanTarget: null,
    setCanvasViewportTarget: null,
    startCanvasPanDrag: null,
    panModifier: false,
    nativeGestureHook: null,
    codexBridge: null,
    railSearch: {
      query: '',
      open: false,
      activeIndex: 0,
      fileQuery: '',
      fileResults: [],
      fileLoading: false,
      fileSearchSeq: 0,
      fileSearchTimer: null,
    },
    agenda: {
      activeAgendaId: 'agenda-default',
      dirty: false,
      dirtyRevision: 0,
      dirtyReasons: [],
      hasSavedState: false,
      lastSavedAt: null,
      restoreInProgress: false,
      suppressDirty: false,
      closeGuardOpen: false,
      switcherOpen: false,
      switcherQuery: '',
      switcherFilter: 'all',
      activeTitle: 'EG-Desk Agenda',
      savedAgendaIds: [],
    },
    sourceRefs: {
      cardsByKey: Object.create(null),
      defaultProfileId: 'firefox-egdesk-default',
    },
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
      return codexThreadKindMeta(thread.type).emptyPreview;
    }
    const prefix = lastMessage.role === 'user' ? '나: ' : '';
    return `${prefix}${lastMessage.content}`.slice(0, 70);
  }

  function codexThreadTypeLabel(type) {
    return codexThreadKindLabel(type);
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
      codexThreadKindLabel(thread.type),
      codexThreadLongLabel(thread.type),
      codexThreadSessionLabel(thread),
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
    if (role === 'user') return SELF_MEMBER;
    if (role === 'assistant') return 'Codex';
    if (role === 'system') return 'System';
    return role || '메시지';
  }

  function codexReadMeta(message, thread) {
    if (!message || message.role !== 'user') return '';
    const readBy = Array.isArray(message.readBy) ? message.readBy : [];
    const others = readBy.filter((name) => name !== SELF_MEMBER);
    const peers = Array.isArray(thread?.participants)
      ? thread.participants.filter((name) => name !== SELF_MEMBER)
      : [];
    const unreadCount = Math.max(0, peers.length - others.length);
    if (unreadCount === 0) return null;
    return el('span', {
      class: 'egd-codex-bubble-read',
      title: unreadCount === 1 ? '1명 안 읽음' : `${unreadCount}명 안 읽음`,
      'aria-label': unreadCount === 1 ? '1명 안 읽음' : `${unreadCount}명 안 읽음`,
    }, String(unreadCount));
  }

  function codexMessageTimeMeta(message, thread) {
    const children = [];
    if (message?.role === 'user') {
      const readMeta = codexReadMeta(message, thread);
      if (readMeta) children.push(readMeta);
    }
    if (message?.createdAt) {
      children.push(el('span', { class: 'egd-codex-message-time' }, formatMessageTime(message.createdAt)));
    }
    if (children.length === 0) return null;
    return el('div', { class: 'egd-codex-message-meta' }, ...children);
  }

  function codexResultChipKind(label) {
    const normalized = String(label || '').trim().toLowerCase();
    if (/^(run|plan|action|context)$/.test(normalized)) return 'run';
    if (/run|plan|action|context/.test(normalized)) return 'run';
    return 'result';
  }

  function codexResultChipLabel(link) {
    if (!link) return '';
    if (typeof link === 'string') return link.trim();
    return String(link.label || link.title || link.name || '').trim();
  }

  function extractCodexResultLinks(message) {
    const explicit = Array.isArray(message?.resultLinks)
      ? message.resultLinks.map((link) => ({
          ...(typeof link === 'object' && link ? link : {}),
          label: codexResultChipLabel(link),
        })).filter((link) => link.label)
      : [];

    let text = String(message?.content || '');
    const inferred = [];
    text = text.replace(/\[([^\]\n]{2,40})\]/g, (raw, label) => {
      const trimmed = label.trim();
      if (!/(card|deck|report|evidence|notes|file|canvas|ppt|excel|run|plan|action|context)/i.test(trimmed)) {
        return raw;
      }
      inferred.push({ label: trimmed });
      return '';
    });

    return {
      text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
      links: [...explicit, ...inferred],
    };
  }

  function openCodexResultLink(link, message, thread) {
    if (link?.url) {
      openUrlInBrowserCard(link.url);
      return;
    }
    if (link?.cardId) {
      const card = document.getElementById(link.cardId);
      if (card) {
        focusCanvasCard(card);
        return;
      }
    }
    console.warn(TAG, 'result chip has no canvas binding yet', {
      label: link?.label,
      messageId: message?.id,
      threadId: thread?.id,
    });
  }

  function buildCodexResultChips(message, thread, links) {
    if (!Array.isArray(links) || links.length === 0) return null;
    return el('div', { class: 'egd-codex-result-chips' },
      ...links.map((link) => {
        const label = codexResultChipLabel(link);
        const kind = codexResultChipKind(label);
        return el('button', {
          class: `egd-codex-result-chip egd-codex-result-chip-${kind}`,
          title: kind === 'run' ? 'Run detail' : 'Canvas result',
          onclick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openCodexResultLink(link, message, thread);
          },
        }, label);
      }),
    );
  }
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 4.5;
  const WHEEL_PAN_SPEED = 1.15;
  const WHEEL_ZOOM_SPEED = 0.0044;
  const PAN_SMOOTHING = 0.24;
  const ZOOM_SMOOTHING = 0.22;
  const WHEEL_SESSION_IDLE_MS = 140;
  const AGENDA_STORAGE_PREF = 'egdesk.agendaState.v1';

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

  function normalizeSourcePart(value) {
    return encodeURIComponent(String(value ?? '').trim());
  }

  function normalizeBrowserUri(rawUrl = 'https://duckduckgo.com') {
    let url = String(rawUrl || '').trim() || 'https://duckduckgo.com';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      url = /^[\w-]+(\.[\w-]+)+/.test(url)
        ? 'https://' + url
        : 'https://duckduckgo.com/?q=' + encodeURIComponent(url);
    }
    try {
      const parsed = new URL(url);
      parsed.hostname = parsed.hostname.toLowerCase();
      if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) {
        parsed.port = '';
      }
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return url;
    }
  }

  function browserDisplayHost(url) {
    try {
      const parsed = new URL(String(url || ''));
      if (parsed.protocol === 'file:') return parsed.pathname.split('/').filter(Boolean).pop() || 'Local file';
      if (parsed.protocol === 'about:') return parsed.href;
      if (parsed.hostname) return parsed.hostname.replace(/^www\./, '');
      return parsed.href;
    } catch {
      return String(url || 'Browser');
    }
  }

  function browserSecurityLabel(url) {
    try {
      const parsed = new URL(String(url || ''));
      if (parsed.protocol === 'https:') return 'Secure';
      if (parsed.protocol === 'http:') return 'Not secure';
      if (parsed.protocol === 'file:') return 'Local';
      if (parsed.protocol === 'about:') return 'Firefox';
      return parsed.protocol.replace(':', '') || 'Site';
    } catch {
      return 'Site';
    }
  }

  function browserSecurityGlyph(url) {
    const label = browserSecurityLabel(url);
    if (label === 'Secure') return '✓';
    if (label === 'Not secure') return '!';
    if (label === 'Local') return 'F';
    if (label === 'Firefox') return 'Fx';
    return 'W';
  }

  function copyTextToClipboard(text) {
    const value = String(text || '');
    try {
      const helper = (globalThis.Cc || Components.classes)['@mozilla.org/widget/clipboardhelper;1']
        .getService((globalThis.Ci || Components.interfaces).nsIClipboardHelper);
      helper.copyString(value);
      return true;
    } catch {}
    try {
      navigator.clipboard?.writeText?.(value);
      return true;
    } catch {}
    return false;
  }

  function sourceRefKey(sourceRef) {
    if (!sourceRef || !sourceRef.kind) return '';
    const parts = [
      sourceRef.kind,
      sourceRef.scope || '',
      sourceRef.profileId || '',
      sourceRef.accountId || '',
      sourceRef.uri || sourceRef.path || sourceRef.id || '',
    ];
    return parts.map(normalizeSourcePart).join('|');
  }

  function makeSourceRef(kind, fields = {}) {
    return {
      kind,
      scope: fields.scope || state.agenda.activeAgendaId,
      ...fields,
    };
  }

  function browserSourceRef(url, fields = {}) {
    return makeSourceRef('browser-url', {
      uri: normalizeBrowserUri(url),
      profileId: fields.profileId || state.sourceRefs.defaultProfileId,
      accountId: fields.accountId || '',
      scope: fields.scope || 'browser-content',
    });
  }

  function singletonSourceRef(id, fields = {}) {
    return makeSourceRef(fields.kind || 'singleton', {
      id,
      scope: fields.scope || 'egdesk-runtime',
    });
  }

  function currentChatSourceRef() {
    return makeSourceRef('chat-surface', {
      id: 'codex-chat',
      scope: 'codex',
    });
  }

  function registerSourceRefCard(card) {
    const key = sourceRefKey(card?._sourceRef);
    if (!key || !card?.id) return;
    state.sourceRefs.cardsByKey[key] = card.id;
    card.dataset.sourceKind = card._sourceRef.kind;
    card.dataset.sourceKey = key;
  }

  function unregisterSourceRefCard(card) {
    const key = card?.dataset?.sourceKey || sourceRefKey(card?._sourceRef);
    if (!key) return;
    if (state.sourceRefs.cardsByKey[key] === card.id) {
      delete state.sourceRefs.cardsByKey[key];
    }
  }

  function bindCardSourceRef(card, sourceRef) {
    if (!card || !sourceRef) return card;
    unregisterSourceRefCard(card);
    const normalized = { ...sourceRef, key: sourceRefKey(sourceRef) };
    card._sourceRef = normalized;
    registerSourceRefCard(card);
    return card;
  }

  function findOpenCardBySourceRef(sourceRef) {
    const key = sourceRefKey(sourceRef);
    if (!key) return null;
    const mappedId = state.sourceRefs.cardsByKey[key];
    const mappedCard = mappedId ? document.getElementById(mappedId) : null;
    if (mappedCard?.isConnected) return mappedCard;
    if (mappedId) delete state.sourceRefs.cardsByKey[key];
    const fallback = Array.from(document.querySelectorAll('.egd-canvas-card')).find((card) => card.dataset.sourceKey === key);
    if (fallback?.isConnected) {
      state.sourceRefs.cardsByKey[key] = fallback.id;
      return fallback;
    }
    return null;
  }

  function focusOpenSourceCard(sourceRef) {
    const existing = findOpenCardBySourceRef(sourceRef);
    if (!existing) return null;
    focusCanvasCard(existing);
    return existing;
  }

  function normalizeOpenMode(openMode, fallback = 'new') {
    return openMode === 'focus-existing' ? 'focus-existing' : fallback;
  }

  function servicesRef() {
    if (globalThis.Services) return globalThis.Services;
    return ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
  }

  function readAgendaStore() {
    try {
      const raw = servicesRef().prefs.getStringPref(AGENDA_STORAGE_PREF, '');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      console.warn(TAG, 'agenda store read failed', error);
      return null;
    }
  }

  function writeAgendaStore(snapshot) {
    try {
      servicesRef().prefs.setStringPref(AGENDA_STORAGE_PREF, JSON.stringify(snapshot));
      return true;
    } catch (error) {
      console.warn(TAG, 'agenda store write failed', error);
      return false;
    }
  }

  function createEmptyAgendaStore() {
    return {
      version: 2,
      updatedAt: Date.now(),
      activeAgendaId: state.agenda.activeAgendaId,
      agendas: {},
      meta: {},
    };
  }

  function coerceAgendaStore(raw = readAgendaStore()) {
    if (!raw) return createEmptyAgendaStore();
    if (raw.version === 2 && raw.agendas && typeof raw.agendas === 'object') {
      return {
        version: 2,
        updatedAt: raw.updatedAt || Date.now(),
        activeAgendaId: raw.activeAgendaId || state.agenda.activeAgendaId,
        agendas: raw.agendas || {},
        meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
      };
    }
    if (raw.agenda?.id) {
      const id = raw.agenda.id;
      return {
        version: 2,
        updatedAt: raw.savedAt || Date.now(),
        activeAgendaId: id,
        agendas: { [id]: raw },
        meta: {
          [id]: {
            id,
            title: raw.agenda.title || 'EG-Desk Agenda',
            createdAt: raw.savedAt || Date.now(),
            updatedAt: raw.savedAt || Date.now(),
          },
        },
      };
    }
    return createEmptyAgendaStore();
  }

  function activeAgendaSnapshotFromStore(store = coerceAgendaStore()) {
    return store.agendas?.[store.activeAgendaId || state.agenda.activeAgendaId] || null;
  }

  function updateAgendaMetaFromStore(store = coerceAgendaStore()) {
    const activeId = store.activeAgendaId || state.agenda.activeAgendaId;
    const activeSnapshot = store.agendas?.[activeId] || null;
    const activeMeta = store.meta?.[activeId] || null;
    state.agenda.activeAgendaId = activeId;
    state.agenda.activeTitle = activeSnapshot?.agenda?.title || activeMeta?.title || state.agenda.activeTitle || 'EG-Desk Agenda';
    state.agenda.savedAgendaIds = Object.keys(store.agendas || {});
    state.agenda.hasSavedState = !!activeSnapshot;
    state.agenda.lastSavedAt = activeSnapshot?.savedAt || activeMeta?.updatedAt || null;
    return activeSnapshot;
  }

  function writeAgendaStoreAndSync(store) {
    const nextStore = {
      ...createEmptyAgendaStore(),
      ...store,
      version: 2,
      updatedAt: Date.now(),
      agendas: store?.agendas || {},
      meta: store?.meta || {},
    };
    if (!writeAgendaStore(nextStore)) return false;
    updateAgendaMetaFromStore(nextStore);
    return true;
  }

  function ensureAgendaMeta(store, agendaId, fallback = {}) {
    if (!agendaId) return null;
    const snapshot = store.agendas?.[agendaId] || null;
    const meta = store.meta?.[agendaId] || {};
    const now = Date.now();
    const nextMeta = {
      ...meta,
      id: agendaId,
      title: fallback.title || snapshot?.agenda?.title || meta.title || 'Agenda',
      createdAt: meta.createdAt || snapshot?.savedAt || fallback.createdAt || now,
      updatedAt: meta.updatedAt || snapshot?.savedAt || fallback.updatedAt || now,
    };
    store.meta[agendaId] = nextMeta;
    return nextMeta;
  }

  function clearAgendaStore() {
    try {
      const prefs = servicesRef().prefs;
      if (prefs.prefHasUserValue(AGENDA_STORAGE_PREF)) prefs.clearUserPref(AGENDA_STORAGE_PREF);
    } catch (error) {
      console.warn(TAG, 'agenda store clear failed', error);
    }
    state.agenda.hasSavedState = false;
    state.agenda.lastSavedAt = null;
    state.agenda.savedAgendaIds = [];
    syncViewportAgendaRail();
  }

  function loadAgendaStoreMeta() {
    const store = coerceAgendaStore();
    return updateAgendaMetaFromStore(store);
  }

  function cleanSourceRef(sourceRef) {
    if (!sourceRef) return null;
    const cleaned = { ...sourceRef };
    delete cleaned.key;
    return cleaned;
  }

  function parsePxNumber(value, fallback = 0) {
    const parsed = Number.parseFloat(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function persistentEntityGeometry(entity) {
    const fullscreenRect = entity?.id && state.cardFullscreen?.cardId === entity.id
      ? state.cardFullscreen.rect
      : null;
    return {
      x: Math.round(parsePxNumber(fullscreenRect?.left ?? entity.style.left, entity.offsetLeft || 0)),
      y: Math.round(parsePxNumber(fullscreenRect?.top ?? entity.style.top, entity.offsetTop || 0)),
      width: Math.round(Math.max(12, parsePxNumber(fullscreenRect?.width ?? entity.style.width, entity.offsetWidth || 12))),
      height: Math.round(Math.max(12, parsePxNumber(fullscreenRect?.height ?? entity.style.height, entity.offsetHeight || 12))),
      zIndex: Math.round(parsePxNumber(fullscreenRect?.zIndex ?? entity.style.zIndex, 0)),
    };
  }

  function applyPersistentEntityGeometry(entity, geometry = {}) {
    if (!entity || !geometry) return;
    if (Number.isFinite(geometry.x)) entity.style.left = Math.round(geometry.x) + 'px';
    if (Number.isFinite(geometry.y)) entity.style.top = Math.round(geometry.y) + 'px';
    if (Number.isFinite(geometry.width)) entity.style.width = Math.max(12, Math.round(geometry.width)) + 'px';
    if (Number.isFinite(geometry.height)) entity.style.height = Math.max(12, Math.round(geometry.height)) + 'px';
    if (Number.isFinite(geometry.zIndex)) {
      entity.style.zIndex = String(Math.round(geometry.zIndex));
      cardZ = Math.max(cardZ, Math.round(geometry.zIndex));
    }
  }

  function cardKindForPersistence(card) {
    if (card.classList.contains('egd-browser-card')) return 'browser';
    if (card.classList.contains('egd-terminal-card')) return 'terminal';
    if (card.classList.contains('egd-settings-card')) return 'settings';
    if (card.classList.contains('egd-chat-card')) return 'chat';
    return 'card';
  }

  function runtimeStateForCard(card, type) {
    if (type === 'browser') {
      return {
        uri: normalizeBrowserUri(card._browserState?.uri || card.querySelector('.egd-card-url')?.value || card._sourceRef?.uri || 'https://duckduckgo.com'),
        title: card._browserState?.title || '',
      };
    }
    if (type === 'chat') {
      return {
        activeThreadId: state.codex.activeThreadId || null,
        chatDockMode: state.codex.chatDockMode || 'canvas',
      };
    }
    return {};
  }

  function serializeCardState(card) {
    if (!card || !card.isConnected || card.dataset.codexRole === 'auth') return null;
    const type = cardKindForPersistence(card);
    if (type === 'card') return null;
    return {
      id: card.id,
      type,
      geometry: persistentEntityGeometry(card),
      sourceRef: cleanSourceRef(card._sourceRef),
      runtimeState: runtimeStateForCard(card, type),
    };
  }

  function serializeShapeState(shape) {
    if (!shape || !shape.isConnected) return null;
    const geometry = persistentEntityGeometry(shape);
    return {
      id: shape.id,
      type: shape.dataset.shapeType || 'rect',
      geometry,
      sourceRef: cleanSourceRef(shape._sourceRef),
      runtimeState: {
        transform: shape.style.transform || '',
        x1: shape.dataset.x1 || null,
        y1: shape.dataset.y1 || null,
        x2: shape.dataset.x2 || null,
        y2: shape.dataset.y2 || null,
      },
    };
  }

  function serializeAgendaSnapshot() {
    return {
      version: 1,
      savedAt: Date.now(),
      desk: {
        pan: { ...state.panTarget },
        zoom: state.zoomTarget,
        activeAgendaId: state.agenda.activeAgendaId,
        activeCardId: state.activeEntityId,
      },
      agenda: {
        id: state.agenda.activeAgendaId,
        title: currentViewportAgendaLabel(),
        memberCardIds: Array.from(document.querySelectorAll('.egd-canvas-card')).map((card) => card.id),
        contextBindings: [],
      },
      cards: Array.from(document.querySelectorAll('.egd-canvas-card'))
        .map(serializeCardState)
        .filter(Boolean),
      shapes: Array.from(document.querySelectorAll('.egd-canvas-shape'))
        .map(serializeShapeState)
        .filter(Boolean),
    };
  }

  function retargetRestoredEntityId(entity, savedId) {
    if (!entity || !savedId) return;
    unregisterSourceRefCard(entity);
    if (!document.getElementById(savedId) || entity.id === savedId) {
      entity.id = savedId;
    }
    const suffix = String(entity.id || '').match(/-(\d+)$/);
    if (suffix) cardSeq = Math.max(cardSeq, Number(suffix[1]));
    if (entity.classList.contains('egd-chat-card')) state.codex.chatCardEntityId = entity.id;
  }

  function clearCanvasEntitiesForRestore() {
    if (state.cardFullscreen) exitCardFullscreen(null, { restoreRect: false });
    for (const card of Array.from(document.querySelectorAll('.egd-canvas-card'))) {
      unregisterSourceRefCard(card);
      try { if (typeof card._cleanup === 'function') card._cleanup(); } catch {}
      card.remove();
    }
    for (const shape of Array.from(document.querySelectorAll('.egd-canvas-shape'))) {
      try { if (typeof shape._cleanup === 'function') shape._cleanup(); } catch {}
      shape.remove();
    }
    state.sourceRefs.cardsByKey = Object.create(null);
    state.activeEntityId = null;
    state.codex.chatCardEntityId = null;
    state.codex.chatDockMode = 'hud';
  }

  function restoreCardFromState(cardState) {
    if (!cardState?.type) return null;
    let card = null;
    const runtime = cardState.runtimeState || {};
    if (cardState.type === 'browser') {
      card = spawnBrowserCard(runtime.uri || cardState.sourceRef?.uri || 'https://duckduckgo.com', {
        openMode: 'new',
        sourceRef: cardState.sourceRef || {},
      });
    } else if (cardState.type === 'settings') {
      card = spawnSettingsCard();
    } else if (cardState.type === 'chat') {
      card = spawnCodexChatCard();
    } else if (cardState.type === 'terminal') {
      card = spawnTerminalCard();
    }
    if (!card) return null;
    retargetRestoredEntityId(card, cardState.id);
    if (cardState.sourceRef) bindCardSourceRef(card, cardState.sourceRef);
    applyPersistentEntityGeometry(card, cardState.geometry);
    return card;
  }

  function restoreShapeFromState(shapeState) {
    const shape = createCanvasShape(shapeState?.type || 'rect');
    retargetRestoredEntityId(shape, shapeState?.id);
    if (shapeState?.sourceRef) shape._sourceRef = shapeState.sourceRef;
    applyPersistentEntityGeometry(shape, shapeState?.geometry);
    if (shapeState?.runtimeState?.transform) shape.style.transform = shapeState.runtimeState.transform;
    for (const key of ['x1', 'y1', 'x2', 'y2']) {
      if (shapeState?.runtimeState?.[key] != null) shape.dataset[key] = shapeState.runtimeState[key];
    }
    const host = document.getElementById('egd-canvas-layer') || document.documentElement;
    host.appendChild(shape);
    return shape;
  }

  function restoreAgendaSnapshot(snapshot, options = {}) {
    if (!snapshot?.agenda?.id) return false;
    state.agenda.restoreInProgress = true;
    state.agenda.suppressDirty = true;
    try {
      clearCanvasEntitiesForRestore();
      for (const cardState of snapshot.cards || []) restoreCardFromState(cardState);
      for (const shapeState of snapshot.shapes || []) restoreShapeFromState(shapeState);
      state.agenda.activeAgendaId = snapshot.agenda.id || state.agenda.activeAgendaId;
      state.agenda.activeTitle = snapshot.agenda.title || state.agenda.activeTitle || 'EG-Desk Agenda';
      state.agenda.hasSavedState = true;
      state.agenda.lastSavedAt = snapshot.savedAt || Date.now();
      if (snapshot.desk?.pan && typeof state.setCanvasViewportTarget === 'function') {
        state.setCanvasViewportTarget({
          pan: snapshot.desk.pan,
          zoom: Number.isFinite(snapshot.desk.zoom) ? snapshot.desk.zoom : state.zoomTarget,
        }, { immediate: true });
      }
      const active = snapshot.desk?.activeCardId ? document.getElementById(snapshot.desk.activeCardId) : null;
      if (active) setActiveEntity(active);
      if (options.markClean !== false) {
        state.agenda.dirty = false;
        state.agenda.dirtyReasons = [];
      }
      syncViewportAgendaRail();
      refreshDeskMinimap();
      return true;
    } finally {
      state.agenda.restoreInProgress = false;
      state.agenda.suppressDirty = false;
    }
  }

  function saveCurrentAgendaState() {
    const snapshot = serializeAgendaSnapshot();
    const store = coerceAgendaStore();
    const agendaId = snapshot.agenda.id;
    store.activeAgendaId = agendaId;
    store.agendas[agendaId] = snapshot;
    store.meta[agendaId] = {
      id: agendaId,
      title: snapshot.agenda.title || currentViewportAgendaLabel(),
      createdAt: store.meta[agendaId]?.createdAt || snapshot.savedAt,
      updatedAt: snapshot.savedAt,
      lastOpenedAt: store.meta[agendaId]?.lastOpenedAt || Date.now(),
      closedAt: null,
    };
    if (!writeAgendaStoreAndSync(store)) return null;
    state.agenda.dirty = false;
    state.agenda.dirtyReasons = [];
    state.agenda.hasSavedState = true;
    state.agenda.lastSavedAt = snapshot.savedAt;
    syncViewportAgendaRail();
    return snapshot;
  }

  function restoreSavedAgendaState(options = {}) {
    const store = coerceAgendaStore();
    const snapshot = activeAgendaSnapshotFromStore(store);
    if (!snapshot) return false;
    return restoreAgendaSnapshot(snapshot, { markClean: options.markClean !== false });
  }

  function closeAgendaCloseGuard() {
    document.getElementById('egd-agenda-close-guard')?.remove();
    state.agenda.closeGuardOpen = false;
  }

  function clearCurrentAgendaView(options = {}) {
    state.agenda.suppressDirty = true;
    try {
      clearCanvasEntitiesForRestore();
      if (options.markClean !== false) {
        state.agenda.dirty = false;
        state.agenda.dirtyReasons = [];
      }
    } finally {
      state.agenda.suppressDirty = false;
    }
    syncViewportAgendaRail();
    refreshDeskMinimap();
  }

  function completeAgendaClose({ saveFirst = false } = {}) {
    if (saveFirst && !saveCurrentAgendaState()) return false;
    markAgendaClosed();
    closeAgendaCloseGuard();
    clearCurrentAgendaView({ markClean: true });
    return true;
  }

  function showAgendaCloseGuard() {
    const existing = document.getElementById('egd-agenda-close-guard');
    if (existing) {
      existing.querySelector('[data-action="continue"]')?.focus?.();
      return false;
    }
    state.agenda.closeGuardOpen = true;
    const dirtyCount = state.agenda.dirtyReasons.length;
    const dirtyText = dirtyCount > 1
      ? `${dirtyCount}개의 변경사항이 아직 저장되지 않았습니다.`
      : '저장되지 않은 변경사항이 있습니다.';

    const dialog = el('div', {
      id: 'egd-agenda-close-guard',
      class: 'egd-agenda-close-guard',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'egd-agenda-close-title',
      tabindex: '-1',
      onclick: (ev) => {
        if (ev.target === dialog) closeAgendaCloseGuard();
      },
      onkeydown: (ev) => {
        if (ev.key === 'Escape') {
          closeAgendaCloseGuard();
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
    },
      el('div', { class: 'egd-agenda-close-panel' },
        el('div', { class: 'egd-agenda-close-kicker' }, currentViewportAgendaLabel()),
        el('div', { id: 'egd-agenda-close-title', class: 'egd-agenda-close-title' }, 'Agenda를 닫을까요?'),
        el('div', { class: 'egd-agenda-close-copy' }, dirtyText),
        el('div', { class: 'egd-agenda-close-actions' },
          el('button', {
            class: 'egd-agenda-close-btn egd-agenda-close-btn-ghost',
            data: { action: 'continue' },
            onclick: (ev) => {
              ev.stopPropagation();
              closeAgendaCloseGuard();
              closeAgendaSwitcher();
            },
          }, '계속 작업'),
          el('button', {
            class: 'egd-agenda-close-btn egd-agenda-close-btn-danger',
            data: { action: 'discard' },
            onclick: (ev) => {
              ev.stopPropagation();
              completeAgendaClose({ saveFirst: false });
            },
          }, '버리고 닫기'),
          el('button', {
            class: 'egd-agenda-close-btn egd-agenda-close-btn-primary',
            data: { action: 'save' },
            onclick: (ev) => {
              ev.stopPropagation();
              completeAgendaClose({ saveFirst: true });
            },
          }, '저장 후 닫기'),
        ),
      ),
    );
    document.documentElement.appendChild(dialog);
    dialog.focus();
    return false;
  }

  function closeCurrentAgenda(options = {}) {
    if (state.agenda.dirty && options.force !== true) return showAgendaCloseGuard();
    markAgendaClosed();
    clearCurrentAgendaView({ markClean: true });
    return true;
  }

  function agendaCardCountForSnapshot(snapshot) {
    return (snapshot?.cards?.length || 0) + (snapshot?.shapes?.length || 0);
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeAgendaTitle(title, fallback = 'Agenda') {
    const cleaned = String(title || '').replace(/\s+/g, ' ').trim();
    return cleaned || fallback;
  }

  function newAgendaId(prefix = 'agenda') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  function markAgendaOpened(agendaId = state.agenda.activeAgendaId) {
    if (!agendaId) return false;
    const store = coerceAgendaStore();
    if (!store.agendas?.[agendaId] && !store.meta?.[agendaId]) return false;
    const meta = ensureAgendaMeta(store, agendaId);
    meta.lastOpenedAt = Date.now();
    meta.closedAt = null;
    store.activeAgendaId = agendaId;
    return writeAgendaStoreAndSync(store);
  }

  function markAgendaClosed(agendaId = state.agenda.activeAgendaId) {
    if (!agendaId) return false;
    const store = coerceAgendaStore();
    if (!store.agendas?.[agendaId] && !store.meta?.[agendaId]) return false;
    const meta = ensureAgendaMeta(store, agendaId, { title: currentViewportAgendaLabel() });
    meta.closedAt = Date.now();
    meta.updatedAt = Math.max(meta.updatedAt || 0, meta.closedAt);
    return writeAgendaStoreAndSync(store);
  }

  function renameAgenda(agendaId, nextTitle) {
    if (!agendaId) return false;
    const store = coerceAgendaStore();
    const snapshot = store.agendas?.[agendaId] || null;
    const fallbackTitle = snapshot?.agenda?.title || store.meta?.[agendaId]?.title || 'Agenda';
    const title = normalizeAgendaTitle(nextTitle, fallbackTitle);
    store.meta[agendaId] = {
      ...(store.meta[agendaId] || {}),
      id: agendaId,
      title,
      createdAt: store.meta[agendaId]?.createdAt || snapshot?.savedAt || Date.now(),
      updatedAt: Date.now(),
    };
    if (snapshot?.agenda) {
      snapshot.agenda.title = title;
      snapshot.savedAt = Date.now();
      store.agendas[agendaId] = snapshot;
    }
    if (agendaId === state.agenda.activeAgendaId) state.agenda.activeTitle = title;
    const ok = writeAgendaStoreAndSync(store);
    syncViewportAgendaRail();
    return ok ? title : false;
  }

  function renameAgendaWithPrompt(agendaId) {
    const entry = agendaListEntries().find((item) => item.id === agendaId);
    const nextTitle = window.prompt('Agenda 이름', entry?.title || 'Agenda');
    if (nextTitle == null) return false;
    return renameAgenda(agendaId, nextTitle);
  }

  function duplicateAgenda(agendaId = state.agenda.activeAgendaId, options = {}) {
    const store = coerceAgendaStore();
    const sourceSnapshot = agendaId === state.agenda.activeAgendaId
      ? serializeAgendaSnapshot()
      : store.agendas?.[agendaId];
    if (!sourceSnapshot) return null;
    const sourceTitle = sourceSnapshot.agenda?.title || store.meta?.[agendaId]?.title || 'Agenda';
    const newId = newAgendaId('agenda-copy');
    const newTitle = normalizeAgendaTitle(options.title, `${sourceTitle} Copy`);
    const shouldActivate = options.activate !== false;
    const snapshot = cloneJson(sourceSnapshot);
    snapshot.savedAt = Date.now();
    snapshot.desk = {
      ...(snapshot.desk || {}),
      activeAgendaId: newId,
    };
    snapshot.agenda = {
      ...(snapshot.agenda || {}),
      id: newId,
      title: newTitle,
    };
    store.agendas[newId] = snapshot;
    store.meta[newId] = {
      id: newId,
      title: newTitle,
      createdAt: snapshot.savedAt,
      updatedAt: snapshot.savedAt,
      lastOpenedAt: shouldActivate ? Date.now() : null,
      closedAt: shouldActivate ? null : Date.now(),
      duplicatedFrom: agendaId,
    };
    if (shouldActivate) store.activeAgendaId = newId;
    if (!writeAgendaStoreAndSync(store)) return null;
    if (shouldActivate) {
      state.agenda.dirty = false;
      state.agenda.dirtyReasons = [];
      restoreAgendaSnapshot(snapshot);
    } else {
      syncViewportAgendaRail();
    }
    return newId;
  }

  function deleteAgenda(agendaId = state.agenda.activeAgendaId, options = {}) {
    if (!agendaId) return false;
    const store = coerceAgendaStore();
    const isActive = agendaId === state.agenda.activeAgendaId;
    if (isActive && state.agenda.dirty && options.force !== true) {
      return showAgendaTransitionGuard({
        title: 'Agenda 삭제',
        heading: 'Agenda를 삭제할까요?',
        discardLabel: '버리고 삭제',
        saveLabel: '저장 후 삭제',
        onSave: () => {
          deleteAgenda(agendaId, { force: true });
        },
        onDiscard: () => deleteAgenda(agendaId, { force: true }),
      });
    }
    delete store.agendas[agendaId];
    delete store.meta[agendaId];

    if (isActive) {
      const nextId = Object.keys(store.agendas || {})[0] || Object.keys(store.meta || {})[0] || null;
      if (nextId) {
        store.activeAgendaId = nextId;
        writeAgendaStoreAndSync(store);
        return switchAgenda(nextId, { force: true });
      }
      const freshId = newAgendaId();
      store.activeAgendaId = freshId;
      store.meta[freshId] = {
        id: freshId,
        title: 'EG-Desk Agenda',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastOpenedAt: Date.now(),
        closedAt: null,
      };
      writeAgendaStoreAndSync(store);
      state.agenda.activeAgendaId = freshId;
      state.agenda.activeTitle = 'EG-Desk Agenda';
      state.agenda.dirty = false;
      state.agenda.dirtyReasons = [];
      clearCurrentAgendaView({ markClean: true });
    } else {
      if (store.activeAgendaId === agendaId) store.activeAgendaId = state.agenda.activeAgendaId;
      writeAgendaStoreAndSync(store);
    }
    syncViewportAgendaRail();
    return true;
  }

  function agendaEntryStatus(entry) {
    if (entry.dirty) return 'Unsaved';
    if (entry.closed) return 'Closed';
    if (entry.current) return 'Current';
    if (entry.saved) return 'Saved';
    return 'Draft';
  }

  function agendaEntryMatchesFilter(entry, filter = state.agenda.switcherFilter) {
    if (filter === 'recent') return !!(entry.lastOpenedAt || entry.updatedAt);
    if (filter === 'closed') return !!entry.closed;
    return true;
  }

  function agendaEntryMatchesQuery(entry, query = state.agenda.switcherQuery) {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return true;
    return [
      entry.title,
      entry.id,
      agendaEntryStatus(entry),
      entry.closed ? 'closed 닫힘' : '',
      entry.current ? 'current 현재' : '',
    ].join(' ').toLowerCase().includes(normalized);
  }

  function agendaListEntries(options = {}) {
    const store = coerceAgendaStore();
    const filter = options.filter ?? state.agenda.switcherFilter ?? 'all';
    const query = options.query ?? state.agenda.switcherQuery ?? '';
    const ids = new Set([
      state.agenda.activeAgendaId,
      store.activeAgendaId,
      ...Object.keys(store.meta || {}),
      ...Object.keys(store.agendas || {}),
    ].filter(Boolean));
    return Array.from(ids).map((id) => {
      const snapshot = store.agendas?.[id] || null;
      const meta = store.meta?.[id] || null;
      const current = id === state.agenda.activeAgendaId;
      const updatedAt = snapshot?.savedAt || meta?.updatedAt || meta?.createdAt || null;
      const lastOpenedAt = meta?.lastOpenedAt || null;
      const closedAt = meta?.closedAt || null;
      const liveCount = current
        ? document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').length
        : 0;
      return {
        id,
        title: current
          ? currentViewportAgendaLabel()
          : snapshot?.agenda?.title || meta?.title || id,
        current,
        saved: !!snapshot,
        dirty: current && state.agenda.dirty,
        closed: !!closedAt,
        count: snapshot ? agendaCardCountForSnapshot(snapshot) : liveCount,
        updatedAt,
        lastOpenedAt,
        closedAt,
        activityAt: Math.max(updatedAt || 0, lastOpenedAt || 0, closedAt || 0),
      };
    }).filter((entry) => (
      agendaEntryMatchesFilter(entry, filter) && agendaEntryMatchesQuery(entry, query)
    )).sort((a, b) => {
      if (a.current) return -1;
      if (b.current) return 1;
      return (b.activityAt || 0) - (a.activityAt || 0);
    });
  }

  function agendaFilterCounts() {
    return {
      all: agendaListEntries({ filter: 'all', query: '' }).length,
      recent: agendaListEntries({ filter: 'recent', query: '' }).length,
      closed: agendaListEntries({ filter: 'closed', query: '' }).length,
    };
  }

  function railSearchQuery(value = state.railSearch.query) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function railSearchMatches(query, parts) {
    const q = railSearchQuery(query).toLowerCase();
    if (!q) return true;
    return parts
      .filter(Boolean)
      .some((part) => String(part).toLowerCase().includes(q));
  }

  function railSearchBrowserUrl(query) {
    const q = railSearchQuery(query);
    return q ? normalizeBrowserUri(q) : '';
  }

  function railSearchLooksLikeNavigation(query) {
    const q = railSearchQuery(query);
    return /^[a-z][a-z0-9+.-]*:/i.test(q) || /^[\w-]+(\.[\w-]+)+([/:?#].*)?$/i.test(q);
  }

  function railSearchPathToFileUrl(path, isDirectory = false) {
    const normalized = String(path || '').replace(/\/+$/, '');
    const encoded = normalized.split('/').map((part) => encodeURIComponent(part)).join('/');
    return `file://${encoded}${isDirectory ? '/' : ''}`;
  }

  function railSearchNsFileFromPath(path) {
    try {
      const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      return file;
    } catch {
      return null;
    }
  }

  function railSearchDirsvcPath(key) {
    try {
      return servicesRef().dirsvc.get(key, Ci.nsIFile).path;
    } catch {
      return null;
    }
  }

  function railSearchFileRoots() {
    const home = railSearchDirsvcPath('Home');
    const candidates = [
      { label: 'Project', path: home ? `${home}/Projects/EG-Desk-Dev-Space` : null, depth: 4 },
      { label: 'Desktop', path: railSearchDirsvcPath('Desk') || (home ? `${home}/Desktop` : null), depth: 2 },
      { label: 'Documents', path: railSearchDirsvcPath('Docs') || (home ? `${home}/Documents` : null), depth: 2 },
      { label: 'Downloads', path: railSearchDirsvcPath('DfltDwnld') || (home ? `${home}/Downloads` : null), depth: 2 },
    ];
    const seen = new Set();
    return candidates.filter((root) => {
      if (!root.path || seen.has(root.path)) return false;
      const file = railSearchNsFileFromPath(root.path);
      if (!file?.exists?.() || !file.isDirectory()) return false;
      seen.add(root.path);
      return true;
    });
  }

  function railSearchShouldSkipFileEntry(leafName, query) {
    const q = railSearchQuery(query);
    const skipNames = new Set([
      '.git',
      'node_modules',
      'references',
      'outputs',
      'screenshots',
      'subagent_reports',
      'target',
      'dist',
      'dist-electron',
      'build',
      'out',
      '.next',
      '.turbo',
      '.cache',
      'Library',
      'Applications',
      'playwright-user-data',
      '.playwright-mcp',
    ]);
    if (skipNames.has(leafName)) return true;
    return leafName.startsWith('.') && !q.startsWith('.');
  }

  function scanRailSearchFiles(query, options = {}) {
    const q = railSearchQuery(query).toLowerCase();
    if (q.length < 2) return [];
    const maxVisited = Number.isFinite(options.maxVisited) ? options.maxVisited : 1800;
    const maxResults = Number.isFinite(options.maxResults) ? options.maxResults : 12;
    const queue = railSearchFileRoots()
      .map((root) => ({ ...root, file: railSearchNsFileFromPath(root.path), depth: 0, depthLimit: root.depth }))
      .filter((item) => item.file);
    const results = [];
    let visited = 0;

    while (queue.length && visited < maxVisited && results.length < maxResults * 4) {
      const current = queue.shift();
      let entries = null;
      try {
        entries = current.file.directoryEntries;
      } catch {
        continue;
      }
      const children = [];
      while (entries.hasMoreElements()) {
        let entry = null;
        try {
          entry = entries.getNext().QueryInterface(Ci.nsIFile);
        } catch {
          continue;
        }
        children.push(entry);
      }
      const priority = (entry) => {
        const name = entry.leafName || '';
        if (name === 'apps') return -6;
        if (name === 'firefox-ui-demo') return -5;
        if (name === 'scripts') return -4;
        if (name === 'overlay') return -3;
        if (name === 'docs' || name === 'ideas' || name === 'src') return -2;
        return 0;
      };
      children.sort((a, b) => priority(a) - priority(b) || String(a.leafName || '').localeCompare(String(b.leafName || '')));

      for (const entry of children) {
        if (visited >= maxVisited) break;
        visited += 1;
        const leafName = entry.leafName || '';
        if (!leafName || railSearchShouldSkipFileEntry(leafName, q)) continue;
        let isDirectory = false;
        let isFile = false;
        try {
          isDirectory = entry.isDirectory();
          isFile = entry.isFile();
        } catch {
          continue;
        }
        const path = entry.path || '';
        const nameMatch = leafName.toLowerCase().includes(q);
        const pathMatch = path.toLowerCase().includes(q);
        if (nameMatch || pathMatch) {
          results.push({
            name: leafName,
            path,
            type: isDirectory ? 'folder' : isFile ? 'file' : 'item',
            root: current.label,
            lastModifiedTime: entry.lastModifiedTime || 0,
            score: nameMatch ? (leafName.toLowerCase().startsWith(q) ? 0 : 1) : 2,
          });
        }
        if (isDirectory && current.depth < current.depthLimit) {
          queue.push({
            label: current.label,
            path,
            file: entry,
            depth: current.depth + 1,
            depthLimit: current.depthLimit,
          });
        }
      }
    }

    return results
      .sort((a, b) => a.score - b.score || (b.type === 'folder') - (a.type === 'folder') || b.lastModifiedTime - a.lastModifiedTime)
      .slice(0, maxResults);
  }

  function scheduleRailSearchFiles(query) {
    const q = railSearchQuery(query);
    state.railSearch.fileQuery = q;
    if (state.railSearch.fileSearchTimer) {
      window.clearTimeout(state.railSearch.fileSearchTimer);
      state.railSearch.fileSearchTimer = null;
    }
    if (q.length < 2) {
      state.railSearch.fileResults = [];
      state.railSearch.fileLoading = false;
      renderRailSearchPanel();
      return;
    }
    const seq = state.railSearch.fileSearchSeq + 1;
    state.railSearch.fileSearchSeq = seq;
    state.railSearch.fileLoading = true;
    state.railSearch.fileResults = [];
    renderRailSearchPanel();
    state.railSearch.fileSearchTimer = window.setTimeout(() => {
      let results = [];
      try {
        results = scanRailSearchFiles(q);
      } catch (error) {
        console.warn(TAG, 'rail file search failed', error);
      }
      if (state.railSearch.fileSearchSeq !== seq) return;
      state.railSearch.fileResults = results;
      state.railSearch.fileLoading = false;
      renderRailSearchPanel();
    }, 120);
  }

  function railSearchResultSnapshot(result) {
    if (!result) return null;
    return {
      key: result.key,
      type: result.type,
      section: result.section,
      title: result.title,
      subtitle: result.subtitle,
      active: !!result.active,
    };
  }

  function cardSubtitleForRailSearch(card) {
    if (!card) return '';
    if (card.classList.contains('egd-browser-card')) {
      return card.querySelector('.egd-card-url')?.value || card._sourceRef?.uri || 'Browser card';
    }
    if (card.classList.contains('egd-chat-card')) {
      const active = getActiveCodexThread(state.codex);
      return active ? `${codexThreadLongLabel(active.type)} · ${codexThreadSessionLabel(active)}` : 'Chat card';
    }
    if (card.classList.contains('egd-terminal-card')) return 'Terminal card';
    if (card.classList.contains('egd-settings-card')) return 'Settings card';
    return card._sourceRef?.uri || card._sourceRef?.id || card.id || 'Canvas card';
  }

  function railSearchUrlTitle(uri) {
    try {
      const url = new URL(uri);
      const path = url.pathname && url.pathname !== '/' ? url.pathname : '';
      return `${url.hostname}${path}` || uri;
    } catch {
      return uri || 'URL';
    }
  }

  function buildRailSearchAgendaResults(query) {
    return agendaListEntries({ filter: 'all', query: '' })
      .filter((entry) => railSearchMatches(query, [
        entry.title,
        entry.id,
        agendaEntryStatus(entry),
        entry.closed ? 'closed 닫힘' : '',
        entry.current ? 'current 현재' : '',
      ]))
      .slice(0, 5)
      .map((entry) => ({
        key: `agenda:${entry.id}`,
        type: 'agenda',
        section: 'Agenda',
        title: entry.title,
        subtitle: [agendaEntryStatus(entry), `${entry.count} items`].join(' · '),
        active: entry.current,
        execute: () => {
          if (!entry.current) switchAgenda(entry.id);
          else syncViewportAgendaRail();
        },
      }));
  }

  function buildRailSearchCardResults(query) {
    return Array.from(document.querySelectorAll('.egd-canvas-card'))
      .map((card) => {
        const title = cardLabelForViewportRail(card);
        const subtitle = cardSubtitleForRailSearch(card);
        const sourceRef = card._sourceRef || {};
        return { card, title, subtitle, sourceRef };
      })
      .filter(({ card, title, subtitle, sourceRef }) => railSearchMatches(query, [
        title,
        subtitle,
        card.id,
        sourceRef.kind,
        sourceRef.uri,
        sourceRef.path,
        sourceRef.id,
        card.dataset.sourceKey,
      ]))
      .slice(0, 6)
      .map(({ card, title, subtitle }) => ({
        key: `card:${card.id}`,
        type: 'card',
        section: 'Canvas',
        title,
        subtitle,
        active: card.id === state.activeEntityId,
        execute: () => focusCanvasCard(card),
      }));
  }

  function buildRailSearchHistoryResults(query) {
    const q = railSearchQuery(query);
    if (q.length < 2) return [];
    const store = coerceAgendaStore();
    const seen = new Set();
    const results = [];
    for (const [agendaId, snapshot] of Object.entries(store.agendas || {})) {
      const agendaTitle = snapshot?.agenda?.title || store.meta?.[agendaId]?.title || agendaId;
      for (const card of snapshot?.cards || []) {
        if (card?.type !== 'browser') continue;
        const uri = normalizeBrowserUri(card.runtimeState?.uri || card.sourceRef?.uri || '');
        if (!uri || seen.has(uri)) continue;
        if (!railSearchMatches(q, [uri, agendaTitle, card.id])) continue;
        seen.add(uri);
        results.push({
          key: `history:${agendaId}:${card.id}:${uri}`,
          type: 'history',
          section: 'History',
          title: railSearchUrlTitle(uri),
          subtitle: `${agendaTitle} · saved browser`,
          active: false,
          execute: () => spawnBrowserCard(uri, { openMode: 'focus-existing' }),
        });
      }
    }
    return results.slice(0, 6);
  }

  function buildRailSearchFileResults(query) {
    const q = railSearchQuery(query);
    if (q.length < 2 || railSearchQuery(state.railSearch.fileQuery) !== q) return [];
    return (state.railSearch.fileResults || []).filter((file) => railSearchMatches(q, [file.name, file.path]))
      .slice(0, 6).map((file) => ({
      key: `file:${file.path}`,
      type: 'file',
      section: 'Files',
      title: file.name,
      subtitle: `${file.root} · ${file.type} · ${file.path}`,
      active: false,
      execute: () => spawnBrowserCard(railSearchPathToFileUrl(file.path, file.type === 'folder'), { openMode: 'new' }),
    }));
  }

  function openCodexThreadFromRailSearch(threadId) {
    if (!threadId) return false;
    if (state.codex.chatDockMode === 'canvas' || state.codex.chatCardEntityId) {
      spawnCodexChatCard();
    } else if (!(state.hudOpen && state.hudApp === 'chat')) {
      toggleHUD('chat', '채팅');
    }
    state.codexBridge?.selectThread?.(threadId, { openConversation: true });
    return true;
  }

  function buildRailSearchThreadResults(query) {
    return (state.codex?.threads || [])
      .filter((thread) => codexThreadMatchesQuery(thread, query))
      .slice(0, 5)
      .map((thread) => ({
        key: `thread:${thread.id}`,
        type: 'thread',
        section: 'Chat',
        title: thread.title,
        subtitle: `${codexThreadLongLabel(thread.type)} · ${codexThreadSessionLabel(thread)} · ${codexThreadPreview(thread)}`,
        active: thread.id === state.codex.activeThreadId,
        execute: () => openCodexThreadFromRailSearch(thread.id),
      }));
  }

  function buildRailSearchWebResult(query) {
    const q = railSearchQuery(query);
    if (!q) return null;
    const url = railSearchBrowserUrl(q);
    return {
      key: `web:${url}`,
      type: 'web',
      section: 'Web',
      title: railSearchLooksLikeNavigation(q) ? url : `Search "${q}"`,
      subtitle: 'Browser card',
      active: false,
      execute: () => spawnBrowserCard(url, { openMode: 'new' }),
    };
  }

  function buildRailSearchResults(query = state.railSearch.query) {
    const q = railSearchQuery(query);
    const localResults = [
      ...buildRailSearchAgendaResults(q),
      ...buildRailSearchCardResults(q),
      ...buildRailSearchHistoryResults(q),
      ...buildRailSearchFileResults(q),
      ...buildRailSearchThreadResults(q),
    ];
    const webResult = buildRailSearchWebResult(q);
    const results = webResult && railSearchLooksLikeNavigation(q)
      ? [webResult, ...localResults]
      : [...localResults, ...(webResult ? [webResult] : [])];
    return results.slice(0, 14);
  }

  function updateRailSearchActiveRow(panel = document.getElementById('egd-rail-search-results')) {
    if (!panel) return;
    for (const row of panel.querySelectorAll('.egd-rail-search-result')) {
      row.classList.toggle('egd-rail-search-result-active', Number(row.dataset.index) === state.railSearch.activeIndex);
    }
  }

  function updateRailSearchPanelPlacement(panel = document.getElementById('egd-rail-search-results')) {
    const anchor = document.querySelector('.egd-rail-search');
    if (!panel || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const hud = document.getElementById('egd-hud');
    const hudRect = hud && !hud.classList.contains('egd-hud-hidden') ? hud.getBoundingClientRect() : null;
    const safeRight = hudRect ? Math.max(rect.left + 320, hudRect.left - 12) : window.innerWidth - 16;
    const width = Math.max(320, Math.min(rect.width, safeRight - rect.left));
    panel.style.left = `${Math.round(rect.left)}px`;
    panel.style.top = `${Math.round(rect.bottom + 8)}px`;
    panel.style.width = `${Math.round(width)}px`;
  }

  function closeRailSearchPanel(options = {}) {
    const panel = document.getElementById('egd-rail-search-results');
    if (panel?._outsideHandler) window.removeEventListener('mousedown', panel._outsideHandler, true);
    if (panel?._resizeHandler) window.removeEventListener('resize', panel._resizeHandler);
    panel?.remove();
    state.railSearch.open = false;
    if (options.clearQuery) state.railSearch.query = '';
    document.querySelector('.egd-rail-search')?.classList.remove('egd-rail-search-open');
  }

  function executeRailSearchResult(resultOrKey) {
    const result = typeof resultOrKey === 'string'
      ? buildRailSearchResults().find((entry) => entry.key === resultOrKey)
      : resultOrKey;
    if (!result || typeof result.execute !== 'function') return false;
    result.execute();
    const input = document.querySelector('.egd-rail-search-input');
    if (input) input.value = '';
    state.railSearch.query = '';
    closeRailSearchPanel();
    return true;
  }

  function renderRailSearchPanel(panel = document.getElementById('egd-rail-search-results')) {
    if (!panel) return;
    const results = buildRailSearchResults();
    state.railSearch.activeIndex = Math.max(0, Math.min(state.railSearch.activeIndex, Math.max(0, results.length - 1)));
    const children = [];
    let section = '';
    results.forEach((result, index) => {
      if (result.section !== section) {
        section = result.section;
        children.push(el('div', { class: 'egd-rail-search-section' }, section));
      }
      children.push(el('button', {
        class: 'egd-rail-search-result' + (index === state.railSearch.activeIndex ? ' egd-rail-search-result-active' : ''),
        data: { index, key: result.key, type: result.type },
        onmousedown: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        },
        onmouseenter: () => {
          state.railSearch.activeIndex = index;
          updateRailSearchActiveRow(panel);
        },
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          executeRailSearchResult(result);
        },
      },
        el('span', { class: `egd-rail-search-type egd-rail-search-type-${result.type}` }, result.type),
        el('span', { class: 'egd-rail-search-main' },
          el('span', { class: 'egd-rail-search-title' }, result.title),
          el('span', { class: 'egd-rail-search-subtitle' }, result.subtitle),
        ),
        result.active ? el('span', { class: 'egd-rail-search-current' }, 'Active') : null,
      ));
    });
    panel.replaceChildren(
      children.length
        ? el('div', { class: 'egd-rail-search-list' }, ...children)
        : el('div', { class: 'egd-rail-search-empty' }, '결과 없음'),
    );
    updateRailSearchPanelPlacement(panel);
  }

  function openRailSearchPanel() {
    let panel = document.getElementById('egd-rail-search-results');
    if (!panel) {
      panel = el('div', { id: 'egd-rail-search-results', class: 'egd-edge egd-frosted' });
      panel._outsideHandler = (event) => {
        if (event.target?.closest?.('#egd-rail-search-results, .egd-rail-search')) return;
        closeRailSearchPanel();
      };
      panel._resizeHandler = () => updateRailSearchPanelPlacement(panel);
      document.documentElement.appendChild(panel);
      setTimeout(() => window.addEventListener('mousedown', panel._outsideHandler, true), 0);
      window.addEventListener('resize', panel._resizeHandler);
    }
    state.railSearch.open = true;
    document.querySelector('.egd-rail-search')?.classList.add('egd-rail-search-open');
    renderRailSearchPanel(panel);
  }

  function setRailSearchQuery(query, options = {}) {
    state.railSearch.query = String(query || '');
    if (options.resetActive !== false) state.railSearch.activeIndex = 0;
    const input = document.querySelector('.egd-rail-search-input');
    if (input && input.value !== state.railSearch.query) input.value = state.railSearch.query;
    openRailSearchPanel();
    scheduleRailSearchFiles(state.railSearch.query);
  }

  function handleRailSearchKeydown(ev, input) {
    const q = railSearchQuery(input?.value || state.railSearch.query);
    if (ev.key === 'Escape') {
      if (state.railSearch.open) {
        closeRailSearchPanel();
      } else if (input) {
        input.value = '';
        state.railSearch.query = '';
      }
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const results = buildRailSearchResults(q);
      if (!results.length) return;
      const delta = ev.key === 'ArrowDown' ? 1 : -1;
      state.railSearch.query = q;
      state.railSearch.activeIndex = (state.railSearch.activeIndex + delta + results.length) % results.length;
      openRailSearchPanel();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    if (ev.key === 'Tab' && q) {
      const url = railSearchBrowserUrl(q);
      const existing = focusOpenSourceCard(browserSourceRef(url));
      if (existing) {
        if (input) input.value = '';
        state.railSearch.query = '';
        closeRailSearchPanel();
        ev.preventDefault();
        ev.stopPropagation();
      }
      return;
    }

    if (ev.key === 'Enter' && q) {
      const results = buildRailSearchResults(q);
      const result = results[state.railSearch.activeIndex] || results[0];
      if (result) {
        executeRailSearchResult(result);
        ev.preventDefault();
        ev.stopPropagation();
      }
    }
  }

  function installRailSearchShortcut() {
    try { window.__egdeskRailSearchShortcutCleanup?.(); } catch {}
    const handler = (ev) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.key?.toLowerCase?.() !== 'k') return;
      const input = document.querySelector('.egd-rail-search-input');
      if (!input) return;
      ev.preventDefault();
      ev.stopPropagation();
      input.focus();
      input.select?.();
      openRailSearchPanel();
    };
    window.addEventListener('keydown', handler, true);
    window.__egdeskRailSearchShortcutCleanup = () => window.removeEventListener('keydown', handler, true);
  }

  function closeAgendaSwitcher() {
    const panel = document.getElementById('egd-agenda-switcher');
    if (panel?._outsideHandler) window.removeEventListener('mousedown', panel._outsideHandler, true);
    panel?.remove();
    state.agenda.switcherOpen = false;
    document.querySelector('.egd-rail-switcher')?.classList.remove('egd-rail-switcher-open');
  }

  function showAgendaTransitionGuard({
    title = 'Agenda',
    heading = 'Agenda를 전환할까요?',
    discardLabel = '버리고 전환',
    saveLabel = '저장 후 전환',
    onSave,
    onDiscard,
  } = {}) {
    const existing = document.getElementById('egd-agenda-close-guard');
    if (existing) {
      existing.querySelector('[data-action="continue"]')?.focus?.();
      return false;
    }
    state.agenda.closeGuardOpen = true;
    const dirtyCount = state.agenda.dirtyReasons.length;
    const dirtyText = dirtyCount > 1
      ? `${dirtyCount}개의 변경사항을 처리한 뒤 이동합니다.`
      : '저장되지 않은 변경사항을 처리한 뒤 이동합니다.';

    const dialog = el('div', {
      id: 'egd-agenda-close-guard',
      class: 'egd-agenda-close-guard',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'egd-agenda-transition-title',
      tabindex: '-1',
      onclick: (ev) => {
        if (ev.target === dialog) closeAgendaCloseGuard();
      },
      onkeydown: (ev) => {
        if (ev.key === 'Escape') {
          closeAgendaCloseGuard();
          ev.preventDefault();
          ev.stopPropagation();
        }
      },
    },
      el('div', { class: 'egd-agenda-close-panel' },
        el('div', { class: 'egd-agenda-close-kicker' }, title),
        el('div', { id: 'egd-agenda-transition-title', class: 'egd-agenda-close-title' }, heading),
        el('div', { class: 'egd-agenda-close-copy' }, dirtyText),
        el('div', { class: 'egd-agenda-close-actions' },
          el('button', {
            class: 'egd-agenda-close-btn egd-agenda-close-btn-ghost',
            data: { action: 'continue' },
            onclick: (ev) => {
              ev.stopPropagation();
              closeAgendaCloseGuard();
              closeAgendaSwitcher();
            },
          }, '계속 작업'),
          el('button', {
            class: 'egd-agenda-close-btn egd-agenda-close-btn-danger',
            data: { action: 'discard' },
            onclick: (ev) => {
              ev.stopPropagation();
              closeAgendaCloseGuard();
              state.agenda.dirty = false;
              state.agenda.dirtyReasons = [];
              if (typeof onDiscard === 'function') onDiscard();
            },
          }, discardLabel),
          el('button', {
            class: 'egd-agenda-close-btn egd-agenda-close-btn-primary',
            data: { action: 'save' },
            onclick: (ev) => {
              ev.stopPropagation();
              if (!saveCurrentAgendaState()) return;
              closeAgendaCloseGuard();
              if (typeof onSave === 'function') onSave();
            },
          }, saveLabel),
        ),
      ),
    );
    document.documentElement.appendChild(dialog);
    dialog.focus();
    return false;
  }

  function switchAgenda(agendaId, options = {}) {
    const store = coerceAgendaStore();
    const snapshot = store.agendas?.[agendaId] || null;
    const title = snapshot?.agenda?.title || store.meta?.[agendaId]?.title || 'Agenda';
    if (state.agenda.dirty && options.force !== true) {
      return showAgendaTransitionGuard({
        title,
        onSave: () => switchAgenda(agendaId, { force: true }),
        onDiscard: () => switchAgenda(agendaId, { force: true }),
      });
    }
    closeAgendaSwitcher();
    closeAgendaCloseGuard();
    store.activeAgendaId = agendaId;
    const meta = ensureAgendaMeta(store, agendaId, { title });
    if (meta) {
      meta.lastOpenedAt = Date.now();
      meta.closedAt = null;
    }
    writeAgendaStoreAndSync(store);
    if (snapshot) return restoreAgendaSnapshot(snapshot);

    state.agenda.activeAgendaId = agendaId;
    state.agenda.activeTitle = title;
    clearCurrentAgendaView({ markClean: true });
    updateAgendaMetaFromStore(store);
    syncViewportAgendaRail();
    return true;
  }

  function createNewAgenda(options = {}) {
    if (state.agenda.dirty && options.force !== true) {
      return showAgendaTransitionGuard({
        title: '새 Agenda',
        onSave: () => createNewAgenda({ force: true }),
        onDiscard: () => createNewAgenda({ force: true }),
      });
    }
    const store = coerceAgendaStore();
    const existingCount = Math.max(1, Object.keys(store.meta || {}).length + 1);
    const id = `agenda-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const title = `Agenda ${existingCount}`;
    store.activeAgendaId = id;
    store.meta[id] = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOpenedAt: Date.now(),
      closedAt: null,
    };
    writeAgendaStoreAndSync(store);
    state.agenda.activeAgendaId = id;
    state.agenda.activeTitle = title;
    state.agenda.dirty = false;
    state.agenda.dirtyReasons = [];
    closeAgendaSwitcher();
    closeAgendaCloseGuard();
    clearCurrentAgendaView({ markClean: true });
    syncViewportAgendaRail();
    return id;
  }

  function renderAgendaSwitcherPanel(panel) {
    const entries = agendaListEntries();
    const counts = agendaFilterCounts();
    const filters = [
      ['all', '전체', counts.all],
      ['recent', '최근', counts.recent],
      ['closed', '닫힘', counts.closed],
    ];
    const renderAgain = (focusSearch = false) => {
      renderAgendaSwitcherPanel(panel);
      if (focusSearch) {
        const input = panel.querySelector('.egd-agenda-switch-search-input');
        input?.focus?.();
        input?.setSelectionRange?.(input.value.length, input.value.length);
      }
    };
    const rows = entries.map((entry) => el('div', {
      class: 'egd-agenda-switch-row' + (entry.current ? ' egd-agenda-switch-row-current' : ''),
      role: 'button',
      tabindex: '0',
      data: { agendaId: entry.id },
      onclick: (ev) => {
        if (ev.target?.closest?.('.egd-agenda-switch-row-action')) return;
        ev.stopPropagation();
        if (!entry.current) switchAgenda(entry.id);
      },
      onkeydown: (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        ev.stopPropagation();
        if (!entry.current) switchAgenda(entry.id);
      },
    },
      el('span', { class: 'egd-agenda-switch-row-dot' }),
      el('span', { class: 'egd-agenda-switch-row-main' },
        el('span', { class: 'egd-agenda-switch-row-title' }, entry.title),
        el('span', { class: 'egd-agenda-switch-row-meta' },
          [
            agendaEntryStatus(entry),
            entry.closed ? 'Closed history' : entry.lastOpenedAt ? 'Recent' : 'Stored',
            `${entry.count} items`,
          ].join(' · '),
        ),
      ),
      el('span', { class: 'egd-agenda-switch-row-actions' },
        el('button', {
          class: 'egd-agenda-switch-row-action',
          title: '이름 변경',
          data: { action: 'rename' },
          onclick: (ev) => {
            ev.stopPropagation();
            renameAgendaWithPrompt(entry.id);
          },
        }, '✎'),
        el('button', {
          class: 'egd-agenda-switch-row-action',
          title: '복제',
          data: { action: 'duplicate' },
          onclick: (ev) => {
            ev.stopPropagation();
            duplicateAgenda(entry.id);
          },
        }, '⧉'),
        el('button', {
          class: 'egd-agenda-switch-row-action egd-agenda-switch-row-action-danger',
          title: '삭제',
          data: { action: 'delete' },
          onclick: (ev) => {
            ev.stopPropagation();
            deleteAgenda(entry.id);
          },
        }, '⌫'),
      ),
    ));
    panel.replaceChildren(
      el('div', { class: 'egd-agenda-switch-head' },
        el('div', { class: 'egd-agenda-switch-title' }, 'Agenda'),
        el('div', { class: 'egd-agenda-switch-actions' },
          el('button', {
            class: 'egd-agenda-switch-action',
            title: '현재 Agenda 저장',
            onclick: (ev) => {
              ev.stopPropagation();
              saveCurrentAgendaState();
              renderAgendaSwitcherPanel(panel);
            },
          }, '저장'),
          el('button', {
            class: 'egd-agenda-switch-action egd-agenda-switch-action-primary',
            title: '새 Agenda',
            onclick: (ev) => {
              ev.stopPropagation();
              createNewAgenda();
            },
          }, '새 Agenda'),
        ),
      ),
      el('div', { class: 'egd-agenda-switch-search' },
        el('span', { class: 'egd-agenda-switch-search-icon' }, '⌕'),
        el('input', {
          type: 'search',
          class: 'egd-agenda-switch-search-input',
          placeholder: 'Agenda 검색...',
          value: state.agenda.switcherQuery,
          oninput: (ev) => {
            state.agenda.switcherQuery = ev.target.value;
            renderAgain(true);
          },
          onkeydown: (ev) => {
            if (ev.key === 'Escape') {
              state.agenda.switcherQuery = '';
              renderAgain(true);
              ev.preventDefault();
              ev.stopPropagation();
            }
          },
        }),
      ),
      el('div', { class: 'egd-agenda-switch-filters' },
        ...filters.map(([id, label, count]) => el('button', {
          class: 'egd-agenda-switch-filter' + (state.agenda.switcherFilter === id ? ' egd-agenda-switch-filter-active' : ''),
          data: { filter: id },
          onclick: (ev) => {
            ev.stopPropagation();
            state.agenda.switcherFilter = id;
            renderAgain(false);
          },
        }, `${label} ${count}`)),
      ),
      el('div', { class: 'egd-agenda-switch-list' },
        ...(rows.length ? rows : [
          el('div', { class: 'egd-agenda-switch-empty' }, '검색 결과가 없습니다.'),
        ]),
      ),
    );
  }

  function toggleAgendaSwitcher(ev = null) {
    ev?.stopPropagation?.();
    const existing = document.getElementById('egd-agenda-switcher');
    if (existing) {
      closeAgendaSwitcher();
      return;
    }
    const panel = el('div', { id: 'egd-agenda-switcher', class: 'egd-edge egd-frosted' });
    renderAgendaSwitcherPanel(panel);
    document.documentElement.appendChild(panel);
    state.agenda.switcherOpen = true;
    document.querySelector('.egd-rail-switcher')?.classList.add('egd-rail-switcher-open');
    panel._outsideHandler = (event) => {
      if (event.target?.closest?.('#egd-agenda-switcher, .egd-rail-switcher')) return;
      closeAgendaSwitcher();
    };
    setTimeout(() => window.addEventListener('mousedown', panel._outsideHandler, true), 0);
  }

  function markAgendaDirty(reason = 'canvas-change', entity = null) {
    if (state.agenda.suppressDirty || state.agenda.restoreInProgress) return;
    if (!state.agenda.dirty) state.agenda.dirtyReasons = [];
    state.agenda.dirty = true;
    state.agenda.dirtyRevision += 1;
    const entry = {
      reason,
      entityId: entity?.id || null,
      sourceKey: entity?.dataset?.sourceKey || null,
      ts: Date.now(),
    };
    state.agenda.dirtyReasons = [entry, ...state.agenda.dirtyReasons].slice(0, 12);
    syncViewportAgendaRail();
  }

  function listOpenSourceCards() {
    return Array.from(document.querySelectorAll('.egd-canvas-card')).map((card) => ({
      id: card.id,
      className: card.className,
      sourceRef: card._sourceRef || null,
      sourceKey: card.dataset.sourceKey || '',
    }));
  }

  function setActiveEntity(entity) {
    for (const node of document.querySelectorAll('.egd-entity-active, .egd-entity-selected')) {
      node.classList.remove('egd-entity-active', 'egd-entity-selected');
    }
    if (!entity || !entity.isConnected) {
      state.activeEntityId = null;
      syncViewportAgendaRail();
      return;
    }
    entity.classList.add('egd-entity-selected', 'egd-entity-active');
    state.activeEntityId = entity.id || null;
    syncViewportAgendaRail();
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

  function activeToolIsShape() {
    return state.activeTool === 'square' || state.activeTool === 'ellipse' || state.activeTool === 'line';
  }

  function syncActiveToolMode() {
    document.documentElement.dataset.egdActiveTool = state.activeTool || 'arrow';
  }

  function shapeTypeForTool(tool = state.activeTool) {
    if (tool === 'ellipse') return 'ellipse';
    if (tool === 'line') return 'line';
    return 'rect';
  }

  function deleteSelectedEntities() {
    const selected = Array.from(document.querySelectorAll('.egd-entity-selected'));
    for (const entity of selected) {
      if (entity.classList.contains('egd-canvas-card')) closeCanvasCard(entity);
      else {
        try { if (typeof entity._cleanup === 'function') entity._cleanup(); } catch {}
        entity.remove();
        markAgendaDirty('delete-shape', entity);
      }
    }
    setActiveEntity(null);
  }

  function rectsOverlap(a, b) {
    if (!a || !b) return false;
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function rectOverlapArea(a, b) {
    if (!rectsOverlap(a, b)) return 0;
    return (Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  }

  function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  function safeViewportRect(options = {}) {
    const margin = Number.isFinite(options.margin) ? options.margin : 24;
    let left = margin;
    let top = margin;
    let right = Math.max(left + 1, window.innerWidth - margin);
    let bottom = Math.max(top + 1, window.innerHeight - margin);

    const rail = document.getElementById('egd-desk-rail');
    const dock = document.getElementById('egd-dock');
    const bag = document.getElementById('egd-preset-bag');
    const hud = document.getElementById('egd-hud');
    if (rail) top = Math.max(top, rail.getBoundingClientRect().bottom + margin);
    if (dock) bottom = Math.min(bottom, dock.getBoundingClientRect().top - margin);
    if (bag) left = Math.max(left, bag.getBoundingClientRect().right + margin);
    if (options.avoidHud !== false && hud && !hud.classList.contains('egd-hud-hidden')) {
      right = Math.min(right, hud.getBoundingClientRect().left - margin);
    }

    if (right <= left + 40) {
      left = margin;
      right = Math.max(left + 1, window.innerWidth - margin);
    }
    if (bottom <= top + 40) {
      top = margin;
      bottom = Math.max(top + 1, window.innerHeight - margin);
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function clampClientCardRect(width, height, anchorClientX, anchorClientY, options = {}) {
    const zoom = Math.max(0.001, state.zoomTarget || state.zoom || 1);
    const visualWidth = width * zoom;
    const visualHeight = height * zoom;
    const safe = safeViewportRect(options);
    const maxLeft = Math.max(safe.left, safe.right - visualWidth);
    const maxTop = Math.max(safe.top, safe.bottom - visualHeight);
    const baseLeft = Number.isFinite(anchorClientX)
      ? anchorClientX - visualWidth / 2
      : safe.left + Math.max(0, safe.width - visualWidth) / 2;
    const baseTop = Number.isFinite(anchorClientY)
      ? anchorClientY - visualHeight / 2
      : safe.top + Math.max(0, safe.height - visualHeight) / 2;

    return {
      left: Math.max(safe.left, Math.min(maxLeft, baseLeft)),
      top: Math.max(safe.top, Math.min(maxTop, baseTop)),
      width: visualWidth,
      height: visualHeight,
    };
  }

  function resolveCanvasCardPlacement(width, height, options = {}) {
    const offset = Number.isFinite(options.offset) ? options.offset : 0;
    const anchorClientX = Number.isFinite(options.anchorClientX)
      ? options.anchorClientX + offset
      : window.innerWidth / 2 + offset;
    const anchorClientY = Number.isFinite(options.anchorClientY)
      ? options.anchorClientY + offset
      : window.innerHeight / 2 + offset;
    const primary = clampClientCardRect(width, height, anchorClientX, anchorClientY, options);
    const candidates = [primary];
    const safe = safeViewportRect(options);
    const zoom = Math.max(0.001, state.zoomTarget || state.zoom || 1);
    const visualWidth = width * zoom;
    const visualHeight = height * zoom;
    const step = Math.max(36, 24 * zoom);
    const anchorPoints = [
      [safe.left + safe.width / 2, safe.top + safe.height / 2],
      [safe.left + visualWidth / 2, safe.top + visualHeight / 2],
      [safe.right - visualWidth / 2, safe.top + visualHeight / 2],
      [safe.left + visualWidth / 2, safe.bottom - visualHeight / 2],
      [safe.right - visualWidth / 2, safe.bottom - visualHeight / 2],
    ];
    for (const [x, y] of anchorPoints) candidates.push(clampClientCardRect(width, height, x, y, options));
    for (let i = 1; i <= 5; i += 1) {
      candidates.push(clampClientCardRect(width, height, anchorClientX + step * i, anchorClientY + step * i, options));
    }

    const existingRects = Array.from(document.querySelectorAll('.egd-canvas-card'))
      .filter((card) => options.ignoreCardId == null || card.id !== options.ignoreCardId)
      .map((card) => card.getBoundingClientRect());
    let best = candidates[0];
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const rect = {
        left: candidate.left,
        top: candidate.top,
        right: candidate.left + candidate.width,
        bottom: candidate.top + candidate.height,
      };
      const overlap = existingRects.reduce((sum, other) => sum + rectOverlapArea(rect, other), 0);
      const anchorDistance = Math.abs(candidate.left - primary.left) + Math.abs(candidate.top - primary.top);
      const score = overlap * 20 + anchorDistance;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return viewportToCanvasPoint(best.left, best.top);
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

  function currentViewportAgendaLabel() {
    if (state.agenda.activeTitle) return state.agenda.activeTitle;
    const groupThread = state.codex?.threads?.find((thread) => thread.type === 'group');
    return groupThread?.title || 'EG-Desk Agenda';
  }

  function cardLabelForViewportRail(card) {
    if (!card) return 'Card';
    if (card.classList.contains('egd-terminal-card')) return 'Terminal';
    if (card.classList.contains('egd-settings-card')) return 'Settings';
    if (card.classList.contains('egd-chat-card')) {
      return card.querySelector('.egd-chat-card-title')?.textContent?.trim() || 'Chat';
    }
    const urlInput = card.querySelector('.egd-card-url');
    if (urlInput && typeof urlInput.value === 'string' && urlInput.value.trim()) {
      return 'Browser';
    }
    return card.getAttribute('title') || 'Card';
  }

  function syncViewportAgendaRail() {
    const agendaName = document.querySelector('.egd-rail-agenda-name');
    if (agendaName) agendaName.textContent = currentViewportAgendaLabel();
    const switcher = document.querySelector('.egd-rail-switcher');
    if (switcher) switcher.classList.toggle('egd-rail-switcher-open', !!document.getElementById('egd-agenda-switcher'));
    const dirtyBadge = document.querySelector('.egd-rail-dirty-badge');
    if (dirtyBadge) {
      dirtyBadge.hidden = !state.agenda.dirty;
      dirtyBadge.title = state.agenda.dirty
        ? `Agenda unsaved changes · rev ${state.agenda.dirtyRevision}`
        : 'Agenda saved';
    }
    const saveBtn = document.querySelector('.egd-rail-save-btn');
    if (saveBtn) saveBtn.hidden = !state.agenda.dirty;
    const restoreBtn = document.querySelector('.egd-rail-restore-btn');
    if (restoreBtn) restoreBtn.hidden = !state.agenda.hasSavedState;

    const badge = document.querySelector('.egd-rail-card-badge');
    if (badge) {
      const card = state.cardFullscreen?.cardId ? document.getElementById(state.cardFullscreen.cardId) : null;
      if (card?.isConnected) {
        badge.textContent = `${cardLabelForViewportRail(card)} · Maximized`;
        badge.hidden = false;
      } else {
        badge.textContent = '';
        badge.hidden = true;
      }
    }
    const agendaSwitcher = document.getElementById('egd-agenda-switcher');
    if (agendaSwitcher) renderAgendaSwitcherPanel(agendaSwitcher);
    refreshDeskMinimap();
  }

  function closeDeskMinimap() {
    document.getElementById('egd-desk-minimap')?.remove();
  }

  function viewportWorldRect() {
    const zoom = Math.max(0.001, state.zoomTarget || state.zoom || 1);
    return {
      left: -state.panTarget.x / zoom,
      top: -state.panTarget.y / zoom,
      right: (window.innerWidth - state.panTarget.x) / zoom,
      bottom: (window.innerHeight - state.panTarget.y) / zoom,
      width: window.innerWidth / zoom,
      height: window.innerHeight / zoom,
    };
  }

  function entityWorldRect(entity) {
    if (!entity) return null;
    const left = Number.parseFloat(entity.style.left) || 0;
    const top = Number.parseFloat(entity.style.top) || 0;
    const width = Math.max(12, Number.parseFloat(entity.style.width) || entity.offsetWidth || 12);
    const height = Math.max(12, Number.parseFloat(entity.style.height) || entity.offsetHeight || 12);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function minimapDeskBounds() {
    const viewport = viewportWorldRect();
    const entities = Array.from(document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape'))
      .map((entity) => ({ entity, rect: entityWorldRect(entity) }))
      .filter((item) => item.rect);
    let left = viewport.left;
    let top = viewport.top;
    let right = viewport.right;
    let bottom = viewport.bottom;
    for (const { rect } of entities) {
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    const rawWidth = Math.max(1, right - left);
    const rawHeight = Math.max(1, bottom - top);
    const minWorldWidth = Math.max(1, viewport.width * 1.08);
    const minWorldHeight = Math.max(1, viewport.height * 1.08);
    const width = Math.max(minWorldWidth, rawWidth);
    const height = Math.max(minWorldHeight, rawHeight);
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    const entityArea = entities.reduce((sum, { rect }) => sum + rect.width * rect.height, 0);
    const worldArea = Math.max(1, width * height);
    const density = entities.length ? clampNumber(entityArea / worldArea, 0, 1) : 0;
    const sparsity = entities.length ? clampNumber(1 - density * 6, 0.12, 1) : 0.35;
    const padding = Math.max(
      64,
      Math.min(520, Math.max(width, height) * (0.045 + sparsity * 0.045)),
      Math.min(viewport.width, viewport.height) * 0.05,
    );
    const bounds = {
      left: centerX - width / 2 - padding,
      top: centerY - height / 2 - padding,
      right: centerX + width / 2 + padding,
      bottom: centerY + height / 2 + padding,
    };
    bounds.width = bounds.right - bounds.left;
    bounds.height = bounds.bottom - bounds.top;
    const spreadRatio = Math.max(
      bounds.width / Math.max(1, viewport.width),
      bounds.height / Math.max(1, viewport.height),
    );
    return { bounds, viewport, entities, density, sparsity, spreadRatio };
  }

  function minimapDimensionsForBounds(modelBase) {
    const aspect = clampNumber(modelBase.bounds.width / Math.max(1, modelBase.bounds.height), 0.55, 2.35);
    const zoom = Math.max(0.001, state.zoomTarget || state.zoom || 1);
    const spreadWeight = Math.log2(Math.max(1, modelBase.spreadRatio));
    const countWeight = Math.min(42, modelBase.entities.length * 5);
    const zoomWeight = clampNumber(Math.abs(Math.log2(zoom)) * 8, 0, 18);
    const mapWidth = Math.round(clampNumber(236 + spreadWeight * 34 + countWeight + zoomWeight, 236, 390));
    const mapHeight = Math.round(clampNumber(mapWidth / aspect, 112, 242));
    return {
      mapWidth,
      mapHeight,
      panelWidth: mapWidth,
      aspect,
      zoom,
    };
  }

  function applyMinimapDynamicSizing(panel, modelBase) {
    if (!panel) return null;
    const map = panel.querySelector('.egd-minimap-map');
    if (!map) return null;
    const dimensions = minimapDimensionsForBounds(modelBase);
    panel.style.width = dimensions.panelWidth + 'px';
    map.style.height = dimensions.mapHeight + 'px';
    map.dataset.zoom = String(Math.round(dimensions.zoom * 100));
    map.dataset.spread = String(Math.round(modelBase.spreadRatio * 10) / 10);
    panel.dataset.sparsity = String(Math.round(modelBase.sparsity * 100));
    const caption = panel.querySelector('.egd-minimap-caption');
    if (caption) {
      caption.textContent = `${Math.round(dimensions.zoom * 100)}% · ${modelBase.entities.length} objects · ${Math.round(modelBase.spreadRatio * 10) / 10}x spread`;
    }
    return dimensions;
  }

  function minimapWorldModel(map) {
    const modelBase = minimapDeskBounds();
    const panel = map?.closest?.('#egd-desk-minimap');
    const dimensions = applyMinimapDynamicSizing(panel, modelBase);
    const mapWidth = Math.max(1, map?.clientWidth || 1);
    const mapHeight = Math.max(1, map?.clientHeight || 1);
    const scale = Math.min(mapWidth / modelBase.bounds.width, mapHeight / modelBase.bounds.height);
    const offsetX = (mapWidth - modelBase.bounds.width * scale) / 2;
    const offsetY = (mapHeight - modelBase.bounds.height * scale) / 2;
    return { ...modelBase, dimensions, scale, offsetX, offsetY, mapWidth, mapHeight };
  }

  function worldRectToMinimapStyle(rect, model, options = {}) {
    const minSize = Number.isFinite(options.minSize) ? options.minSize : 3;
    return {
      left: Math.round(model.offsetX + (rect.left - model.bounds.left) * model.scale) + 'px',
      top: Math.round(model.offsetY + (rect.top - model.bounds.top) * model.scale) + 'px',
      width: Math.max(minSize, Math.round(rect.width * model.scale)) + 'px',
      height: Math.max(minSize, Math.round(rect.height * model.scale)) + 'px',
    };
  }

  function minimapPointToWorld(clientX, clientY, map, model) {
    const mapRect = map.getBoundingClientRect();
    return {
      x: model.bounds.left + (clientX - mapRect.left - model.offsetX) / model.scale,
      y: model.bounds.top + (clientY - mapRect.top - model.offsetY) / model.scale,
    };
  }

  function moveCanvasViewportToWorld(left, top, options = {}) {
    const zoom = Math.max(0.001, state.zoomTarget || state.zoom || 1);
    const nextPan = { x: -left * zoom, y: -top * zoom };
    if (typeof state.setCanvasPanTarget === 'function') {
      state.setCanvasPanTarget(nextPan, options);
      return;
    }
    state.panTarget = nextPan;
    if (options.immediate) state.pan = { ...nextPan };
    refreshDeskMinimap();
  }

  function buildMinimapEntityMarker(item, model) {
    const entity = item.entity;
    const rect = item.rect;
    const isCard = entity.classList.contains('egd-canvas-card');
    return el('button', {
      class: 'egd-minimap-entity'
        + (isCard ? ' egd-minimap-entity-card' : ' egd-minimap-entity-shape')
        + (entity.id === state.activeEntityId ? ' egd-minimap-entity-active' : ''),
      title: isCard ? cardLabelForViewportRail(entity) : entity.dataset.shapeType || 'Shape',
      style: worldRectToMinimapStyle(rect, model),
      onclick: (ev) => {
        ev.stopPropagation();
        focusCanvasCard(entity);
      },
    });
  }

  function renderDeskMinimapWorld(panel) {
    const map = panel?.querySelector('.egd-minimap-map');
    if (!map) return null;
    const model = minimapWorldModel(map);
    map.textContent = '';
    const agendaRegion = el('div', {
      class: 'egd-minimap-agenda',
      style: worldRectToMinimapStyle(model.bounds, model, { minSize: 16 }),
    }, currentViewportAgendaLabel());
    const entityMarkers = model.entities.map((item) => buildMinimapEntityMarker(item, model));
    const viewportMarker = el('div', {
      class: 'egd-minimap-viewport',
      style: worldRectToMinimapStyle(model.viewport, model, { minSize: 8 }),
      title: `Viewport · ${Math.round((state.zoomTarget || state.zoom || 1) * 100)}%`,
    });
    map.appendChild(agendaRegion);
    for (const marker of entityMarkers) map.appendChild(marker);
    map.appendChild(viewportMarker);
    map._egdeskMinimapModel = model;
    return model;
  }

  function buildDeskMinimapEntityRows() {
    const entities = Array.from(document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape')).slice(0, 8);
    if (entities.length === 0) {
      return [el('div', { class: 'egd-minimap-empty' }, '현재 캔버스에 표시된 카드가 없습니다.')];
    }
    return entities.map((entity) => {
      const isActive = entity.id && entity.id === state.activeEntityId;
      const kind = entity.classList.contains('egd-canvas-card')
        ? cardLabelForViewportRail(entity)
        : entity.dataset.shapeType === 'ellipse' ? 'Ellipse'
          : entity.dataset.shapeType === 'line' ? 'Line'
            : 'Rect';
      return el('button', {
        class: 'egd-minimap-row' + (isActive ? ' egd-minimap-row-active' : ''),
        title: `${kind} focus`,
        onclick: () => {
          focusCanvasCard(entity);
          closeDeskMinimap();
        },
      },
        el('span', { class: 'egd-minimap-row-dot' }),
        el('span', { class: 'egd-minimap-row-label' }, kind),
      );
    });
  }

  function refreshDeskMinimap() {
    const panel = document.getElementById('egd-desk-minimap');
    if (!panel) return;
    renderDeskMinimapWorld(panel);
    const list = panel.querySelector('.egd-minimap-list');
    if (list) list.replaceChildren(...buildDeskMinimapEntityRows());
  }

  function deskMinimapSnapshot() {
    const panel = document.getElementById('egd-desk-minimap');
    const map = panel?.querySelector('.egd-minimap-map') || null;
    const model = map ? minimapWorldModel(map) : minimapDeskBounds();
    const viewportMarker = panel?.querySelector('.egd-minimap-viewport') || null;
    const rectOf = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    return {
      open: !!panel,
      bounds: model.bounds,
      viewport: model.viewport,
      entityCount: model.entities?.length || 0,
      density: model.density,
      sparsity: model.sparsity,
      spreadRatio: model.spreadRatio,
      zoom: state.zoomTarget || state.zoom || 1,
      mapWidth: model.mapWidth || 0,
      mapHeight: model.mapHeight || 0,
      dimensions: model.dimensions || null,
      mapRect: rectOf(map),
      viewportBoxRect: rectOf(viewportMarker),
    };
  }

  function installDeskMinimapPan(panel) {
    const map = panel.querySelector('.egd-minimap-map');
    if (!map) return;
    let drag = null;
    const setFromEvent = (ev) => {
      const model = minimapWorldModel(map);
      const point = minimapPointToWorld(ev.clientX, ev.clientY, map, model);
      const viewport = viewportWorldRect();
      let nextLeft;
      let nextTop;
      if (drag?.mode === 'box') {
        nextLeft = point.x - drag.offsetX;
        nextTop = point.y - drag.offsetY;
      } else {
        nextLeft = point.x - viewport.width / 2;
        nextTop = point.y - viewport.height / 2;
      }
      moveCanvasViewportToWorld(nextLeft, nextTop, { immediate: true });
      refreshDeskMinimap();
    };
    map.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target?.closest?.('.egd-minimap-entity')) return;
      const model = minimapWorldModel(map);
      const point = minimapPointToWorld(ev.clientX, ev.clientY, map, model);
      const viewport = viewportWorldRect();
      if (ev.target?.classList?.contains('egd-minimap-viewport')) {
        drag = { mode: 'box', offsetX: point.x - viewport.left, offsetY: point.y - viewport.top };
      } else {
        drag = { mode: 'center' };
        setFromEvent(ev);
      }
      map.classList.add('egd-minimap-dragging');
      ev.preventDefault();
      ev.stopPropagation();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      setFromEvent(ev);
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
    window.addEventListener('mouseup', (ev) => {
      if (!drag) return;
      drag = null;
      map.classList.remove('egd-minimap-dragging');
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
  }

  function toggleDeskMinimap() {
    const existing = document.getElementById('egd-desk-minimap');
    if (existing) {
      existing.remove();
      return;
    }
    const panel = el('div', { id: 'egd-desk-minimap', class: 'egd-edge egd-frosted' },
      el('div', { class: 'egd-minimap-header' },
        el('div', { class: 'egd-minimap-title' }, 'Desk Minimap'),
        el('button', { class: 'egd-minimap-close', title: '닫기', onclick: closeDeskMinimap }, '×'),
      ),
      el('div', { class: 'egd-minimap-map' }),
      el('div', { class: 'egd-minimap-caption' }, '100% · 0 objects · 1x spread'),
      el('div', { class: 'egd-minimap-list' }, ...buildDeskMinimapEntityRows()),
    );
    document.documentElement.appendChild(panel);
    installDeskMinimapPan(panel);
    refreshDeskMinimap();
  }

  // ============ Top: Viewport Agenda Rail ============
  function buildDeskRail() {
    const rail = el('div', { id: 'egd-desk-rail', class: 'egd-edge egd-frosted' });

    const left = el('div', { class: 'egd-rail-section egd-rail-left' },
      el('button', { class: 'egd-rail-switcher', title: 'Agenda 전환', onclick: toggleAgendaSwitcher },
        el('span', { class: 'egd-rail-desk-dot' }),
        el('span', { class: 'egd-rail-desk-name egd-rail-agenda-name' }, currentViewportAgendaLabel()),
        el('span', { class: 'egd-rail-dirty-badge', hidden: !state.agenda.dirty }, 'Unsaved'),
        el('span', { class: 'egd-rail-card-badge', hidden: true }),
        el('span', { class: 'egd-rail-chevron' }, '▾'),
      ),
    );

    const searchInput = el('input', {
      type: 'text',
      class: 'egd-rail-search-input',
      placeholder: '검색 또는 AI에게 요청...',
      value: state.railSearch.query,
      onfocus: () => openRailSearchPanel(),
      oninput: (ev) => setRailSearchQuery(ev.target.value),
      onkeydown: (ev) => {
        try {
          handleRailSearchKeydown(ev, searchInput);
        } catch (e) {
          console.error(TAG, 'rail search failed', e);
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
      el('button', {
        class: 'egd-rail-icon egd-rail-save-btn',
        title: 'Agenda 저장',
        hidden: !state.agenda.dirty,
        onclick: (ev) => {
          ev.stopPropagation();
          saveCurrentAgendaState();
        },
      }, '💾'),
      el('button', {
        class: 'egd-rail-icon egd-rail-restore-btn',
        title: '저장된 Agenda 복원',
        hidden: !state.agenda.hasSavedState,
        onclick: (ev) => {
          ev.stopPropagation();
          restoreSavedAgendaState();
        },
      }, '↺'),
      el('button', {
        class: 'egd-rail-icon egd-rail-close-agenda-btn',
        title: 'Agenda 닫기',
        onclick: (ev) => {
          ev.stopPropagation();
          closeCurrentAgenda();
        },
      }, '×'),
      el('button', { class: 'egd-rail-icon', title: '미니맵', onclick: toggleDeskMinimap }, '◱'),
      el('button', { class: 'egd-rail-icon', title: '알림' },
        '🔔',
        el('span', { class: 'egd-rail-badge' }, '3'),
      ),
      el('div', { class: 'egd-rail-avatar', title: '프로필' }, 'M'),
    );

    rail.appendChild(left);
    rail.appendChild(center);
    rail.appendChild(right);
    queueMicrotask(syncViewportAgendaRail);
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
              syncActiveToolMode();
              for (const b of g.querySelectorAll('.egd-dock-btn')) {
                b.classList.toggle('egd-dock-btn-active', b.dataset.id === item.id);
              }
            } else if (kind === 'left') {
              if (item.id === 'browser') {
                spawnBrowserCard();
              } else if (item.id === 'terminal') {
                spawnTerminalCard();
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
            } else if (kind === 'right' && item.id === 'trash') {
              deleteSelectedEntities();
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

  function openUrlInBrowserCard(url, options = {}) {
    const card = spawnBrowserCard(url, { openMode: options.openMode || 'focus-existing' });
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
      bindCardSourceRef(existing, browserSourceRef(url, { scope: 'codex-auth', accountId: String(authSessionId || '') }));
      existing.style.zIndex = String(++cardZ);
      setActiveEntity(existing);
      return existing;
    }

    const card = spawnBrowserCard(url, {
      openMode: 'new',
      sourceRef: { scope: 'codex-auth', accountId: String(authSessionId || '') },
    });
    card.dataset.codexAuthSessionId = String(authSessionId);
    card.dataset.codexRole = 'auth';
    bindCardSourceRef(card, browserSourceRef(url, { scope: 'codex-auth', accountId: String(authSessionId || '') }));
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
        ? 'Codex 점검 필요'
        : (codex.connected ? 'Codex 연결됨' : 'Codex 연결 대기');
      const statusAccount = codex.authStatus.isLoggedIn
        ? '로그인됨'
        : ((codex.isStartingLogin || codex.authStatus.loginInProgress) ? '로그인 중…' : '로그인 필요');
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
      const chromeRow = el('div', { class: 'egd-codex-chrome-row' },
        el('div', { class: 'egd-codex-chrome-main' },
          el('span', { class: `egd-codex-chrome-indicator egd-codex-chrome-indicator-${indicatorState}` }),
          el('div', { class: 'egd-codex-chrome-status' },
            el('span', { class: `egd-codex-system-chip egd-codex-system-chip-${indicatorState}` }, statusBridge),
            el('span', { class: `egd-codex-system-chip${codex.authStatus.isLoggedIn ? ' egd-codex-system-chip-ok' : ''}` }, statusAccount),
          ),
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
        threadTop.appendChild(el('div', { class: 'egd-codex-thread-home-head' },
          el('div', { class: 'egd-codex-thread-home-title-row' },
            el('div', { class: 'egd-codex-thread-home-title' }, 'Chat'),
            el('button', {
              class: 'egd-codex-thread-home-new',
              title: '새 Agent DM',
              onclick: () => codexBridge.createThread('dm', { openConversation: true }),
            }, '+'),
          ),
          el('div', { class: 'egd-codex-thread-home-sub' }, 'Agent DM · Agenda Thread'),
          el('div', { class: 'egd-codex-thread-home-status' }, `${codexBridgeSummary(codex)} · ${codexAuthSummary(codex)}`),
          el('div', { class: 'egd-codex-thread-session-summary' },
            el('div', { class: 'egd-codex-thread-session-pill' }, `Agent ${dmThreads.length}`),
            el('div', { class: 'egd-codex-thread-session-pill' }, `Agenda ${groupThreads.length}`),
            el('div', { class: 'egd-codex-thread-session-pill' }, `Unread ${unreadCountTotal}`),
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
        { key: 'dm', label: 'Agent' },
        { key: 'group', label: 'Agenda' },
      ];
      for (const filterDef of filterDefs) {
        const selected = threadFilter === filterDef.key;
        filterRow.appendChild(el('button', {
          class: `egd-codex-thread-filter-chip${selected ? ' egd-codex-thread-filter-chip-active' : ''}`,
          onclick: () => codexBridge.setThreadFilter(filterDef.key),
          title: `${filterDef.label} 보기`,
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
        const excludedIds = options.excludeIds instanceof Set ? options.excludeIds : null;
        const recordIds = options.recordIds instanceof Set ? options.recordIds : null;
        const safeThreads = (Array.isArray(threads) ? threads : [])
          .filter((thread) => !excludedIds || !excludedIds.has(thread.id));
        const limitedThreads = Number.isInteger(options.limit) ? safeThreads.slice(0, Math.max(0, options.limit)) : safeThreads;
        const headChildren = [el('span', { class: 'egd-codex-thread-section-title' }, label)];
        if (options.allowCreate && options.type) {
          headChildren.push(el('button', {
            class: 'egd-codex-thread-add',
            title: codexThreadKindMeta(options.type).createTitle,
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
          if (recordIds) recordIds.add(thread.id);
          const threadMenuOpen = Boolean(codex.threadMenu && codex.threadMenu.threadId === thread.id);
          const item = el('div', {
            class: `egd-codex-thread-item${activeThread && thread.id === activeThread.id ? ' egd-codex-thread-item-active' : ''}${threadMenuOpen ? ' egd-codex-thread-item-menu-open' : ''}`,
          });
          item.addEventListener('click', () => codexBridge.selectThread(thread.id, { openConversation: mode === 'hud' }));
          const lastMsg = thread.messages && thread.messages.length > 0 ? thread.messages[thread.messages.length - 1] : null;
          const lastTime = lastMsg && lastMsg.createdAt ? formatRelativeTime(lastMsg.createdAt) : '';
          const kindMeta = codexThreadKindMeta(thread.type);
          const sessionLabel = codexThreadSessionLabel(thread);
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
                  el('div', { class: 'egd-codex-thread-meta-row' },
                    el('span', { class: `egd-codex-thread-kind egd-codex-thread-kind-${thread.type}` }, kindMeta.label),
                    el('span', { class: `egd-codex-session-badge egd-codex-session-badge-${sessionLabel.toLowerCase()}` }, sessionLabel),
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
        const renderedThreadIds = new Set();
        const unreadSection = renderThreadSection('읽지 않음', typeScopedUnread, {
          limit: 4,
          renderWhenEmpty: false,
          recordIds: renderedThreadIds,
        });
        if (unreadSection) threadRail.appendChild(unreadSection);
        const pinnedSection = renderThreadSection('고정', typeScopedPinned, {
          limit: 4,
          renderWhenEmpty: false,
          excludeIds: renderedThreadIds,
          recordIds: renderedThreadIds,
        });
        if (pinnedSection) threadRail.appendChild(pinnedSection);
        const recentSection = renderThreadSection('최근 작업', typeScopedRecent, {
          limit: 4,
          renderWhenEmpty: renderedThreadIds.size === 0,
          emptyText: '최근 작업 세션이 없습니다',
          excludeIds: renderedThreadIds,
          recordIds: renderedThreadIds,
        });
        if (recentSection) threadRail.appendChild(recentSection);
        const allSection = renderThreadSection('전체', typeScopedThreads, {
          excludeIds: renderedThreadIds,
          renderWhenEmpty: renderedThreadIds.size === 0,
          emptyText: '조건에 맞는 채팅방이 없습니다',
        });
        if (allSection) threadRail.appendChild(allSection);
      } else {
        const allSection = renderThreadSection('전체', typeScopedThreads, {
          renderWhenEmpty: true,
          emptyText: '조건에 맞는 채팅방이 없습니다',
        });
        if (allSection) threadRail.appendChild(allSection);
      }

      const hasConversation = Boolean(activeThread && activeThread.messages.length > 0);
      const showConversation = Boolean(activeThread);
      const conversation = showConversation ? el('div', { class: 'egd-codex-conversation-pane' }) : null;
      if (conversation && activeThread) {
        if (mode === 'hud') {
          const threadMenuOpen = Boolean(codex.threadMenu && codex.threadMenu.threadId === activeThread.id);
          const titleSubtitle = codexThreadHeaderSubtitle(activeThread);
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
              }, 'Agenda에서 제거'),
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
            el('div', { class: 'egd-codex-thread-active-sub' }, codexThreadHeaderSubtitle(activeThread)),
            memberRowWrap,
          ));
        }

        const messages = el('div', { class: 'egd-codex-messages' });
        if (!hasConversation) {
          const activeKindLabel = codexThreadLongLabel(activeThread.type);
          const emptyChildren = [
            el('div', { class: 'egd-codex-empty-title' }, codex.authStatus.isLoggedIn ? '아직 메시지가 없습니다' : '로그인 후 대화할 수 있습니다'),
            el('div', { class: 'egd-codex-empty-sub' },
              codex.authStatus.isLoggedIn
                ? `${activeKindLabel} · ${codexThreadSessionLabel(activeThread)}`
                : 'Codex 로그인이 필요합니다.',
            ),
          ];
          if (!codex.authStatus.isLoggedIn) {
            emptyChildren.push(el('div', { class: 'egd-codex-empty-actions' },
              el('button', {
                class: 'egd-codex-chip egd-codex-chip-primary',
                disabled: (codex.isStartingLogin || codex.authStatus.loginInProgress) ? 'true' : null,
                onclick: () => codexBridge.startLogin(),
              }, (codex.isStartingLogin || codex.authStatus.loginInProgress) ? '로그인 중…' : '로그인'),
              el('button', {
                class: 'egd-codex-chip egd-codex-chip-subtle',
                onclick: () => codexBridge.refreshAuthStatus(),
              }, '상태 새로고침'),
            ));
          }
          messages.appendChild(el('div', { class: 'egd-codex-empty-state' }, ...emptyChildren));
        } else {
          activeThread.messages.forEach((message, index) => {
            const previous = activeThread.messages[index - 1] || null;
            const next = activeThread.messages[index + 1] || null;
            const previousDelta = message.createdAt && previous?.createdAt ? Math.abs(message.createdAt - previous.createdAt) : Infinity;
            const nextDelta = message.createdAt && next?.createdAt ? Math.abs(next.createdAt - message.createdAt) : Infinity;
            const groupedWithPrevious = previous?.role === message.role && previousDelta < 120000;
            const groupedWithNext = next?.role === message.role && nextDelta < 120000;
            const parts = extractCodexResultLinks(message);
            const content = el('div', { class: 'egd-codex-bubble-content egd-codex-richtext' });
            appendRichText(content, parts.text || (message.status === 'streaming' ? '…' : ''));
            const resultChips = buildCodexResultChips(message, activeThread, parts.links);
            const bubble = el('div', {
              class: [
                'egd-codex-bubble',
                `egd-codex-bubble-${message.role}`,
                groupedWithPrevious ? 'egd-codex-bubble-grouped-prev' : '',
                groupedWithNext ? 'egd-codex-bubble-grouped-next' : '',
                message.status === 'error' ? 'egd-codex-bubble-error' : '',
              ].filter(Boolean).join(' '),
            },
            content,
            resultChips,
            );
            if (message.status === 'streaming' && message.role === 'assistant') {
              bubble.appendChild(el('div', { class: 'egd-codex-streaming' }, el('div', { class: 'egd-codex-typing-dots' }, el('span'), el('span'), el('span')), '코덱스가 입력 중'));
            }
            const roleLabel = !groupedWithPrevious && message.role !== 'user'
              ? el('div', { class: 'egd-codex-message-role' }, codexMessageRoleLabel(message.role))
              : null;
            const meta = codexMessageTimeMeta(message, activeThread);
            const lineChildren = message.role === 'user'
              ? [meta, bubble]
              : [bubble, meta];
            const messageLine = el('div', { class: 'egd-codex-message-line' }, ...lineChildren);
            const messageStack = el('div', { class: 'egd-codex-message-stack' }, roleLabel, messageLine);
            const avatar = message.role !== 'user'
              ? el('div', {
                  class: `egd-codex-message-avatar${groupedWithPrevious ? ' egd-codex-message-avatar-spacer' : ''}`,
                  title: groupedWithPrevious ? '' : codexMessageRoleLabel(message.role),
                }, groupedWithPrevious ? '' : codexMessageRoleLabel(message.role).slice(0, 1))
              : null;
            messages.appendChild(el('div', {
              class: [
                'egd-codex-message-row',
                `egd-codex-message-row-${message.role || 'assistant'}`,
                groupedWithPrevious ? 'egd-codex-message-row-grouped' : '',
              ].filter(Boolean).join(' '),
            }, avatar, messageStack));
          });
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
            const input = el('textarea', {
              class: 'egd-codex-input',
              rows: '1',
              placeholder: `${codexThreadLongLabel(activeThread.type)}에 메시지 보내기…`,
              disabled: codex.isSending ? 'true' : null,
            });
            input.value = getCodexThreadDraft(codex, activeThread.id);
            const resizeComposer = () => {
              input.style.height = 'auto';
              input.style.height = `${Math.min(104, Math.max(22, input.scrollHeight))}px`;
            };
            input.addEventListener('input', () => {
              codexBridge.setDraft(input.value, activeThread.id);
              resizeComposer();
            });
            input.addEventListener('keydown', (ev) => {
              if (ev.key !== 'Enter') return;
              if (ev.shiftKey) return;
              ev.preventDefault();
              void codexBridge.sendMessage();
            });
            queueMicrotask(resizeComposer);
            return el('div', { class: 'egd-codex-footer' },
              el('div', { class: 'egd-codex-input-row' },
                input,
                el('button', {
                  class: 'egd-codex-send',
                  disabled: codex.isSending ? 'true' : null,
                  onclick: () => codexBridge.sendMessage(),
                }, codex.isSending ? '…' : '보내기'),
              ),
              el('div', { class: 'egd-codex-input-hint' }, 'Enter 전송 · Shift+Enter 줄바꿈'),
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
    const showHelperStatus = document.documentElement.dataset.egdRuntimeDiagnostics === 'true';
    const status = showHelperStatus ? el('div', { id: 'egd-input-helper-status' }, '입력 보조: 꺼짐') : null;
    if (status) document.documentElement.appendChild(status);

    let source = null;
    let retryTimer = null;
    let lastLatency = null;

    const updateStatus = (text, mode = 'off') => {
      if (!status) return;
      status.textContent = text;
      status.dataset.mode = mode;
    };

    const scheduleReconnect = () => {
      if (retryTimer) return;
      updateStatus('입력 보조: 재연결 중', 'off');
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
        updateStatus(lastLatency == null ? '입력 보조: 켜짐' : `입력 보조: ${lastLatency}ms`, 'on');
      });

      source.addEventListener('gesture', (event) => {
        try {
          const payload = JSON.parse(event.data);
          lastLatency = Math.max(0, Date.now() - payload.tsMs);
          updateStatus(`입력 보조 ${payload.kind.replace('gestureScroll', '')}: ${lastLatency}ms`, 'on');
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
        const label = normalizedType === 'group' ? `Agenda ${nextNonce}` : `Agent ${nextNonce}`;
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
    if (card) {
      closeCanvasCard(card);
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
    const safe = safeViewportRect({ avoidHud: true });
    const zoom = Math.max(0.001, state.zoomTarget || state.zoom || 1);
    const width = Math.min(560, Math.max(420, Math.floor(safe.width / zoom)));
    const height = Math.min(680, Math.max(420, Math.floor(safe.height / zoom)));
    const placement = resolveCanvasCardPlacement(width, height, {
      anchorClientX,
      anchorClientY,
      avoidHud: true,
      offset: ((cardSeq - 1) % 4) * 22,
    });
    const card = el('div', {
      id,
      class: 'egd-canvas-card egd-chat-card',
      style: {
        top: Math.round(placement.y) + 'px',
        left: Math.round(placement.x) + 'px',
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
        }, '우측'),
        el('button', {
          class: 'egd-chat-card-action',
          title: '닫기',
          onclick: (ev) => {
            ev.stopPropagation();
            closeCanvasCard(card, cleanup);
          },
        }, '×'),
      ),
    );
    const body = el('div', { class: 'egd-chat-card-body' });
    card.appendChild(header);
    card.appendChild(body);

    const host = document.getElementById('egd-canvas-layer') || document.documentElement;
    host.appendChild(card);
    bindCardSourceRef(card, currentChatSourceRef());
    markAgendaDirty('create-chat-card', card);
    setActiveEntity(card);

    const syncChatCardLayoutMode = () => {
      const compact = card.getBoundingClientRect().width < 680;
      card.classList.toggle('egd-chat-card-compact', compact);
    };
    const chatCardResizeObserver = new ResizeObserver(syncChatCardLayoutMode);
    chatCardResizeObserver.observe(card);
    queueMicrotask(syncChatCardLayoutMode);

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
      focusCanvasCard(card);
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
      if (isCardFullscreen(card)) return;
      if (ev.button !== 0 || ev.target.closest('button')) return;
      focusCard();
      drag = { x: ev.clientX, y: ev.clientY, left: card.offsetLeft, top: card.offsetTop };
      ev.preventDefault();
    });
    installCardHeaderFullscreenToggle(card, header);
    body.addEventListener('wheel', routeWheelToCanvas, { passive: false });
    for (const target of [card, header, body]) {
      target.addEventListener('mousedown', () => activateCard(), true);
      target.addEventListener('wheel', routeWheelToCanvas, { passive: false, capture: true });
    }
    const onMove = (ev) => {
      const s = canvasZoom();
      if (!drag) return;
      card.style.left = (drag.left + (ev.clientX - drag.x) / s) + 'px';
      card.style.top = (drag.top + (ev.clientY - drag.y) / s) + 'px';
    };
    const onUp = () => {
      if (drag) markAgendaDirty('move-chat-card', card);
      drag = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    const cleanup = () => {
      body?._codexCleanup?.();
      try { chatCardResizeObserver.disconnect(); } catch {}
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
  const CARD_HEADER_H = 52;
  const CARD_ASPECT = CARD_LOGICAL_H / CARD_LOGICAL_W;
  const cardHeightForWidth = (width) => Math.round(CARD_HEADER_H + width * CARD_ASPECT);

  function canvasZoom() {
    return Math.max(0.001, state.zoom || state.zoomTarget || 1);
  }

  function isCardFullscreen(card) {
    return !!card && state.cardFullscreen?.cardId === card.id;
  }

  function getCardRect(card) {
    return {
      left: card.style.left || card.offsetLeft + 'px',
      top: card.style.top || card.offsetTop + 'px',
      width: card.style.width || card.offsetWidth + 'px',
      height: card.style.height || card.offsetHeight + 'px',
      zIndex: card.style.zIndex || '',
    };
  }

  function applyCardRect(card, rect) {
    if (!card || !rect) return;
    card.style.left = rect.left;
    card.style.top = rect.top;
    card.style.width = rect.width;
    card.style.height = rect.height;
    card.style.zIndex = rect.zIndex;
  }

  function setHudPresentationHidden(hidden) {
    const hud = document.getElementById('egd-hud');
    if (!hud) return;
    hud.classList.toggle('egd-hud-hidden', hidden);
  }

  function syncCardFullscreenLayout() {
    const fullscreen = state.cardFullscreen;
    if (!fullscreen) return;
    const card = document.getElementById(fullscreen.cardId);
    if (!card || !card.isConnected) {
      state.cardFullscreen = null;
      document.documentElement.classList.remove('egd-card-fullscreen-active');
      syncViewportAgendaRail();
      return;
    }
    const zoom = canvasZoom();
    const safe = safeViewportRect({ avoidHud: false, margin: 10 });
    card.style.left = ((safe.left - state.pan.x) / zoom) + 'px';
    card.style.top = ((safe.top - state.pan.y) / zoom) + 'px';
    card.style.width = (safe.width / zoom) + 'px';
    card.style.height = (safe.height / zoom) + 'px';
    card.style.zIndex = String(fullscreen.zIndex);
    syncViewportAgendaRail();
  }

  function enterCardFullscreen(card) {
    if (!card || !card.isConnected) return;
    if (state.cardFullscreen && state.cardFullscreen.cardId !== card.id) {
      exitCardFullscreen();
    }
    if (isCardFullscreen(card)) return;
    const hud = document.getElementById('egd-hud');
    const previousHudHidden = hud ? hud.classList.contains('egd-hud-hidden') : true;
    state.cardFullscreen = {
      cardId: card.id,
      rect: getCardRect(card),
      previousHudHidden,
      zIndex: ++cardZ,
    };
    setActiveEntity(card);
    card.classList.add('egd-card-fullscreen');
    document.documentElement.classList.add('egd-card-fullscreen-active');
    setHudPresentationHidden(true);
    syncCardFullscreenLayout();
    syncViewportAgendaRail();
  }

  function exitCardFullscreen(card = null, options = {}) {
    const fullscreen = state.cardFullscreen;
    if (!fullscreen) return false;
    if (card && fullscreen.cardId !== card.id) return false;
    const fullscreenCard = document.getElementById(fullscreen.cardId);
    if (fullscreenCard) {
      fullscreenCard.classList.remove('egd-card-fullscreen');
      if (options.restoreRect !== false) applyCardRect(fullscreenCard, fullscreen.rect);
    }
    document.documentElement.classList.remove('egd-card-fullscreen-active');
    state.cardFullscreen = null;
    setHudPresentationHidden(fullscreen.previousHudHidden);
    if (fullscreenCard?.isConnected) setActiveEntity(fullscreenCard);
    syncViewportAgendaRail();
    return true;
  }

  function toggleCardFullscreen(card) {
    if (isCardFullscreen(card)) exitCardFullscreen(card);
    else enterCardFullscreen(card);
  }

  function focusCanvasCard(card) {
    if (!card || !card.isConnected || state.panModifier) return;
    setActiveEntity(card);
    if (!isCardFullscreen(card)) card.style.zIndex = String(++cardZ);
  }

  function closeCanvasCard(card, cleanup) {
    if (!card) return;
    if (isCardFullscreen(card)) exitCardFullscreen(card, { restoreRect: false });
    unregisterSourceRefCard(card);
    try {
      if (typeof cleanup === 'function') cleanup();
      else if (typeof card._cleanup === 'function') card._cleanup();
    } catch (error) {
      console.warn(TAG, 'card cleanup failed', error);
    }
    if (state.activeEntityId === card.id) setActiveEntity(null);
    card.remove();
    markAgendaDirty('close-card', card);
  }

  function installCardHeaderFullscreenToggle(card, header) {
    header.addEventListener('dblclick', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest('input, button, .egd-card-dot')) return;
      focusCanvasCard(card);
      toggleCardFullscreen(card);
      ev.preventDefault();
      ev.stopPropagation();
    });
  }

  // ============ Canvas Shapes ============
  function createCanvasShape(type = 'rect') {
    const shape = el('div', {
      id: `egd-shape-${++cardSeq}`,
      class: `egd-canvas-shape egd-canvas-shape-${type}`,
      data: { shapeType: type },
      title: type === 'ellipse' ? '원' : type === 'line' ? '선' : '사각형',
      style: { zIndex: String(++cardZ) },
    });
    if (type === 'line') {
      shape.appendChild(el('span', { class: 'egd-canvas-shape-line-stroke' }));
    }
    shape._sourceRef = makeSourceRef('canvas-shape', {
      id: shape.id,
      scope: state.agenda.activeAgendaId,
    });
    installShapeInteractions(shape);
    return shape;
  }

  function updateCanvasShapeGeometry(shape, start, current, options = {}) {
    const type = shape?.dataset?.shapeType || 'rect';
    if (type === 'line') {
      const dx = current.x - start.x;
      const dy = current.y - start.y;
      let length = Math.hypot(dx, dy);
      let angle = Math.atan2(dy, dx) * 180 / Math.PI;
      if (options.defaultSize && length < 8) {
        length = 140;
        angle = 0;
      }
      shape.style.left = `${Math.round(start.x)}px`;
      shape.style.top = `${Math.round(start.y - 8)}px`;
      shape.style.width = `${Math.max(12, Math.round(length))}px`;
      shape.style.height = '16px';
      shape.style.transform = `rotate(${angle}deg)`;
      shape.dataset.x1 = String(start.x);
      shape.dataset.y1 = String(start.y);
      shape.dataset.x2 = String(current.x);
      shape.dataset.y2 = String(current.y);
      return;
    }

    let left = Math.min(start.x, current.x);
    let top = Math.min(start.y, current.y);
    let width = Math.abs(current.x - start.x);
    let height = Math.abs(current.y - start.y);
    if (options.defaultSize && width < 8 && height < 8) {
      width = type === 'ellipse' ? 96 : 140;
      height = type === 'ellipse' ? 96 : 88;
      left = start.x - width / 2;
      top = start.y - height / 2;
    }
    shape.style.left = `${Math.round(left)}px`;
    shape.style.top = `${Math.round(top)}px`;
    shape.style.width = `${Math.max(12, Math.round(width))}px`;
    shape.style.height = `${Math.max(12, Math.round(height))}px`;
  }

  function installShapeInteractions(shape) {
    let drag = null;
    shape.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if (state.panModifier) {
        if (typeof state.startCanvasPanDrag === 'function') state.startCanvasPanDrag(ev);
        return;
      }
      setActiveEntity(shape);
      shape.style.zIndex = String(++cardZ);
      drag = {
        x: ev.clientX,
        y: ev.clientY,
        left: parseFloat(shape.style.left) || 0,
        top: parseFloat(shape.style.top) || 0,
      };
      ev.preventDefault();
      ev.stopPropagation();
    });
    const onMove = (ev) => {
      if (!drag) return;
      const zoom = canvasZoom();
      shape.style.left = `${drag.left + (ev.clientX - drag.x) / zoom}px`;
      shape.style.top = `${drag.top + (ev.clientY - drag.y) / zoom}px`;
    };
    const onUp = () => {
      if (drag) markAgendaDirty('move-shape', shape);
      drag = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    shape._cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }

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
    const sourceRef = singletonSourceRef('settings', { kind: 'settings-card' });
    const existing = focusOpenSourceCard(sourceRef);
    if (existing) return existing;

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
            el('span', { class: 'egd-card-dot egd-card-dot-close', onclick: (ev) => { ev.stopPropagation(); closeCanvasCard(card); } }),
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
    bindCardSourceRef(card, sourceRef);
    markAgendaDirty('create-settings-card', card);
    setActiveEntity(card);

    renderTabs();
    renderModelsTab();

    // Drag support
    let drag = null;
    header.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('input, button, .egd-card-dot')) return;
      if (isCardFullscreen(card)) return;
      focusCanvasCard(card);
      drag = { x: ev.clientX, y: ev.clientY, left: card.offsetLeft, top: card.offsetTop };
      ev.preventDefault();
    });
    installCardHeaderFullscreenToggle(card, header);
    const onMove = (ev) => {
      if (!drag) return;
      const s = canvasZoom();
      card.style.left = (drag.left + (ev.clientX - drag.x) / s) + 'px';
      card.style.top = (drag.top + (ev.clientY - drag.y) / s) + 'px';
    };
    const onUp = () => {
      if (drag) markAgendaDirty('move-settings-card', card);
      drag = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    card._cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    return card;
  }

  function resolveBrowserCard(cardOrId = null) {
    let card = null;
    if (typeof cardOrId === 'string') {
      card = document.getElementById(cardOrId);
    } else if (cardOrId?.nodeType === 1) {
      card = cardOrId.classList?.contains('egd-browser-card')
        ? cardOrId
        : cardOrId.closest?.('.egd-browser-card');
    }
    if (!card && state.activeEntityId) {
      const active = document.getElementById(state.activeEntityId);
      if (active?.classList?.contains('egd-browser-card')) card = active;
    }
    if (!card) card = document.querySelector('.egd-browser-card');
    return card?.classList?.contains('egd-browser-card') ? card : null;
  }

  function browserCardState(cardOrId = null) {
    const card = resolveBrowserCard(cardOrId);
    if (!card) return null;
    if (typeof card._browserControls?.getState === 'function') {
      return card._browserControls.getState();
    }
    const uri = normalizeBrowserUri(card.querySelector('.egd-card-url')?.value || card._sourceRef?.uri || 'https://duckduckgo.com');
    return {
      cardId: card.id,
      uri,
      title: browserDisplayHost(uri),
      security: browserSecurityLabel(uri),
      loading: false,
      canGoBack: false,
      canGoForward: false,
      sourceKey: card.dataset.sourceKey || '',
    };
  }

  function browserCardControl(cardOrId, command, ...args) {
    const card = resolveBrowserCard(cardOrId);
    const controls = card?._browserControls;
    if (!controls || typeof controls[command] !== 'function') return null;
    return controls[command](...args);
  }


  function spawnBrowserCard(initialUrl = 'https://duckduckgo.com', options = {}) {
    const normalizedUrl = normalizeBrowserUri(initialUrl);
    const sourceRef = browserSourceRef(normalizedUrl, options.sourceRef || {});
    const openMode = normalizeOpenMode(options.openMode, 'new');
    if (openMode === 'focus-existing') {
      const existing = focusOpenSourceCard(sourceRef);
      if (existing) return existing;
    }

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
      value: normalizedUrl,
    });
    let xulBrowser = null;
    let browserLoadTimer = 0;
    let browserMenuPanel = null;
    const agentRefByNode = new WeakMap();
    const agentNodeByRef = new Map();
    let agentRefSeq = 0;
    let agentActionSeq = 0;
    let agentBridgeInstalled = false;
    let agentBridgeSeq = 0;
    const agentBridgePending = new Map();
    const agentActionHistory = [];
    const agentBridgeId = [
      card.id,
      Date.now().toString(36),
      Math.random().toString(36).slice(2, 8),
    ].join('-');
    const agentBridgeRequestTopic = `egdesk:agent-request:${agentBridgeId}`;
    const agentBridgeResponseTopic = `egdesk:agent-response:${agentBridgeId}`;
    const browserState = {
      uri: normalizedUrl,
      title: browserDisplayHost(normalizedUrl),
      loading: true,
      canGoBack: false,
      canGoForward: false,
      security: browserSecurityLabel(normalizedUrl),
      homeUrl: normalizeBrowserUri(options.homeUrl || 'https://duckduckgo.com'),
      history: [normalizedUrl],
      historyIndex: 0,
    };

    const pageTitle = el('div', { class: 'egd-card-page-title' }, browserState.title);
    const pageStatus = el('div', { class: 'egd-card-page-status' }, 'Loading');
    const securityIcon = el('span', {
      class: 'egd-card-omnibox-icon egd-card-security',
      title: browserState.security,
    }, browserSecurityGlyph(normalizedUrl));
    const progressStrip = el('div', { class: 'egd-card-progress' });
    const backButton = el('button', {
      class: 'egd-card-nav-btn',
      title: '뒤로',
      disabled: true,
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, 'back');
      },
    }, '←');
    const forwardButton = el('button', {
      class: 'egd-card-nav-btn',
      title: '앞으로',
      disabled: true,
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, 'forward');
      },
    }, '→');
    const reloadButton = el('button', {
      class: 'egd-card-nav-btn egd-card-reload',
      title: '새로고침',
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, browserState.loading ? 'stop' : 'reload');
      },
    }, '↻');
    const homeButton = el('button', {
      class: 'egd-card-nav-btn',
      title: '홈',
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, 'home');
      },
    }, '⌂');
    const duplicateButton = el('button', {
      class: 'egd-card-nav-btn',
      title: '복제',
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, 'duplicate');
      },
    }, '⧉');
    const menuButton = el('button', {
      class: 'egd-card-menu',
      title: '더보기',
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, 'menu', menuButton);
      },
    }, '⋮');

    const header = el('div', { class: 'egd-card-header' },
      el('div', { class: 'egd-card-topbar' },
        el('div', { class: 'egd-card-dots-shell' },
          el('div', { class: 'egd-card-dots' },
            el('span', { class: 'egd-card-dot egd-card-dot-close', onclick: (ev) => { ev.stopPropagation(); closeCanvasCard(card, cleanupCard); } }),
            el('span', { class: 'egd-card-dot egd-card-dot-min' }),
            el('span', { class: 'egd-card-dot egd-card-dot-max' }),
          ),
        ),
        el('div', { class: 'egd-card-page-meta' },
          pageTitle,
          pageStatus,
        ),
      ),
      el('div', { class: 'egd-card-toolbar' },
        el('div', { class: 'egd-card-nav' },
          backButton,
          forwardButton,
          reloadButton,
          homeButton,
        ),
        el('div', { class: 'egd-card-omnibox' },
          securityIcon,
          urlInput,
        ),
        duplicateButton,
        menuButton,
      ),
      progressStrip,
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
    bindCardSourceRef(card, sourceRef);
    markAgendaDirty('create-browser-card', card);
    setActiveEntity(card);

    try {
      xulBrowser = document.createXULElement('browser');
      xulBrowser.setAttribute('type', 'content');
      xulBrowser.setAttribute('remote', 'true');
      xulBrowser.setAttribute('maychangeremoteness', 'true');
      xulBrowser.setAttribute('disableglobalhistory', 'true');
      xulBrowser.setAttribute('flex', '1');
      xulBrowser.style.cssText = 'width:100%; height:100%; background:#fff; display:block;';
      wrap.appendChild(xulBrowser);
      xulBrowser.setAttribute('src', normalizedUrl);
    } catch (e) {
      console.error(TAG, 'XUL browser create failed, falling back to iframe', e);
      const frame = el('iframe', { src: normalizedUrl, style: { width: '100%', height: '100%', border: '0' } });
      wrap.appendChild(frame);
      xulBrowser = frame;
    }

    const getBrowserStateSnapshot = () => ({
      cardId: card.id,
      uri: browserState.uri,
      title: browserState.title,
      security: browserState.security,
      loading: browserState.loading,
      canGoBack: browserState.canGoBack,
      canGoForward: browserState.canGoForward,
      homeUrl: browserState.homeUrl,
      sourceKey: card.dataset.sourceKey || '',
      historyIndex: browserState.historyIndex,
      historyLength: browserState.history.length,
    });
    const readNativeHistoryFlags = () => {
      let canGoBack = false;
      let canGoForward = false;
      try { canGoBack = !!(xulBrowser?.canGoBack ?? xulBrowser?.webNavigation?.canGoBack); } catch {}
      try { canGoForward = !!(xulBrowser?.canGoForward ?? xulBrowser?.webNavigation?.canGoForward); } catch {}
      return { canGoBack, canGoForward };
    };
    const updateHistoryFlags = () => {
      const nativeHistory = readNativeHistoryFlags();
      browserState.canGoBack = browserState.historyIndex > 0 || nativeHistory.canGoBack;
      browserState.canGoForward = browserState.historyIndex < browserState.history.length - 1 || nativeHistory.canGoForward;
    };
    const pushBrowserHistory = (url, options = {}) => {
      const normalized = normalizeBrowserUri(url);
      if (!normalized) return;
      if (!Array.isArray(browserState.history) || browserState.history.length === 0) {
        browserState.history = [normalized];
        browserState.historyIndex = 0;
      } else if (options.replace) {
        browserState.history[browserState.historyIndex] = normalized;
      } else if (browserState.history[browserState.historyIndex] !== normalized) {
        browserState.history = browserState.history.slice(0, browserState.historyIndex + 1);
        browserState.history.push(normalized);
        browserState.historyIndex = browserState.history.length - 1;
      }
      updateHistoryFlags();
    };
    const readBrowserUri = () => {
      try {
        const uri = xulBrowser?.currentURI?.spec;
        if (uri) return uri;
      } catch {}
      try {
        const uri = xulBrowser?.webNavigation?.currentURI?.spec;
        if (uri) return uri;
      } catch {}
      try {
        const uri = xulBrowser?.getAttribute?.('src') || xulBrowser?.src;
        if (uri) return uri;
      } catch {}
      return browserState.uri;
    };
    const readRequestedBrowserUri = () => {
      try {
        const uri = xulBrowser?.getAttribute?.('src') || xulBrowser?.src;
        if (uri) return normalizeBrowserUri(uri);
      } catch {}
      return '';
    };
    const readBrowserTitle = () => {
      try {
        const title = xulBrowser?.contentTitle || xulBrowser?.contentDocument?.title;
        if (title) return String(title).trim();
      } catch {}
      return browserDisplayHost(browserState.uri);
    };
    const readBrowserDocument = () => {
      try {
        const doc = xulBrowser?.contentDocument || xulBrowser?.contentWindow?.document;
        if (doc?.documentElement) return doc;
      } catch {}
      try {
        const doc = xulBrowser?.browsingContext?.currentWindowGlobal?.document;
        if (doc?.documentElement) return doc;
      } catch {}
      try {
        const doc = xulBrowser?.ownerGlobal?.gBrowser?.selectedBrowser?.contentDocument;
        if (doc?.documentElement) return doc;
      } catch {}
      return null;
    };
    const compactAgentText = (value, max = 180) => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
    };
    const agentElementRef = (node) => {
      if (!node || typeof node !== 'object') return '';
      const existing = agentRefByNode.get(node);
      if (existing) return existing;
      const ref = `el_${++agentRefSeq}`;
      agentRefByNode.set(node, ref);
      agentNodeByRef.set(ref, node);
      return ref;
    };
    const agentNodeForRef = (ref) => {
      const node = agentNodeByRef.get(ref);
      return node?.isConnected ? node : null;
    };
    const isAgentVisibleElement = (node) => {
      if (!node?.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      try {
        const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
        if (style?.display === 'none' || style?.visibility === 'hidden' || Number(style?.opacity) === 0) return false;
      } catch {}
      return true;
    };
    const agentElementRole = (node) => {
      const explicitRole = node.getAttribute?.('role');
      if (explicitRole) return explicitRole;
      const tag = String(node.tagName || '').toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = String(node.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        if (['checkbox', 'radio', 'range', 'search', 'email', 'password', 'number', 'date', 'time'].includes(type)) return type;
        return 'textbox';
      }
      if (node.isContentEditable) return 'textbox';
      return tag || 'element';
    };
    const agentElementLabel = (node) => {
      const doc = node.ownerDocument;
      const ariaLabelledBy = node.getAttribute?.('aria-labelledby');
      if (ariaLabelledBy && doc) {
        const labelled = ariaLabelledBy.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' ');
        if (labelled.trim()) return compactAgentText(labelled);
      }
      const label = node.getAttribute?.('aria-label')
        || node.getAttribute?.('alt')
        || node.getAttribute?.('title')
        || node.getAttribute?.('placeholder')
        || node.innerText
        || node.textContent
        || node.getAttribute?.('name')
        || node.getAttribute?.('id')
        || node.value
        || '';
      return compactAgentText(label, 120);
    };
    const agentElementValue = (node) => {
      const tag = String(node.tagName || '').toLowerCase();
      if (tag === 'select') return compactAgentText(node.selectedOptions?.[0]?.textContent || node.value || '', 120);
      if (tag === 'textarea' || tag === 'input') return compactAgentText(node.value || '', 120);
      if (node.isContentEditable) return compactAgentText(node.innerText || node.textContent || '', 120);
      return '';
    };
    const agentElementSignature = (item) => [
      item.role || '',
      item.label || '',
      item.href || '',
      item.value || '',
    ].join('|');
    const agentVisibleTextSegments = (doc, limit = 80) => {
      const root = doc?.body || doc?.documentElement;
      if (!root) return [];
      const nodeFilter = doc.defaultView?.NodeFilter || window.NodeFilter;
      const walker = doc.createTreeWalker(root, nodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const text = compactAgentText(node.nodeValue, 180);
          if (!text || text.length < 2) return nodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || !isAgentVisibleElement(parent)) return nodeFilter.FILTER_REJECT;
          return nodeFilter.FILTER_ACCEPT;
        },
      });
      const seen = new Set();
      const segments = [];
      let node = walker.nextNode();
      while (node && segments.length < limit) {
        const text = compactAgentText(node.nodeValue, 180);
        if (text && !seen.has(text)) {
          seen.add(text);
          segments.push(text);
        }
        node = walker.nextNode();
      }
      return segments;
    };
    const agentInteractiveElements = (doc, limit = 80) => {
      if (!doc?.querySelectorAll) return [];
      const selector = [
        'a[href]',
        'button',
        'input',
        'textarea',
        'select',
        '[role]',
        '[tabindex]',
        '[contenteditable="true"]',
      ].join(',');
      return Array.from(doc.querySelectorAll(selector))
        .filter(isAgentVisibleElement)
        .slice(0, limit)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            ref: agentElementRef(node),
            role: agentElementRole(node),
            label: agentElementLabel(node),
            tag: String(node.tagName || '').toLowerCase(),
            href: node.href || node.getAttribute?.('href') || '',
            value: agentElementValue(node),
            disabled: !!node.disabled || node.getAttribute?.('aria-disabled') === 'true',
            bounds: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        });
    };
    const agentFocusedElement = (doc) => {
      const active = doc?.activeElement;
      if (!active || active === doc.body || active === doc.documentElement) return null;
      if (!isAgentVisibleElement(active)) return null;
      return {
        ref: agentElementRef(active),
        role: agentElementRole(active),
        label: agentElementLabel(active),
        value: agentElementValue(active),
      };
    };
    const browserAgentActor = () => {
      if (!ensureBrowserAgentActor()) return null;
      try {
        const windowGlobal = xulBrowser?.browsingContext?.currentWindowGlobal;
        return windowGlobal?.getActor?.(BROWSER_AGENT_ACTOR_NAME) || null;
      } catch {
        return null;
      }
    };
    const browserAgentDebug = () => {
      let ensureResult = false;
      let actor = null;
      let actorError = '';
      let parentModule = null;
      let parentModuleError = '';
      let childModule = null;
      let childModuleError = '';
      try {
        ensureResult = ensureBrowserAgentActor();
        actor = xulBrowser?.browsingContext?.currentWindowGlobal?.getActor?.(BROWSER_AGENT_ACTOR_NAME) || null;
      } catch (err) {
        actorError = err?.message || String(err);
      }
      try {
        parentModule = Object.keys(ChromeUtils.importESModule('chrome://userchrome/content/EGDeskBrowserAgentRuntimeParent.sys.mjs'));
      } catch (err) {
        parentModuleError = err?.message || String(err);
      }
      try {
        childModule = Object.keys(ChromeUtils.importESModule('chrome://userchrome/content/EGDeskBrowserAgentRuntimeChild.sys.mjs'));
      } catch (err) {
        childModuleError = err?.message || String(err);
      }
      return {
        cardId: card.id,
        actorName: BROWSER_AGENT_ACTOR_NAME,
        actorReady: browserAgentActorReady,
        ensureResult,
        actorError,
        parentModule,
        parentModuleError,
        childModule,
        childModuleError,
        hasBrowser: !!xulBrowser,
        browserLocalName: xulBrowser?.localName || '',
        hasBrowsingContext: !!xulBrowser?.browsingContext,
        browsingContextId: xulBrowser?.browsingContext?.id || null,
        hasCurrentWindowGlobal: !!xulBrowser?.browsingContext?.currentWindowGlobal,
        currentWindowGlobalKeys: xulBrowser?.browsingContext?.currentWindowGlobal
          ? Object.getOwnPropertyNames(Object.getPrototypeOf(xulBrowser.browsingContext.currentWindowGlobal)).slice(0, 40)
          : [],
        hasGetActor: typeof xulBrowser?.browsingContext?.currentWindowGlobal?.getActor === 'function',
        hasActor: !!actor,
        actorKeys: actor ? Object.getOwnPropertyNames(Object.getPrototypeOf(actor)).slice(0, 40) : [],
        hasActorSendQuery: typeof actor?.sendQuery === 'function',
        hasMessageManager: !!browserAgentMessageManager(),
        uri: browserState.uri,
        title: readBrowserTitle(),
      };
    };
    const browserAgentActorRequest = async (method, payload = {}) => {
      const actor = browserAgentActor();
      if (!actor?.sendQuery) throw new Error('Browser agent JSActor unavailable');
      return actor.sendQuery(method, payload);
    };
    const cloneBrowserAgentPayload = (value) => {
      if (value == null) return value;
      try {
        if (typeof structuredClone === 'function') return structuredClone(value);
      } catch {}
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return value;
      }
    };
    const browserAgentHistory = (options = {}) => {
      const limit = Number.isFinite(options.limit) ? Math.max(0, options.limit) : agentActionHistory.length;
      const entries = limit ? agentActionHistory.slice(-limit) : [];
      return entries.map((entry) => cloneBrowserAgentPayload(entry));
    };
    const clearBrowserAgentHistory = () => {
      const removed = agentActionHistory.length;
      agentActionHistory.length = 0;
      return { cardId: card.id, removed };
    };
    const recordBrowserAgentAction = (entry) => {
      agentActionHistory.push(entry);
      while (agentActionHistory.length > BROWSER_AGENT_HISTORY_LIMIT) agentActionHistory.shift();
      const eventDetail = cloneBrowserAgentPayload(entry);
      try {
        card.dispatchEvent(new CustomEvent('egdesk:browser-agent-action', {
          bubbles: false,
          detail: eventDetail,
        }));
      } catch {}
      try {
        window.dispatchEvent(new CustomEvent('egdesk:browser-agent-action', {
          detail: eventDetail,
        }));
      } catch {}
      return entry;
    };
    const finalizeBrowserAgentAct = (payload, meta = {}) => {
      const endedAtMs = Date.now();
      const startedAtMs = Number.isFinite(meta.startedAtMs) ? meta.startedAtMs : endedAtMs;
      const entry = {
        id: `${card.id}-agent-action-${++agentActionSeq}`,
        cardId: card.id,
        sequence: agentActionSeq,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: Math.max(0, endedAtMs - startedAtMs),
        source: meta.source || 'unknown',
        url: payload?.after?.url || payload?.before?.url || browserState.uri,
        title: payload?.after?.title || payload?.before?.title || readBrowserTitle(),
        ok: !!payload?.ok,
        action: cloneBrowserAgentPayload(payload?.action || meta.action || {}),
        result: cloneBrowserAgentPayload(payload?.result ?? null),
        error: payload?.error || null,
        before: cloneBrowserAgentPayload(payload?.before || null),
        after: cloneBrowserAgentPayload(payload?.after || null),
        observation: cloneBrowserAgentPayload(payload?.observation || {}),
      };
      if (meta.record !== false) recordBrowserAgentAction(entry);
      return {
        ...payload,
        actionEntry: cloneBrowserAgentPayload(entry),
        actionHistoryLength: agentActionHistory.length,
      };
    };
    const browserAgentSnapshot = async (snapshotOptions = {}) => {
      const doc = readBrowserDocument();
      let bridgeError = '';
      if (!doc) {
        try {
          const actorSnapshot = await browserAgentActorRequest('snapshot', { options: snapshotOptions });
          return {
            cardId: card.id,
            ...actorSnapshot,
          };
        } catch (err) {
          bridgeError = `actor: ${err?.message || String(err)}`;
        }
        try {
          const bridged = await browserAgentBridgeRequest('snapshot', { options: snapshotOptions });
          return {
            cardId: card.id,
            ...bridged,
          };
        } catch (err) {
          bridgeError = `${bridgeError}; frameScript: ${err?.message || String(err)}`;
        }
      }
      syncBrowserStateFromBrowser({ markDirtyOnLocationChange: false });
      const text = doc ? agentVisibleTextSegments(doc, snapshotOptions.textLimit || 80) : [];
      const interactiveElements = doc ? agentInteractiveElements(doc, snapshotOptions.elementLimit || 80) : [];
      const focusedElement = doc ? agentFocusedElement(doc) : null;
      return {
        cardId: card.id,
        url: browserState.uri,
        title: readBrowserTitle(),
        readyState: doc?.readyState || '',
        text,
        interactiveElements,
        focusedElement,
        inaccessible: !doc,
        bridgeError,
      };
    };
    const browserAgentFrameScriptSource = () => `
      (() => {
        const requestTopic = ${JSON.stringify(agentBridgeRequestTopic)};
        const responseTopic = ${JSON.stringify(agentBridgeResponseTopic)};
        globalThis.__egdeskAgentBridgeTopics ||= new Set();
        if (globalThis.__egdeskAgentBridgeTopics.has(requestTopic)) return;
        globalThis.__egdeskAgentBridgeTopics.add(requestTopic);
        const refByNode = new WeakMap();
        const nodeByRef = new Map();
        let refSeq = 0;
        const compact = (value, max = 180) => {
          const text = String(value || '').replace(/\\s+/g, ' ').trim();
          return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
        };
        const elementRef = (node) => {
          const existing = refByNode.get(node);
          if (existing) return existing;
          const ref = 'el_' + (++refSeq);
          refByNode.set(node, ref);
          nodeByRef.set(ref, node);
          return ref;
        };
        const nodeForRef = (ref) => {
          const node = nodeByRef.get(ref);
          return node && node.isConnected ? node : null;
        };
        const isVisible = (node) => {
          if (!node || !node.getBoundingClientRect) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = content.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
        };
        const roleFor = (node) => {
          const explicit = node.getAttribute?.('role');
          if (explicit) return explicit;
          const tag = String(node.tagName || '').toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'select') return 'combobox';
          if (tag === 'textarea') return 'textbox';
          if (tag === 'input') {
            const type = String(node.getAttribute('type') || 'text').toLowerCase();
            if (['button', 'submit', 'reset'].includes(type)) return 'button';
            if (['checkbox', 'radio', 'range', 'search', 'email', 'password', 'number', 'date', 'time'].includes(type)) return type;
            return 'textbox';
          }
          if (node.isContentEditable) return 'textbox';
          return tag || 'element';
        };
        const labelFor = (node) => {
          const doc = node.ownerDocument;
          const labelledBy = node.getAttribute?.('aria-labelledby');
          if (labelledBy) {
            const labelled = labelledBy.split(/\\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' ');
            if (labelled.trim()) return compact(labelled, 120);
          }
          if (node.id) {
            const label = doc.querySelector('label[for="' + CSS.escape(node.id) + '"]');
            if (label?.textContent?.trim()) return compact(label.textContent, 120);
          }
          return compact(
            node.getAttribute?.('aria-label')
              || node.getAttribute?.('alt')
              || node.getAttribute?.('title')
              || node.getAttribute?.('placeholder')
              || node.innerText
              || node.textContent
              || node.getAttribute?.('name')
              || node.getAttribute?.('id')
              || node.value
              || '',
            120,
          );
        };
        const valueFor = (node) => {
          const tag = String(node.tagName || '').toLowerCase();
          if (tag === 'select') return compact(node.selectedOptions?.[0]?.textContent || node.value || '', 120);
          if (tag === 'textarea' || tag === 'input') return compact(node.value || '', 120);
          if (node.isContentEditable) return compact(node.innerText || node.textContent || '', 120);
          return '';
        };
        const signature = (item) => [item.role || '', item.label || '', item.href || '', item.value || ''].join('|');
        const textSegments = (doc, limit = 80) => {
          const root = doc.body || doc.documentElement;
          if (!root) return [];
          const filter = content.NodeFilter;
          const walker = doc.createTreeWalker(root, filter.SHOW_TEXT, {
            acceptNode: (node) => {
              const text = compact(node.nodeValue, 180);
              if (!text || text.length < 2) return filter.FILTER_REJECT;
              const parent = node.parentElement;
              if (!parent || !isVisible(parent)) return filter.FILTER_REJECT;
              return filter.FILTER_ACCEPT;
            },
          });
          const seen = new Set();
          const segments = [];
          let node = walker.nextNode();
          while (node && segments.length < limit) {
            const text = compact(node.nodeValue, 180);
            if (text && !seen.has(text)) {
              seen.add(text);
              segments.push(text);
            }
            node = walker.nextNode();
          }
          return segments;
        };
        const interactiveElements = (doc, limit = 80) => {
          const selector = ['a[href]', 'button', 'input', 'textarea', 'select', '[role]', '[tabindex]', '[contenteditable="true"]'].join(',');
          return Array.from(doc.querySelectorAll(selector)).filter(isVisible).slice(0, limit).map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              ref: elementRef(node),
              role: roleFor(node),
              label: labelFor(node),
              tag: String(node.tagName || '').toLowerCase(),
              href: node.href || node.getAttribute?.('href') || '',
              value: valueFor(node),
              disabled: !!node.disabled || node.getAttribute?.('aria-disabled') === 'true',
              bounds: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            };
          });
        };
        const focusedElement = (doc) => {
          const active = doc.activeElement;
          if (!active || active === doc.body || active === doc.documentElement || !isVisible(active)) return null;
          return { ref: elementRef(active), role: roleFor(active), label: labelFor(active), value: valueFor(active) };
        };
        const snapshot = (options = {}) => {
          const doc = content.document;
          return {
            url: content.location.href,
            title: doc.title || '',
            readyState: doc.readyState || '',
            text: textSegments(doc, options.textLimit || 80),
            interactiveElements: interactiveElements(doc, options.elementLimit || 80),
            focusedElement: focusedElement(doc),
            inaccessible: false,
          };
        };
        const diffLists = (beforeList, afterList, keyFn, limit = 20) => {
          const beforeKeys = new Set((beforeList || []).map(keyFn));
          return (afterList || []).filter((item) => !beforeKeys.has(keyFn(item))).slice(0, limit);
        };
        const diff = (before, after) => {
          const newVisibleText = diffLists(before?.text, after?.text, (item) => item, 20);
          const removedVisibleText = diffLists(after?.text, before?.text, (item) => item, 20);
          const newInteractiveElements = diffLists(before?.interactiveElements, after?.interactiveElements, signature, 20);
          const removedInteractiveElements = diffLists(after?.interactiveElements, before?.interactiveElements, signature, 20);
          return {
            urlChanged: before?.url !== after?.url,
            titleChanged: before?.title !== after?.title,
            url: after?.url || '',
            title: after?.title || '',
            newVisibleText,
            removedVisibleText,
            focusedElement: after?.focusedElement || null,
            newInteractiveElements,
            removedInteractiveElements,
            visibleTextChanged: newVisibleText.length > 0 || removedVisibleText.length > 0,
            interactiveChanged: newInteractiveElements.length > 0 || removedInteractiveElements.length > 0,
          };
        };
        const dispatchInputEvents = (node) => {
          node.dispatchEvent(new content.Event('input', { bubbles: true, cancelable: true }));
          node.dispatchEvent(new content.Event('change', { bubbles: true, cancelable: true }));
        };
        const targetFor = (action) => {
          if (action.ref) return nodeForRef(action.ref);
          if (action.selector) return content.document.querySelector(action.selector);
          return null;
        };
        const perform = (action = {}) => {
          const type = action.type || action.action || 'snapshot';
          if (type === 'navigate') {
            content.location.href = String(action.url || action.value || content.location.href);
            return { ok: true };
          }
          if (type === 'scroll') {
            content.scrollBy({ left: action.dx || 0, top: action.dy || action.deltaY || 0, behavior: 'instant' });
            return { ok: true };
          }
          if (type === 'snapshot') return { ok: true };
          const target = targetFor(action);
          if (!target) throw new Error('Browser agent target not found: ' + (action.ref || action.selector || ''));
          target.scrollIntoView?.({ block: 'center', inline: 'center' });
          if (type === 'click') {
            target.focus?.();
            const pageTarget = target.wrappedJSObject || target;
            const eventResults = [];
            for (const eventName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              const Ctor = eventName.startsWith('pointer') && content.PointerEvent ? content.PointerEvent : content.MouseEvent;
              eventResults.push({
                eventName,
                notCanceled: pageTarget.dispatchEvent(new Ctor(eventName, {
                  bubbles: true,
                  cancelable: true,
                  view: content,
                  button: 0,
                  buttons: eventName.endsWith('down') ? 1 : 0,
                })),
              });
            }
            const clickResult = pageTarget.click?.();
            return {
              ok: true,
              ref: action.ref || elementRef(target),
              clickDiagnostics: {
                hasWrappedTarget: !!target.wrappedJSObject,
                hasClick: typeof pageTarget.click === 'function',
                clickResult: clickResult === undefined ? null : clickResult,
                eventResults,
              },
            };
          }
          if (type === 'fill' || type === 'type') {
            target.focus?.();
            const value = String(action.text ?? action.value ?? '');
            if ('value' in target) {
              target.value = type === 'type' ? String(target.value || '') + value : value;
            } else if (target.isContentEditable) {
              target.textContent = type === 'type' ? String(target.textContent || '') + value : value;
            } else {
              throw new Error('Browser agent target is not editable: ' + (action.ref || action.selector || ''));
            }
            dispatchInputEvents(target);
            return { ok: true, ref: action.ref || elementRef(target) };
          }
          if (type === 'press') {
            target.focus?.();
            const key = String(action.key || 'Enter');
            const eventInit = { key, bubbles: true, cancelable: true, view: content };
            target.dispatchEvent(new content.KeyboardEvent('keydown', eventInit));
            target.dispatchEvent(new content.KeyboardEvent('keyup', eventInit));
            return { ok: true, ref: action.ref || elementRef(target), key };
          }
          throw new Error('Unsupported browser agent action: ' + type);
        };
        addMessageListener(requestTopic, async (message) => {
          const { requestId, method, payload } = message.data || {};
          try {
            if (method === 'snapshot') {
              sendAsyncMessage(responseTopic, { requestId, ok: true, payload: snapshot(payload?.options || {}) });
              return;
            }
            if (method === 'act') {
              const before = snapshot(payload?.options?.snapshot || {});
              const result = perform(payload?.action || {});
              const settleMs = Number.isFinite(payload?.options?.settleMs) ? payload.options.settleMs : 250;
              await new Promise((resolve) => content.setTimeout(resolve, Math.max(0, settleMs)));
              const after = snapshot(payload?.options?.snapshot || {});
              sendAsyncMessage(responseTopic, {
                requestId,
                ok: true,
                payload: {
                  ok: true,
                  action: payload?.action || {},
                  result,
                  before,
                  after,
                  observation: diff(before, after),
                },
              });
              return;
            }
            throw new Error('Unsupported browser agent bridge method: ' + method);
          } catch (error) {
            sendAsyncMessage(responseTopic, { requestId, ok: false, error: error?.message || String(error) });
          }
        });
      })();
    `;
    const browserAgentMessageManager = () => {
      try {
        return xulBrowser?.messageManager || xulBrowser?.frameLoader?.messageManager || null;
      } catch {
        return null;
      }
    };
    const ensureBrowserAgentBridge = () => {
      const manager = browserAgentMessageManager();
      if (!manager) return null;
      if (!agentBridgeInstalled) {
        manager.addMessageListener(agentBridgeResponseTopic, (message) => {
          const data = message.data || {};
          const pending = agentBridgePending.get(data.requestId);
          if (!pending) return;
          agentBridgePending.delete(data.requestId);
          window.clearTimeout(pending.timer);
          if (data.ok) pending.resolve(data.payload);
          else pending.reject(new Error(data.error || 'Browser agent bridge failed'));
        });
        manager.loadFrameScript(
          'data:application/javascript;charset=utf-8,' + encodeURIComponent(browserAgentFrameScriptSource()),
          true,
        );
        agentBridgeInstalled = true;
      }
      return manager;
    };
    const browserAgentBridgeRequest = (method, payload = {}, timeoutMs = 10000) => {
      const manager = ensureBrowserAgentBridge();
      if (!manager) return Promise.reject(new Error('Browser agent bridge unavailable'));
      const requestId = `${card.id}-${++agentBridgeSeq}`;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          agentBridgePending.delete(requestId);
          reject(new Error(`Browser agent bridge timeout: ${method}`));
        }, timeoutMs);
        agentBridgePending.set(requestId, { resolve, reject, timer });
        manager.sendAsyncMessage(agentBridgeRequestTopic, { requestId, method, payload });
      });
    };
    const diffAgentLists = (beforeList, afterList, keyFn, limit = 20) => {
      const beforeKeys = new Set((beforeList || []).map(keyFn));
      return (afterList || []).filter((item) => !beforeKeys.has(keyFn(item))).slice(0, limit);
    };
    const diffBrowserAgentSnapshots = (before, after) => {
      const newVisibleText = diffAgentLists(before?.text, after?.text, (item) => item, 20);
      const removedVisibleText = diffAgentLists(after?.text, before?.text, (item) => item, 20);
      const newInteractiveElements = diffAgentLists(
        before?.interactiveElements,
        after?.interactiveElements,
        agentElementSignature,
        20,
      );
      const removedInteractiveElements = diffAgentLists(
        after?.interactiveElements,
        before?.interactiveElements,
        agentElementSignature,
        20,
      );
      return {
        urlChanged: before?.url !== after?.url,
        titleChanged: before?.title !== after?.title,
        url: after?.url || '',
        title: after?.title || '',
        newVisibleText,
        removedVisibleText,
        focusedElement: after?.focusedElement || null,
        newInteractiveElements,
        removedInteractiveElements,
        visibleTextChanged: newVisibleText.length > 0 || removedVisibleText.length > 0,
        interactiveChanged: newInteractiveElements.length > 0 || removedInteractiveElements.length > 0,
      };
    };
    const dispatchAgentInputEvents = (node) => {
      node.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      node.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    };
    const performBrowserAgentAction = (action = {}) => {
      const doc = readBrowserDocument();
      const type = action.type || action.action || 'snapshot';
      if (type === 'navigate') {
        return navigateBrowser(action.url || action.value || browserState.uri, action.options || {});
      }
      if (type === 'scroll') {
        const win = doc?.defaultView;
        win?.scrollBy?.({ left: action.dx || 0, top: action.dy || action.deltaY || 0, behavior: 'instant' });
        return { ok: true };
      }
      const target = action.ref
        ? agentNodeForRef(action.ref)
        : action.selector && doc?.querySelector?.(action.selector);
      if (!target) throw new Error(`Browser agent target not found: ${action.ref || action.selector || ''}`);
      target.scrollIntoView?.({ block: 'center', inline: 'center' });
      if (type === 'click') {
        target.focus?.();
        const targetWindow = target.ownerDocument?.defaultView || window;
        for (const eventName of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const Ctor = eventName.startsWith('pointer') && targetWindow.PointerEvent ? targetWindow.PointerEvent : targetWindow.MouseEvent;
          target.dispatchEvent(new Ctor(eventName, {
            bubbles: true,
            cancelable: true,
            view: targetWindow,
            button: 0,
            buttons: eventName.endsWith('down') ? 1 : 0,
          }));
        }
        target.click?.();
        return { ok: true, ref: action.ref || agentElementRef(target) };
      }
      if (type === 'fill' || type === 'type') {
        target.focus?.();
        const value = String(action.text ?? action.value ?? '');
        if ('value' in target) {
          target.value = type === 'type' ? String(target.value || '') + value : value;
        } else if (target.isContentEditable) {
          target.textContent = type === 'type' ? String(target.textContent || '') + value : value;
        } else {
          throw new Error(`Browser agent target is not editable: ${action.ref || action.selector || ''}`);
        }
        dispatchAgentInputEvents(target);
        return { ok: true, ref: action.ref || agentElementRef(target) };
      }
      if (type === 'press') {
        target.focus?.();
        const key = String(action.key || 'Enter');
        const eventInit = { key, bubbles: true, cancelable: true, view: doc?.defaultView || window };
        target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
        target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        return { ok: true, ref: action.ref || agentElementRef(target), key };
      }
      if (type === 'snapshot') return { ok: true };
      throw new Error(`Unsupported browser agent action: ${type}`);
    };
    const browserAgentAct = async (action = {}, actOptions = {}) => {
      const startedAtMs = Date.now();
      if (!readBrowserDocument()) {
        let actorError = '';
        try {
          const actorResult = await browserAgentActorRequest('act', { action, options: actOptions });
          return finalizeBrowserAgentAct({
            ...actorResult,
            action: actorResult.action || action,
            before: { cardId: card.id, ...actorResult.before },
            after: { cardId: card.id, ...actorResult.after },
          }, {
            action,
            source: 'jsactor',
            startedAtMs,
            record: actOptions.record,
          });
        } catch (err) {
          actorError = `actor: ${err?.message || String(err)}`;
        }
        try {
          const bridged = await browserAgentBridgeRequest('act', { action, options: actOptions }, Math.max(10000, (actOptions.settleMs || 250) + 5000));
          return finalizeBrowserAgentAct({
            ...bridged,
            action: bridged.action || action,
            before: { cardId: card.id, ...bridged.before },
            after: { cardId: card.id, ...bridged.after },
          }, {
            action,
            source: 'frame-script',
            startedAtMs,
            record: actOptions.record,
          });
        } catch (err) {
          const fallbackSnapshot = await browserAgentSnapshot(actOptions.snapshot || {});
          return finalizeBrowserAgentAct({
            ok: false,
            action,
            result: null,
            error: `${actorError}; frameScript: ${err?.message || String(err)}`,
            before: fallbackSnapshot,
            after: fallbackSnapshot,
            observation: diffBrowserAgentSnapshots(fallbackSnapshot, fallbackSnapshot),
          }, {
            action,
            source: 'fallback',
            startedAtMs,
            record: actOptions.record,
          });
        }
      }
      const before = await browserAgentSnapshot(actOptions.snapshot || {});
      let result = null;
      let ok = true;
      let error = null;
      try {
        result = performBrowserAgentAction(action);
        if (result?.then) result = await result;
      } catch (err) {
        ok = false;
        error = err?.message || String(err);
      }
      const settleMs = Number.isFinite(actOptions.settleMs) ? actOptions.settleMs : 250;
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, settleMs)));
      const after = await browserAgentSnapshot(actOptions.snapshot || {});
      return finalizeBrowserAgentAct({
        ok,
        action,
        result,
        error,
        before,
        after,
        observation: diffBrowserAgentSnapshots(before, after),
      }, {
        action,
        source: 'chrome-document',
        startedAtMs,
        record: actOptions.record,
      });
    };
    const syncBrowserChrome = () => {
      updateHistoryFlags();
      card.classList.toggle('egd-browser-loading', !!browserState.loading);
      card.dataset.browserLoading = browserState.loading ? 'true' : 'false';
      pageTitle.textContent = browserState.title || browserDisplayHost(browserState.uri);
      pageTitle.title = browserState.title || browserState.uri;
      pageStatus.textContent = browserState.loading ? 'Loading' : browserState.security;
      pageStatus.title = browserState.uri;
      securityIcon.textContent = browserSecurityGlyph(browserState.uri);
      securityIcon.title = browserState.security;
      if (document.activeElement !== urlInput) urlInput.value = browserState.uri;
      backButton.disabled = !browserState.canGoBack;
      forwardButton.disabled = !browserState.canGoForward;
      reloadButton.textContent = browserState.loading ? '×' : '↻';
      reloadButton.title = browserState.loading ? '중지' : '새로고침';
    };
    const setBrowserLoading = (loading) => {
      browserState.loading = !!loading;
      if (browserLoadTimer) {
        window.clearTimeout(browserLoadTimer);
        browserLoadTimer = 0;
      }
      if (browserState.loading) {
        browserLoadTimer = window.setTimeout(() => {
          browserLoadTimer = 0;
          browserState.loading = false;
          syncBrowserStateFromBrowser({ markDirtyOnLocationChange: false });
        }, 8000);
      }
      syncBrowserChrome();
    };
    const syncBrowserStateFromBrowser = (options = {}) => {
      const previousUri = browserState.uri;
      const nextUri = normalizeBrowserUri(readBrowserUri());
      const requestedUri = readRequestedBrowserUri();
      const isTransientInitialBlank = nextUri === 'about:blank'
        && previousUri
        && previousUri !== 'about:blank'
        && requestedUri
        && requestedUri !== 'about:blank';
      if (nextUri && !isTransientInitialBlank) browserState.uri = nextUri;
      browserState.security = browserSecurityLabel(browserState.uri);
      browserState.title = readBrowserTitle();
      if (browserState.uri !== previousUri) {
        pushBrowserHistory(browserState.uri, { replace: options.replaceHistory });
        bindCardSourceRef(card, browserSourceRef(browserState.uri, options.sourceRef || {}));
        if (options.markDirtyOnLocationChange) markAgendaDirty('browser-location-change', card);
      }
      updateHistoryFlags();
      syncBrowserChrome();
      return getBrowserStateSnapshot();
    };
    const loadBrowserUri = (url) => {
      try {
        xulBrowser?.setAttribute?.('src', url);
        if ('src' in xulBrowser) xulBrowser.src = url;
        return true;
      } catch (e) {
        console.error(TAG, 'browser navigation failed', e);
        return false;
      }
    };
    const navigateBrowser = (rawUrl, navOptions = {}) => {
      const url = normalizeBrowserUri(rawUrl || browserState.uri || browserState.homeUrl);
      browserState.uri = url;
      browserState.security = browserSecurityLabel(url);
      browserState.title = browserDisplayHost(url);
      urlInput.value = url;
      pushBrowserHistory(url, { replace: navOptions.replaceHistory });
      bindCardSourceRef(card, browserSourceRef(url, navOptions.sourceRef || {}));
      setBrowserLoading(true);
      const loaded = loadBrowserUri(url);
      if (navOptions.markDirty !== false) markAgendaDirty('navigate-browser-card', card);
      syncBrowserChrome();
      return loaded ? getBrowserStateSnapshot() : null;
    };
    const goBrowserBack = () => {
      if (browserState.historyIndex > 0) {
        browserState.historyIndex -= 1;
        const url = browserState.history[browserState.historyIndex];
        browserState.uri = url;
        browserState.security = browserSecurityLabel(url);
        browserState.title = browserDisplayHost(url);
        urlInput.value = url;
        bindCardSourceRef(card, browserSourceRef(url));
        setBrowserLoading(true);
        loadBrowserUri(url);
        markAgendaDirty('browser-back', card);
        syncBrowserChrome();
        return getBrowserStateSnapshot();
      }
      try {
        setBrowserLoading(true);
        xulBrowser?.goBack?.();
        window.setTimeout(() => syncBrowserStateFromBrowser({ markDirtyOnLocationChange: true }), 150);
        return true;
      } catch {
        setBrowserLoading(false);
        return false;
      }
    };
    const goBrowserForward = () => {
      if (browserState.historyIndex < browserState.history.length - 1) {
        browserState.historyIndex += 1;
        const url = browserState.history[browserState.historyIndex];
        browserState.uri = url;
        browserState.security = browserSecurityLabel(url);
        browserState.title = browserDisplayHost(url);
        urlInput.value = url;
        bindCardSourceRef(card, browserSourceRef(url));
        setBrowserLoading(true);
        loadBrowserUri(url);
        markAgendaDirty('browser-forward', card);
        syncBrowserChrome();
        return getBrowserStateSnapshot();
      }
      try {
        setBrowserLoading(true);
        xulBrowser?.goForward?.();
        window.setTimeout(() => syncBrowserStateFromBrowser({ markDirtyOnLocationChange: true }), 150);
        return true;
      } catch {
        setBrowserLoading(false);
        return false;
      }
    };
    const reloadBrowser = () => {
      try {
        setBrowserLoading(true);
        if (typeof xulBrowser?.reload === 'function') xulBrowser.reload();
        else loadBrowserUri(browserState.uri);
        return true;
      } catch {
        setBrowserLoading(false);
        return false;
      }
    };
    const stopBrowser = () => {
      try {
        if (typeof xulBrowser?.stop === 'function') xulBrowser.stop();
        else xulBrowser?.webNavigation?.stop?.((globalThis.Ci || Components.interfaces).nsIWebNavigation.STOP_ALL);
      } catch {}
      setBrowserLoading(false);
      return true;
    };
    const duplicateBrowser = () => spawnBrowserCard(browserState.uri, { openMode: 'new' });
    const closeBrowserMenu = () => {
      if (!browserMenuPanel) return;
      if (browserMenuPanel._outsideHandler) window.removeEventListener('mousedown', browserMenuPanel._outsideHandler, true);
      browserMenuPanel.remove();
      browserMenuPanel = null;
    };
    const showBrowserMenu = (anchor = menuButton) => {
      if (browserMenuPanel?.isConnected) {
        closeBrowserMenu();
        return null;
      }
      const anchorRect = anchor.getBoundingClientRect();
      const pos = resolveFloatingMenuPlacement(anchorRect, 166, 190);
      const item = (label, title, action) => el('button', {
        class: 'egd-browser-menu-item',
        title,
        onclick: (ev) => {
          ev.stopPropagation();
          closeBrowserMenu();
          action();
        },
      }, label);
      browserMenuPanel = el('div', {
        class: 'egd-browser-menu egd-edge egd-frosted',
        style: {
          left: Math.round(pos.left) + 'px',
          top: Math.round(pos.top) + 'px',
        },
      },
        item('복제', '현재 URL을 새 카드로 열기', duplicateBrowser),
        item('URL 복사', browserState.uri, () => copyTextToClipboard(browserState.uri)),
        item('홈', browserState.homeUrl, () => navigateBrowser(browserState.homeUrl)),
        item(browserState.loading ? '중지' : '새로고침', browserState.loading ? '로드 중지' : '현재 페이지 새로고침', () => (browserState.loading ? stopBrowser() : reloadBrowser())),
        item(isCardFullscreen(card) ? '창 복귀' : '전체화면', '카드 전체화면 전환', () => toggleCardFullscreen(card)),
      );
      browserMenuPanel._outsideHandler = (event) => {
        if (browserMenuPanel?.contains(event.target) || anchor.contains(event.target)) return;
        closeBrowserMenu();
      };
      document.documentElement.appendChild(browserMenuPanel);
      window.setTimeout(() => {
        if (browserMenuPanel?._outsideHandler) window.addEventListener('mousedown', browserMenuPanel._outsideHandler, true);
      }, 0);
      return browserMenuPanel;
    };
    card._browserState = browserState;
    card._browserControls = {
      getState: () => getBrowserStateSnapshot(),
      sync: () => syncBrowserStateFromBrowser({ markDirtyOnLocationChange: false }),
      navigate: navigateBrowser,
      back: goBrowserBack,
      forward: goBrowserForward,
      reload: reloadBrowser,
      stop: stopBrowser,
      home: () => navigateBrowser(browserState.homeUrl),
      duplicate: duplicateBrowser,
      copyUrl: () => copyTextToClipboard(browserState.uri),
      menu: showBrowserMenu,
      closeMenu: closeBrowserMenu,
      agentSnapshot: browserAgentSnapshot,
      agentAct: browserAgentAct,
      agentHistory: browserAgentHistory,
      agentClearHistory: clearBrowserAgentHistory,
      agentDebug: browserAgentDebug,
    };
    const onBrowserLoadStart = () => setBrowserLoading(true);
    const onBrowserLoadDone = () => {
      setBrowserLoading(false);
      syncBrowserStateFromBrowser({ markDirtyOnLocationChange: true });
    };
    const onBrowserTitle = () => syncBrowserStateFromBrowser({ markDirtyOnLocationChange: false });
    for (const eventName of ['loadstart']) {
      try { xulBrowser.addEventListener(eventName, onBrowserLoadStart, true); } catch {}
    }
    for (const eventName of ['DOMContentLoaded', 'load', 'pageshow']) {
      try { xulBrowser.addEventListener(eventName, onBrowserLoadDone, true); } catch {}
    }
    try { xulBrowser.addEventListener('DOMTitleChanged', onBrowserTitle, true); } catch {}
    setBrowserLoading(true);
    window.setTimeout(() => syncBrowserStateFromBrowser({ markDirtyOnLocationChange: false }), 400);

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
      if (ev.key === 'Escape') {
        urlInput.value = browserState.uri;
        urlInput.blur();
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      ev.stopPropagation();
      const url = urlInput.value.trim();
      if (!url) {
        urlInput.value = browserState.uri;
        return;
      }
      navigateBrowser(url);
    });
    urlInput.addEventListener('focus', () => {
      window.setTimeout(() => urlInput.select?.(), 0);
    });
    urlInput.addEventListener('blur', () => {
      if (!urlInput.value.trim()) urlInput.value = browserState.uri;
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
      if (isCardFullscreen(card)) return;
      if (ev.target.closest('input, button, .egd-card-dot')) return;
      focusCard();
      drag = { x: ev.clientX, y: ev.clientY, left: card.offsetLeft, top: card.offsetTop };
      ev.preventDefault();
    });
    installCardHeaderFullscreenToggle(card, header);

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
      if (isCardFullscreen(card)) return;
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
      const s = canvasZoom();
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
      if (drag) markAgendaDirty('move-browser-card', card);
      if (resize) markAgendaDirty('resize-browser-card', card);
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
      closeBrowserMenu();
      if (browserLoadTimer) {
        window.clearTimeout(browserLoadTimer);
        browserLoadTimer = 0;
      }
      for (const eventName of ['loadstart']) {
        try { xulBrowser.removeEventListener(eventName, onBrowserLoadStart, true); } catch {}
      }
      for (const eventName of ['DOMContentLoaded', 'load', 'pageshow']) {
        try { xulBrowser.removeEventListener(eventName, onBrowserLoadDone, true); } catch {}
      }
      try { xulBrowser.removeEventListener('DOMTitleChanged', onBrowserTitle, true); } catch {}
      if (state.activeEntityId === card.id) setActiveEntity(null);
      try { ro.disconnect(); } catch {}
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    console.warn(TAG, 'browser card spawned', id, normalizedUrl);
    card._xulBrowser = xulBrowser;
    card._wrap = wrap;
    card._cleanup = cleanupCard;
    return card;
  }
  // ============ Terminal Canvas Card ============
  const EGDESK_HELPER_PORT = 39218;
  const TERMINAL_HTML_URL = 'chrome://userchrome/content/terminal.html';

  function spawnTerminalCard() {
    const id = `egd-terminal-card-${++cardSeq}`;
    const sourceRef = makeSourceRef('terminal-session', {
      id,
      scope: 'local-pty',
    });
    const initialWidth = 800;
    const initialHeight = 500;
    const offset = ((cardSeq - 1) % 6) * 24;
    const center = viewportToCanvasPoint(
      window.innerWidth / 2 + offset,
      window.innerHeight / 2 + offset,
    );
    const card = el('div', {
      id,
      class: 'egd-canvas-card egd-terminal-card',
      style: {
        top: Math.round(center.y - initialHeight / 2) + 'px',
        left: Math.round(center.x - initialWidth / 2) + 'px',
        width: initialWidth + 'px',
        height: initialHeight + 'px',
        zIndex: String(++cardZ),
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
    setActiveEntity(card);

    // ---- Use iframe for terminal.html to isolate keyboard events ----
    const termBrowser = el('iframe', {
      src: TERMINAL_HTML_URL,
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
      // Kill PTY session via the browser's terminalAPI
      try {
        const contentWin = termBrowser.contentWindow || termBrowser.contentDocument?.defaultView;
        if (contentWin && contentWin.terminalAPI) {
          contentWin.terminalAPI.kill();
        }
      } catch (e) {
        console.warn(TAG, 'terminal cleanup error:', e);
      }
    };

    console.warn(TAG, 'terminal card spawned (chrome:// + Rust helper)', id);
    card._cleanup = cleanupCard;
    card._termBrowser = termBrowser;
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
      syncCardFullscreenLayout();
      refreshDeskMinimap();
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
    const setCanvasPanTarget = (nextPan, options = {}) => {
      if (!nextPan || !Number.isFinite(nextPan.x) || !Number.isFinite(nextPan.y)) return;
      state.panTarget = { x: nextPan.x, y: nextPan.y };
      if (options.immediate) {
        if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        state.pan = { ...state.panTarget };
        apply();
        return;
      }
      scheduleAnimate();
    };
    state.setCanvasPanTarget = setCanvasPanTarget;
    const setCanvasViewportTarget = (nextViewport, options = {}) => {
      if (!nextViewport) return;
      if (nextViewport.pan && Number.isFinite(nextViewport.pan.x) && Number.isFinite(nextViewport.pan.y)) {
        state.panTarget = { x: nextViewport.pan.x, y: nextViewport.pan.y };
      }
      if (Number.isFinite(nextViewport.zoom)) {
        state.zoomTarget = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextViewport.zoom));
      }
      if (options.immediate) {
        if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        state.pan = { ...state.panTarget };
        state.zoom = state.zoomTarget;
        apply();
        return;
      }
      scheduleAnimate();
    };
    state.setCanvasViewportTarget = setCanvasViewportTarget;
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
      if (state.cardFullscreen?.cardId) {
        if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        state.pan.x = state.panTarget.x;
        state.pan.y = state.panTarget.y;
        state.zoom = state.zoomTarget;
        apply();
        return;
      }
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
    let shapeDraw = null;
    viewport.addEventListener('mousedown', (ev) => {
      if (ev.target !== viewport && ev.target !== layer) return;   // 카드/오버레이 클릭은 별도 처리
      if (ev.button !== 0) return;
      if (state.panModifier || state.activeTool === 'hand') {
        beginCanvasPan(ev);
        return;
      }
      if (activeToolIsShape()) {
        const start = viewportToCanvasPoint(ev.clientX, ev.clientY);
        const shape = createCanvasShape(shapeTypeForTool());
        shape.classList.add('egd-canvas-shape-drawing');
        updateCanvasShapeGeometry(shape, start, start, { defaultSize: true });
        layer.appendChild(shape);
        shapeDraw = { shape, start, current: start, clientX: ev.clientX, clientY: ev.clientY, moved: false };
        setActiveEntity(null);
        ev.preventDefault();
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
      if (shapeDraw) {
        const current = viewportToCanvasPoint(ev.clientX, ev.clientY);
        shapeDraw.current = current;
        if (Math.abs(ev.clientX - shapeDraw.clientX) > 2 || Math.abs(ev.clientY - shapeDraw.clientY) > 2) {
          shapeDraw.moved = true;
        }
        updateCanvasShapeGeometry(shapeDraw.shape, shapeDraw.start, current);
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
      if (shapeDraw) {
        updateCanvasShapeGeometry(shapeDraw.shape, shapeDraw.start, shapeDraw.current, { defaultSize: !shapeDraw.moved });
        shapeDraw.shape.classList.remove('egd-canvas-shape-drawing');
        setActiveEntity(shapeDraw.shape);
        markAgendaDirty('create-shape', shapeDraw.shape);
        shapeDraw = null;
        return;
      }
      if (!marqueeSel) return;
      marquee.style.display = 'none';
      const left = Math.min(marqueeSel.x, marqueeSel.lastX);
      const top = Math.min(marqueeSel.y, marqueeSel.lastY);
      const right = Math.max(marqueeSel.x, marqueeSel.lastX);
      const bottom = Math.max(marqueeSel.y, marqueeSel.lastY);
      const hasArea = Math.abs(right - left) > 4 && Math.abs(bottom - top) > 4;
      if (hasArea) {
        const hits = Array.from(document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape')).filter((entity) => {
          const rect = entity.getBoundingClientRect();
          return rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
        });
        setSelectedEntities(hits, hits[0] || null);
      }
      marqueeSel = null;
    });

    // Global wheel capture:
    // - gesture start on active card body: native page scroll for that session
    // - gesture start anywhere else: desk pan for that session
    // - normal mode cmd+wheel pans; ctrl/pinch zooms
    // - card fullscreen mode cmd/ctrl+wheel zooms immediately
    document.addEventListener('wheel', (ev) => {
      const now = performance.now();
      const sessionExpired = !wheelSession.nativeActive
        && (!wheelSession.owner || (now - wheelSession.lastTs) > WHEEL_SESSION_IDLE_MS);
      if (sessionExpired || (wheelSession.nativeActive && !wheelSession.owner)) {
        resolveWheelSessionOwner(ev.target);
      }
      wheelSession.lastTs = now;
      if (state.cardFullscreen?.cardId && (ev.ctrlKey || ev.metaKey)) {
        wheelSession.owner = 'canvas';
        wheelSession.entityId = null;
        zoomCanvasByWheel(ev);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.metaKey && !ev.ctrlKey) {
        wheelSession.owner = 'canvas';
        wheelSession.entityId = null;
        panCanvasByWheel(ev);
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (ev.ctrlKey) {
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
    window.addEventListener('resize', () => {
      syncCardFullscreenLayout();
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
    syncActiveToolMode();
    document.body.style.background = '#F5F3EF';
  }

  function boot() {
    try {
      if (document.getElementById('egd-desk-rail')) return;
      const savedAgendaSnapshot = loadAgendaStoreMeta();
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
      window.__egdesk = {
        state,
        codexBridge: state.codexBridge,
        cardRuntime: {
          focusCard: focusCanvasCard,
          closeCard: closeCanvasCard,
          openBrowserCard: spawnBrowserCard,
          openUrl: openUrlInBrowserCard,
          openSettingsCard: spawnSettingsCard,
          openTerminalCard: spawnTerminalCard,
          toggleFullscreen: toggleCardFullscreen,
          syncFullscreenLayout: syncCardFullscreenLayout,
        },
        browserRuntime: {
          resolveCard: resolveBrowserCard,
          state: browserCardState,
          navigate: (cardOrId, url, options = {}) => browserCardControl(cardOrId, 'navigate', url, options),
          back: (cardOrId) => browserCardControl(cardOrId, 'back'),
          forward: (cardOrId) => browserCardControl(cardOrId, 'forward'),
          reload: (cardOrId) => browserCardControl(cardOrId, 'reload'),
          stop: (cardOrId) => browserCardControl(cardOrId, 'stop'),
          home: (cardOrId) => browserCardControl(cardOrId, 'home'),
          duplicate: (cardOrId) => browserCardControl(cardOrId, 'duplicate'),
          copyUrl: (cardOrId) => browserCardControl(cardOrId, 'copyUrl'),
          agentSnapshot: (cardOrId, options = {}) => browserCardControl(cardOrId, 'agentSnapshot', options),
          agentAct: (cardOrId, action = {}, options = {}) => browserCardControl(cardOrId, 'agentAct', action, options),
          agentHistory: (cardOrId, options = {}) => browserCardControl(cardOrId, 'agentHistory', options),
          agentClearHistory: (cardOrId) => browserCardControl(cardOrId, 'agentClearHistory'),
          agentDebug: (cardOrId) => browserCardControl(cardOrId, 'agentDebug'),
        },
        browserAgent: {
          snapshot: (cardOrId, options = {}) => browserCardControl(cardOrId, 'agentSnapshot', options),
          act: (cardOrId, action = {}, options = {}) => browserCardControl(cardOrId, 'agentAct', action, options),
          history: (cardOrId, options = {}) => browserCardControl(cardOrId, 'agentHistory', options),
          clearHistory: (cardOrId) => browserCardControl(cardOrId, 'agentClearHistory'),
          debug: (cardOrId) => browserCardControl(cardOrId, 'agentDebug'),
        },
        sourceRefs: {
          keyFor: sourceRefKey,
          browser: browserSourceRef,
          findCard: findOpenCardBySourceRef,
          listOpenCards: listOpenSourceCards,
        },
        railSearch: {
          results: (query = state.railSearch.query) => buildRailSearchResults(query).map(railSearchResultSnapshot),
          setQuery: (query) => setRailSearchQuery(query),
          open: openRailSearchPanel,
          close: closeRailSearchPanel,
          execute: executeRailSearchResult,
        },
        minimap: {
          toggle: toggleDeskMinimap,
          close: closeDeskMinimap,
          refresh: refreshDeskMinimap,
          snapshot: deskMinimapSnapshot,
        },
        agenda: {
          serialize: serializeAgendaSnapshot,
          save: saveCurrentAgendaState,
          restore: restoreSavedAgendaState,
          restoreSnapshot: restoreAgendaSnapshot,
          clearSavedState: clearAgendaStore,
          close: closeCurrentAgenda,
          clearView: clearCurrentAgendaView,
          closeGuard: showAgendaCloseGuard,
          list: agendaListEntries,
          create: createNewAgenda,
          switchTo: switchAgenda,
          rename: renameAgenda,
          duplicate: duplicateAgenda,
          delete: deleteAgenda,
          markOpened: markAgendaOpened,
          markClosed: markAgendaClosed,
          toggleSwitcher: toggleAgendaSwitcher,
          readStore: () => coerceAgendaStore(),
          markDirty: markAgendaDirty,
          storagePref: AGENDA_STORAGE_PREF,
        },
      };
      host.appendChild(buildDeskRail());
      installRailSearchShortcut();
      host.appendChild(buildDock());
      host.appendChild(buildPresetBag());
      host.appendChild(buildHUD());
      if (savedAgendaSnapshot) restoreAgendaSnapshot(savedAgendaSnapshot);
      installPopupCapture();
      console.warn(TAG, 'ready ✅');
    } catch (err) {
      console.error(TAG, 'boot failed:', err, err.stack);
    }
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
})();
