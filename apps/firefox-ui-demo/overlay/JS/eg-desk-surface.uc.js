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
    { id: 'react-dev',  label: '개발', name: 'React 개발',  count: 5 },
    { id: 'meeting',    label: '회의', name: '회의 준비',    count: 4 },
    { id: 'research',   label: '조사', name: '리서치 모드',  count: 3 },
    { id: 'writing',    label: '작성', name: '글쓰기',      count: 2 },
  ];

  const DOCK_LEFT = [
    { id: 'chat',     label: '채팅',    icon: '☰' },
    { id: 'shelf',    label: '서재',    icon: '▤' },
    { id: 'ontology', label: '온톨로지', icon: '◇' },
    { id: 'browser',  label: '브라우저', icon: '◎' },
    { id: 'ide',      label: 'IDE',     icon: '<>' },
    { id: 'terminal', label: '터미널',  icon: '>_' },
    { id: 'settings', label: '설정',   icon: '⚙' },
    { id: 'create',   label: '추가',      icon: '+' },
  ];
  const DOCK_CENTER = [
    { id: 'pencil',   label: '펜',  icon: '✎' },
    { id: 'hand',     label: '손',    icon: '↕' },
    { id: 'square',   label: '사각형',  icon: '□' },
    { id: 'ellipse',  label: '원',      icon: '○' },
    { id: 'line',     label: '선',      icon: '╱' },
    { id: 'arrow',    label: '화살표',   icon: '↖', active: true },
  ];
  const DOCK_RIGHT = [
    { id: 'trash',    label: '휴지통',   icon: '⌫' },
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
  const DEFAULT_CODEX_AGENT_PROFILE_ID = 'conversational-coding';
  const CODEX_AGENT_PROFILE_DEFS = [
    {
      id: 'conversational-coding',
      label: 'Chat',
      name: 'Conversational Coding Agent',
      category: 'conversation',
      toolMode: 'basic-tools',
      summary: '짧은 대화 응답과 필요 시 기본 tool call을 수행하는 기본 채팅 프로필',
      capabilities: ['conversation', 'basic-tool-call', 'coding-context'],
      systemPrompt: [
        'You are EG-Desk\'s default conversational coding assistant.',
        'Keep chat replies short and direct: use chat for conclusions, brief summaries, and result links.',
        'When durable artifacts, reports, evidence, or long explanations are needed, prefer canvas cards or linked outputs instead of long chat bubbles.',
        'Use project context and available tools when needed, verify claims before presenting them as facts, and ask clarifying questions only when blocked.',
      ].join('\n'),
    },
    {
      id: 'tool-operator',
      label: 'Tool',
      name: 'Basic Tool Operator',
      category: 'tool',
      toolMode: 'tool-call',
      summary: '요청을 안전한 tool call 흐름으로 바꾸고 관찰 결과만 보고하는 프로필',
      capabilities: ['tool-call', 'runtime-check', 'result-summary'],
      systemPrompt: [
        'You are EG-Desk\'s tool-operating assistant.',
        'Convert the user request into the smallest safe set of concrete tool actions.',
        'Report what was actually observed, separate failures from assumptions, and do not claim tool results without seeing them.',
        'Keep the visible chat response compact and route bulky outputs to canvas artifacts when available.',
      ].join('\n'),
    },
    {
      id: 'coding-project-manager',
      label: 'PM',
      name: 'Coding Project Manager',
      category: 'coding',
      toolMode: 'project-management',
      summary: 'high-level 목표를 유지하면서 coding sub-goal, verification, agent routing을 관리하는 프로필',
      capabilities: ['agenda-routing', 'task-planning', 'verification-plan', 'agent-coordination'],
      systemPrompt: [
        'You are EG-Desk\'s coding project manager agent.',
        'Preserve the high-level objective and agenda context while decomposing work into scoped coding tasks.',
        'Decide whether work belongs in Agent DM, an Agenda Thread, a specialized agent, or a concrete implementation pass.',
        'Track risks, verification requirements, and unresolved decisions; keep final chat output brief with links or canvas cards for detailed artifacts.',
      ].join('\n'),
    },
    {
      id: 'codebase-explorer',
      label: 'Explore',
      name: 'Codebase Explorer',
      category: 'coding',
      toolMode: 'read-only-code',
      summary: '수정 전에 코드베이스를 읽고 runtime boundary와 file ownership을 파악하는 프로필',
      capabilities: ['code-reading', 'file-reference', 'architecture-boundary'],
      systemPrompt: [
        'You are EG-Desk\'s codebase explorer.',
        'Read existing source before proposing edits, identify ownership boundaries, and ground conclusions in file references or runtime evidence.',
        'Avoid speculative architecture claims and avoid modifying files unless the user explicitly requests implementation.',
        'Return concise findings that another coding agent can act on.',
      ].join('\n'),
    },
    {
      id: 'implementation-worker',
      label: 'Build',
      name: 'Implementation Worker',
      category: 'coding',
      toolMode: 'implementation',
      summary: 'scope가 정해진 코드 수정, 테스트, 회귀 확인을 수행하는 프로필',
      capabilities: ['code-edit', 'test-run', 'regression-check'],
      systemPrompt: [
        'You are EG-Desk\'s implementation worker.',
        'Implement the scoped change using the existing codebase patterns and the smallest effective edit.',
        'Do not revert unrelated user changes; adapt to the current worktree and verify behavior with targeted tests or runtime checks.',
        'Report changed files, verification, and remaining risks succinctly.',
      ].join('\n'),
    },
    {
      id: 'review-verifier',
      label: 'Verify',
      name: 'Review and Verification Agent',
      category: 'coding',
      toolMode: 'verification',
      summary: '버그, 회귀, 누락 테스트, UI runtime evidence를 우선 점검하는 프로필',
      capabilities: ['code-review', 'runtime-verification', 'test-gap-analysis'],
      systemPrompt: [
        'You are EG-Desk\'s review and verification agent.',
        'Lead with bugs, regressions, missing tests, and evidence; keep style commentary secondary unless it affects usability or correctness.',
        'Use screenshots, logs, runtime checks, and file references for UI or behavior claims.',
        'If no issues are found, say that clearly and name the remaining test gaps.',
      ].join('\n'),
    },
  ];
  const CODEX_AGENT_PROFILES = Object.fromEntries(CODEX_AGENT_PROFILE_DEFS.map((profile) => [profile.id, profile]));
  const CODEX_AGENT_PROFILE_ORDER = CODEX_AGENT_PROFILE_DEFS.map((profile) => profile.id);

  function codexThreadKindMeta(type) {
    return type === 'group' ? THREAD_KIND_META.group : THREAD_KIND_META.dm;
  }

  function codexAgentProfile(profileId) {
    return CODEX_AGENT_PROFILES[profileId] || CODEX_AGENT_PROFILES[DEFAULT_CODEX_AGENT_PROFILE_ID];
  }

  function normalizeCodexAgentProfileId(profileId, fallbackProfileId = DEFAULT_CODEX_AGENT_PROFILE_ID) {
    if (typeof profileId === 'string' && CODEX_AGENT_PROFILES[profileId]) return profileId;
    if (typeof fallbackProfileId === 'string' && CODEX_AGENT_PROFILES[fallbackProfileId]) return fallbackProfileId;
    return DEFAULT_CODEX_AGENT_PROFILE_ID;
  }

  function defaultCodexAgentProfileIdForThread(type, title = '') {
    const normalizedTitle = String(title || '').toLowerCase();
    if (normalizedTitle.includes('review') || normalizedTitle.includes('verify') || normalizedTitle.includes('검증') || normalizedTitle.includes('리뷰')) {
      return 'review-verifier';
    }
    if (normalizedTitle.includes('explore') || normalizedTitle.includes('research') || normalizedTitle.includes('조사')) {
      return 'codebase-explorer';
    }
    if (normalizedTitle.includes('build') || normalizedTitle.includes('implement') || normalizedTitle.includes('구현')) {
      return 'implementation-worker';
    }
    return type === 'group' ? 'coding-project-manager' : DEFAULT_CODEX_AGENT_PROFILE_ID;
  }

  function codexThreadAgentProfile(thread) {
    return codexAgentProfile(thread?.agentProfileId || defaultCodexAgentProfileIdForThread(thread?.type, thread?.title));
  }

  function codexThreadToolMode(thread) {
    return thread?.toolMode || codexThreadAgentProfile(thread).toolMode;
  }

  function codexThreadSystemPrompt(thread) {
    const prompt = typeof thread?.systemPrompt === 'string' ? thread.systemPrompt.trim() : '';
    return prompt || codexThreadAgentProfile(thread).systemPrompt;
  }

  function codexThreadRuntimeConfig(thread) {
    const profile = codexThreadAgentProfile(thread);
    return {
      threadId: thread?.id || null,
      threadType: thread?.type || 'dm',
      threadTitle: thread?.title || '',
      agentProfile: {
        id: profile.id,
        label: profile.label,
        name: profile.name,
        category: profile.category,
        summary: profile.summary,
        capabilities: profile.capabilities,
      },
      toolMode: codexThreadToolMode(thread),
      systemPrompt: codexThreadSystemPrompt(thread),
    };
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
    const profile = codexThreadAgentProfile(thread);
    if (thread.type === 'group') {
      const count = Math.max(0, (thread.participants || []).length);
      return `${kind} · 멤버 ${count}명 · ${session} · ${profile.label}`;
    }
    const peer = (thread.participants || []).find((name) => name !== SELF_MEMBER) || 'Agent';
    return `${kind} · ${peer} · ${session} · ${profile.label}`;
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
    const agentProfileId = normalizeCodexAgentProfileId(
      options.agentProfileId,
      defaultCodexAgentProfileIdForThread(type, title)
    );
    const agentProfile = codexAgentProfile(agentProfileId);
    const safeSubtitle = subtitle || buildThreadSubtitle(type, participants);
    return {
      id: `thread-${type}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      title,
      subtitle: safeSubtitle,
      participants,
      participantRoles,
      agentProfileId,
      toolMode: options.toolMode || agentProfile.toolMode,
      systemPrompt: options.systemPrompt || agentProfile.systemPrompt,
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
        agentProfileId: 'conversational-coding',
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
        agentProfileId: 'coding-project-manager',
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
    const profile = codexThreadAgentProfile(thread);
    return [
      thread.title,
      thread.subtitle,
      codexThreadKindLabel(thread.type),
      codexThreadLongLabel(thread.type),
      codexThreadSessionLabel(thread),
      profile.label,
      profile.name,
      profile.summary,
      codexThreadToolMode(thread),
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
  const ONTOLOGY_GRAPH_URL = 'chrome://userchrome/content/ontology/graph.json';

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

  function svgEl(tag, props = {}, ...children) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.setAttribute('class', v);
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
    if (card.classList.contains('egd-ontology-card')) return 'ontology';
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
    if (type === 'ontology') {
      return { ...(card._ontologyState || {}) };
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
    } else if (cardState.type === 'ontology') {
      card = spawnOntologyMapCard(runtime);
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
    if (card.classList.contains('egd-ontology-card')) return 'Ontology map';
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
    if (card.classList.contains('egd-ontology-card')) return 'Ontology';
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
    if (state.cardFullscreen) return;
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

  function handleWindowControl(action) {
    if (action === 'close') {
      window.close();
      return;
    }
    if (action === 'minimize') {
      if (typeof window.minimize === 'function') window.minimize();
      return;
    }
    if (typeof window.fullScreen === 'boolean') {
      window.fullScreen = !window.fullScreen;
      return;
    }
    if (window.windowState === window.STATE_MAXIMIZED && typeof window.restore === 'function') {
      window.restore();
    } else if (typeof window.maximize === 'function') {
      window.maximize();
    }
  }

  function buildWindowControls() {
    document.getElementById('egd-window-controls')?.remove();
    const button = (action, label) => el('button', {
      class: `egd-window-control egd-window-control-${action}`,
      title: label,
      'aria-label': label,
      onclick: (ev) => {
        ev.stopPropagation();
        handleWindowControl(action);
      },
    });
    return el('div', { id: 'egd-window-controls', role: 'toolbar', 'aria-label': '창 제어' },
      button('close', '창 닫기'),
      button('minimize', '창 최소화'),
      button('zoom', '창 전체화면 전환'),
    );
  }

  // ============ Top: Viewport Agenda Rail ============
  function buildDeskRail() {
    const rail = el('div', { id: 'egd-desk-rail', class: 'egd-edge egd-frosted' });
    rail.addEventListener('dblclick', (ev) => {
      const target = ev.target;
      if (target instanceof Element && target.closest('button, input, textarea, a, select, #egd-window-controls, .egd-rail-search')) return;
      ev.preventDefault();
      ev.stopPropagation();
      handleWindowControl('zoom');
    });

    const left = el('div', { class: 'egd-rail-section egd-rail-left' },
      buildWindowControls(),
      el('span', { class: 'egd-rail-window-divider' }),
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
      }, '✓'),
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
        '!',
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
              } else if (item.id === 'ontology') {
                spawnOntologyMapCard();
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

    bag.appendChild(el('div', { class: 'egd-bag-header', title: '프리셋 가방' }, '▦'));

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

  function syncHudViewportFit() {
    const hud = document.getElementById('egd-hud');
    if (!hud) return;
    const margin = 10;
    hud.style.maxWidth = '';
    hud.style.left = '';
    hud.style.right = `${margin}px`;
    if (hud.classList.contains('egd-hud-hidden')) return;

    const clamp = () => {
      const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
      if (!viewportW) return;
      const maxWidth = Math.max(240, viewportW - margin * 2);
      hud.style.maxWidth = `${maxWidth}px`;
      const rect = hud.getBoundingClientRect();
      const computedLeft = Number.parseFloat(getComputedStyle(hud).left);
      const visualOffset = Number.isFinite(computedLeft) ? rect.left - computedLeft : 0;
      const width = Math.min(rect.width || 396, maxWidth);
      let left = Math.max(margin, viewportW - width - margin - visualOffset);
      hud.style.left = `${left}px`;
      hud.style.right = 'auto';
      const adjustedRect = hud.getBoundingClientRect();
      const overflowRight = adjustedRect.right - viewportW + margin;
      if (overflowRight > 0) {
        left = Math.max(margin, left - overflowRight);
        hud.style.left = `${left}px`;
      }
      const finalRect = hud.getBoundingClientRect();
      const overflowLeft = margin - finalRect.left;
      if (overflowLeft > 0) {
        hud.style.left = `${left + overflowLeft}px`;
      }
    };

    clamp();
    window.requestAnimationFrame?.(clamp);
    window.setTimeout(clamp, 240);
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

      const renderThreadMenu = (thread) => {
        const activeProfile = codexThreadAgentProfile(thread);
        const menuChildren = [
          el('button', {
            class: `egd-codex-thread-menu-item${thread.pinned ? ' egd-codex-thread-menu-item-active' : ''}`,
            onclick: () => codexBridge.toggleThreadPin(thread.id),
          }, thread.pinned ? '채팅방 고정 해제' : '채팅방 고정'),
          el('button', {
            class: 'egd-codex-thread-menu-item',
            onclick: () => codexBridge.renameThread(thread.id),
          }, '채팅방 이름 변경'),
          el('div', { class: 'egd-codex-thread-menu-label' }, 'Agent profile'),
          ...CODEX_AGENT_PROFILE_DEFS.map((profile) => el('button', {
            class: `egd-codex-thread-menu-item egd-codex-thread-menu-profile${profile.id === activeProfile.id ? ' egd-codex-thread-menu-item-active' : ''}`,
            title: profile.summary,
            onclick: () => codexBridge.setThreadAgentProfile(thread.id, profile.id),
          },
          el('span', { class: 'egd-codex-thread-menu-profile-label' }, profile.label),
          el('span', { class: 'egd-codex-thread-menu-profile-name' }, profile.name),
          )),
          el('button', {
            class: 'egd-codex-thread-menu-item egd-codex-thread-menu-item-danger',
            onclick: () => codexBridge.deleteThread(thread.id),
          }, '채팅방 삭제'),
          el('button', {
            class: 'egd-codex-thread-menu-item',
            onclick: () => codexBridge.closeThreadMenu(),
          }, '닫기'),
        ];
        return el('div', {
          class: 'egd-codex-thread-menu',
          style: {
            left: `${Math.round(codex.threadMenu?.left ?? 12)}px`,
            top: `${Math.round(codex.threadMenu?.top ?? 12)}px`,
          },
          onclick: (ev) => ev.stopPropagation(),
        }, ...menuChildren);
      };

      const renderThreadAgentRow = (thread, compact = false) => {
        const runtime = codexThreadRuntimeConfig(thread);
        return el('div', { class: `egd-codex-thread-agent-row${compact ? ' egd-codex-thread-agent-row-compact' : ''}` },
          el('span', {
            class: 'egd-codex-agent-profile-chip egd-codex-agent-profile-chip-strong',
            title: runtime.agentProfile.name,
          }, runtime.agentProfile.label),
          el('span', {
            class: 'egd-codex-tool-mode-chip',
            title: runtime.agentProfile.summary,
          }, runtime.toolMode),
        );
      };

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
          const profile = codexThreadAgentProfile(thread);
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
                    el('span', { class: 'egd-codex-agent-profile-chip', title: profile.name }, profile.label),
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
              renderThreadAgentRow(activeThread, true),
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
            renderThreadAgentRow(activeThread),
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
                ? `${activeKindLabel} · ${codexThreadSessionLabel(activeThread)} · ${codexThreadAgentProfile(activeThread).name}`
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
        const agentProfileId = normalizeCodexAgentProfileId(
          thread.agentProfileId,
          defaultCodexAgentProfileIdForThread(thread.type, thread.title)
        );
        const agentProfile = codexAgentProfile(agentProfileId);
        return {
          ...thread,
          participants,
          participantRoles,
          agentProfileId,
          toolMode: thread.toolMode || agentProfile.toolMode,
          systemPrompt: typeof thread.systemPrompt === 'string' && thread.systemPrompt.trim()
            ? thread.systemPrompt
            : agentProfile.systemPrompt,
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
      agentProfiles() {
        return CODEX_AGENT_PROFILE_DEFS.map((profile) => ({ ...profile }));
      },
      threadRuntimeConfig(threadId = state.codex.activeThreadId) {
        const thread = getCodexThreadById(state.codex, threadId) || getActiveCodexThread(state.codex);
        return codexThreadRuntimeConfig(thread);
      },
      setThreadAgentProfile(threadId, profileId) {
        if (!threadId) return;
        const normalizedProfileId = normalizeCodexAgentProfileId(profileId);
        const profile = codexAgentProfile(normalizedProfileId);
        updateThreadById(threadId, (thread) => ({
          ...thread,
          agentProfileId: normalizedProfileId,
          toolMode: profile.toolMode,
          systemPrompt: profile.systemPrompt,
        }));
        state.codex.threadMenu = null;
        state.codex.memberMenu = null;
        emit();
      },
      cycleThreadAgentProfile(threadId) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread) return;
        const currentId = normalizeCodexAgentProfileId(thread.agentProfileId, defaultCodexAgentProfileIdForThread(thread.type, thread.title));
        const currentIndex = CODEX_AGENT_PROFILE_ORDER.indexOf(currentId);
        const nextId = CODEX_AGENT_PROFILE_ORDER[(currentIndex + 1) % CODEX_AGENT_PROFILE_ORDER.length] || DEFAULT_CODEX_AGENT_PROFILE_ID;
        this.setThreadAgentProfile(threadId, nextId);
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
            ? resolveFloatingMenuPlacement(rect, 230, 288)
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
        const thread = createCodexThread(normalizedType, label, '', {
          participants,
          agentProfileId: options.agentProfileId,
        });
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
          const runtimeConfig = codexThreadRuntimeConfig(activeThread);
          const result = await fetchJson('/chat/send', {
            method: 'POST',
            body: JSON.stringify({
              conversationId: activeThread.conversationId ?? undefined,
              message: content,
              systemPrompt: runtimeConfig.systemPrompt,
              agentProfile: runtimeConfig.agentProfile,
              toolMode: runtimeConfig.toolMode,
              thread: {
                id: runtimeConfig.threadId,
                type: runtimeConfig.threadType,
                title: runtimeConfig.threadTitle,
              },
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
    syncHudViewportFit();
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
    const previousMinimapOpen = !!document.getElementById('egd-desk-minimap');
    state.cardFullscreen = {
      cardId: card.id,
      rect: getCardRect(card),
      previousHudHidden,
      previousMinimapOpen,
      zIndex: ++cardZ,
    };
    setActiveEntity(card);
    card.classList.add('egd-card-fullscreen');
    document.documentElement.classList.add('egd-card-fullscreen-active');
    setHudPresentationHidden(true);
    if (previousMinimapOpen) closeDeskMinimap();
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
    if (fullscreen.previousMinimapOpen) toggleDeskMinimap();
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
  const ONTOLOGY_FACET_ORDER = ['space', 'topology', 'storage', 'time', 'intent', 'action'];
  const ONTOLOGY_PRIMARY_AXIS_ORDER = ['virtual', 'space', 'time'];
  const ONTOLOGY_BINDING_TYPES = ['topology', 'storage', 'intent', 'action'];
  const ONTOLOGY_DEPTH_ORDER = ['physical', 'information', 'virtual'];
  const ONTOLOGY_TIME_PANE_ORDER = ['past', 'present', 'future', 'multiverse'];
  const ONTOLOGY_TIME_PANE_LABELS = {
    past: '과거',
    present: '현재',
    future: '미래',
    multiverse: '분기',
  };
  const ONTOLOGY_DEPTH_NAV_ORDER = ['virtual', 'information', 'physical'];
  const ONTOLOGY_DEPTH_LABELS = {
    all: '전체',
    virtual: '의미',
    information: '정보',
    physical: '기반',
  };
  const ONTOLOGY_FACET_LABELS = {
    space: '공간',
    topology: '토폴로지',
    storage: '저장',
    time: '시간',
    intent: '의도',
    action: '행동',
  };
  const ONTOLOGY_AXIS_LABELS = {
    space: '공간',
    time: '시간',
    virtual: '가상',
  };
  const ONTOLOGY_AXIS_DESCRIPTIONS = {
    space: '현실/물리/컴퓨트 객체, 파일, 카드, 표면',
    time: '과거 증거, 현재 상태, 미래 목표, 이벤트',
    virtual: '개념, entity, 의미, 목표, 정체성',
  };
  const ONTOLOGY_BINDING_LABELS = {
    topology: '토폴로지',
    storage: '저장',
    intent: '의도',
    action: '행동',
  };
  const ONTOLOGY_BINDING_DESCRIPTIONS = {
    topology: '공간 리소스 + 가상 런타임 + 현재 상태',
    storage: '공간 파일 + 가상 source identity + 시간 이력',
    intent: '가상 목표 + 시간 약속 + 공간 산출물',
    action: '시간 전이 + 공간 대상 + 가상 의미',
  };
  const ONTOLOGY_NODE_LABELS = {
    'entity.llm_chat_session': '채팅 세션',
    'entity.chat_memory': '채팅 기억',
    'entity.desktop_runtime': '데스크톱 런타임',
    'egdesk.world': 'EG-Desk 세계',
    'time.past': '과거',
    'time.present': '현재',
    'time.future': '미래',
    'time.multiverse': '멀티버스',
    'projection.llm_chat_session.space.chat_card': '채팅 카드',
    'projection.llm_chat_session.topology.runtime': '런타임',
    'projection.llm_chat_session.storage.session_file': '세션 파일',
    'projection.llm_chat_session.time.memory_trace': '기억 흔적',
    'projection.llm_chat_session.intent.context_binding': '컨텍스트 연결',
    'projection.llm_chat_session.action.message_send': '메시지 전송',
    'projection.chat_memory.time.past_evidence': '과거 증거',
    'projection.chat_memory.storage.trace_file': '흔적 파일',
    'projection.chat_memory.intent.context_input': '컨텍스트 입력',
    'projection.chat_memory.action.file_read': '파일 읽기',
    'projection.desktop_runtime.space.desktop_plane': '데스크톱 평면',
    'projection.desktop_runtime.topology.hardware_os': '하드웨어/OS',
    'projection.desktop_runtime.storage.local_disk': '로컬 디스크',
    'projection.desktop_runtime.action.app_execution': '앱 실행',
    'egdesk.desk': '데스크',
    'egdesk.agenda': '아젠다',
    'egdesk.card': '카드',
    'egdesk.run_bubble': '실행 버블',
    'egdesk.run_playback': '실행 재생',
    'output.structured': '구조화 산출',
    'alternate.plan': '대안 계획',
    'candidate.future': '후보 미래',
    goal: '목표',
    plan: '계획',
    task: '작업',
    desktop: '데스크톱',
    terminal: '터미널',
    cpu: 'CPU',
    ram: 'RAM',
    disk: '디스크',
    compute: '연산',
  };
  const ONTOLOGY_NODE_SUMMARIES = {
    'entity.llm_chat_session': 'LLM 채팅 세션의 표준 정체성입니다. 하나의 세션이 가상 entity로 존재하고, 공간 객체와 시간 흐름에 동시에 고정됩니다.',
    'entity.chat_memory': '채팅 기억은 과거 증거, 저장된 흔적, 현재 컨텍스트 입력, 읽기 행동으로 동시에 해석됩니다.',
    'entity.desktop_runtime': '데스크톱 런타임은 보이는 작업 공간이면서 동시에 앱 실행과 파일 저장을 지탱하는 실행 기반입니다.',
    'output.structured': '현재 실행이나 메시지 전송이 미래의 확인 가능한 산출물로 정리된 상태입니다.',
    'alternate.plan': '현재 계획에서 갈라져 나온 대안 경로입니다. 아직 현재 현실은 아니지만 비교 가능한 후보입니다.',
    'candidate.future': '멀티버스 후보 중 선택되면 미래 목표나 계획으로 승격될 수 있는 상태입니다.',
    goal: '미래 시간대에서 현재 컨텍스트가 향하는 목표입니다.',
    plan: '목표를 실행 가능한 순서나 경로로 풀어낸 계획입니다.',
    task: '계획을 실제 행동 단위로 잘라낸 작업입니다.',
  };

  function ontologyLayerColor(layer) {
    const colors = {
      reality: '#B45F4D',
      architecture: '#2D5A7B',
      time: '#6F5A9A',
      operation: '#3F7B61',
      runtime: '#8A6B2E',
      evidence: '#596875',
      projection: '#6E655D',
      ontology: '#5D6370',
    };
    return colors[layer] || '#5D6370';
  }

  function ontologyTitleCase(value) {
    return String(value || '')
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function ontologyProjectionFacet(id) {
    if (!String(id || '').startsWith('projection.')) return null;
    const parts = String(id).split('.');
    return parts.find((part, index) => index > 0 && ONTOLOGY_FACET_ORDER.includes(part)) || null;
  }

  function ontologyProjectionCanonicalId(id) {
    if (!String(id || '').startsWith('projection.')) return null;
    const parts = String(id).split('.');
    const facetIndex = parts.findIndex((part, index) => index > 0 && ONTOLOGY_FACET_ORDER.includes(part));
    if (facetIndex <= 1) return null;
    return `entity.${parts.slice(1, facetIndex).join('.')}`;
  }

  function ontologyAxisForFacet(facet) {
    if (facet === 'time' || facet === 'action') return 'time';
    if (facet === 'intent') return 'virtual';
    if (facet === 'space' || facet === 'topology' || facet === 'storage') return 'space';
    return 'virtual';
  }

  function ontologyAxisForNode(node) {
    if (!node?.id) return 'virtual';
    if (node.id.startsWith('entity.') || node.type === 'canonical_entity') return 'virtual';
    return ontologyAxisForFacet(ontologyProjectionFacet(node.id));
  }

  function ontologyBindingTypeForProjection(node) {
    const facet = ontologyProjectionFacet(node?.id);
    return ONTOLOGY_BINDING_TYPES.includes(facet) ? facet : null;
  }

  function ontologyNodeById(graph, id) {
    return (graph?.nodes || []).find((node) => node.id === id) || null;
  }

  function ontologyEdgesForSource(graph, source, relation = null) {
    return (graph?.edges || []).filter((edge) => edge.source === source && (!relation || edge.relation === relation));
  }

  function ontologyCanonicalIdForNode(graph, node) {
    if (!node?.id) return null;
    if (node.id.startsWith('entity.')) return node.id;
    const projectedCanonical = ontologyProjectionCanonicalId(node.id);
    if (projectedCanonical && ontologyNodeById(graph, projectedCanonical)) return projectedCanonical;
    const incomingRepresentation = (graph?.edges || []).find((edge) => (
      edge.target === node.id
      && edge.relation === 'represented_by'
      && edge.source.startsWith('entity.')
    ));
    return incomingRepresentation?.source || null;
  }

  function ontologyProjectionNodesForCanonical(graph, canonicalId) {
    if (!canonicalId) return [];
    const ids = new Set();
    for (const edge of ontologyEdgesForSource(graph, canonicalId, 'represented_by')) {
      if (edge.target?.startsWith('projection.')) ids.add(edge.target);
    }
    const canonicalStem = canonicalId.replace(/^entity\./, '');
    for (const node of graph?.nodes || []) {
      if (node.id?.startsWith(`projection.${canonicalStem}.`)) ids.add(node.id);
    }
    return Array.from(ids)
      .map((id) => ontologyNodeById(graph, id))
      .filter(Boolean)
      .sort((a, b) => {
        const aFacet = ontologyProjectionFacet(a.id);
        const bFacet = ontologyProjectionFacet(b.id);
        return ONTOLOGY_FACET_ORDER.indexOf(aFacet) - ONTOLOGY_FACET_ORDER.indexOf(bFacet) || a.id.localeCompare(b.id);
      });
  }

  function ontologyAddNodeId(graph, ids, id) {
    if (id && ontologyNodeById(graph, id)) ids.add(id);
  }

  function ontologyAddProjectionIds(graph, ids, canonicalId, facets) {
    const facetSet = new Set(facets);
    for (const projection of ontologyProjectionNodesForCanonical(graph, canonicalId)) {
      if (facetSet.has(ontologyProjectionFacet(projection.id))) ids.add(projection.id);
    }
  }

  function ontologyPaneInventoryNodes(graph, phase, selected) {
    const ids = new Set();
    const canonicalId = ontologyCanonicalIdForNode(graph, selected) || selected?.id || 'entity.llm_chat_session';

    if (phase === 'past') {
      ontologyAddProjectionIds(graph, ids, canonicalId, ['time']);
      ontologyAddNodeId(graph, ids, 'entity.chat_memory');
      ontologyAddProjectionIds(graph, ids, 'entity.chat_memory', ['time', 'storage', 'action']);
    } else if (phase === 'future') {
      ontologyAddProjectionIds(graph, ids, canonicalId, ['intent', 'action']);
      ontologyAddNodeId(graph, ids, 'output.structured');
      ontologyAddNodeId(graph, ids, 'goal');
      ontologyAddNodeId(graph, ids, 'plan');
      ontologyAddNodeId(graph, ids, 'task');
    } else if (phase === 'multiverse') {
      ontologyAddNodeId(graph, ids, 'alternate.plan');
      ontologyAddNodeId(graph, ids, 'candidate.future');
    } else {
      ontologyAddNodeId(graph, ids, canonicalId);
      ontologyAddNodeId(graph, ids, 'egdesk.desk');
      ontologyAddNodeId(graph, ids, 'egdesk.agenda');
      ontologyAddNodeId(graph, ids, 'egdesk.card');
      ontologyAddProjectionIds(graph, ids, canonicalId, ['space', 'topology', 'storage', 'intent', 'action']);
      ontologyAddNodeId(graph, ids, 'desktop');
      ontologyAddNodeId(graph, ids, 'terminal');
      ontologyAddNodeId(graph, ids, 'cpu');
      ontologyAddNodeId(graph, ids, 'ram');
      ontologyAddNodeId(graph, ids, 'disk');
      ontologyAddNodeId(graph, ids, 'entity.desktop_runtime');
      ontologyAddProjectionIds(graph, ids, 'entity.desktop_runtime', ['topology', 'storage']);
    }

    return Array.from(ids)
      .map((id) => ontologyNodeById(graph, id))
      .filter(Boolean);
  }

  function ontologyCreateDeckGeometry(bounds, active) {
    if (bounds?.corners) {
      const corner = (name) => ({
        x: bounds.x + Number(bounds.corners[name]?.x || 0),
        y: bounds.y + Number(bounds.corners[name]?.y || 0),
      });
      const corners = {
        tl: corner('tl'),
        tr: corner('tr'),
        br: corner('br'),
        bl: corner('bl'),
      };
      const box = {
        minX: Math.min(corners.tl.x, corners.tr.x, corners.br.x, corners.bl.x),
        maxX: Math.max(corners.tl.x, corners.tr.x, corners.br.x, corners.bl.x),
        minY: Math.min(corners.tl.y, corners.tr.y, corners.br.y, corners.bl.y),
        maxY: Math.max(corners.tl.y, corners.tr.y, corners.br.y, corners.bl.y),
      };
      const lerpPoint = (a, b, t) => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
      const point = (u, v) => {
        const top = lerpPoint(corners.tl, corners.tr, u);
        const bottom = lerpPoint(corners.bl, corners.br, u);
        return lerpPoint(top, bottom, v);
      };
      const pathFromPoints = (points) => `M ${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} Z`;
      const path = (offsetX = 0, offsetY = 0) => pathFromPoints([
        point(0, 0),
        point(1, 0),
        point(1, 1),
        point(0, 1),
      ].map((p) => ({ x: p.x + offsetX, y: p.y + offsetY })));
      const rectPath = (u, v, w, h) => pathFromPoints([
        point(u, v),
        point(u + w, v),
        point(u + w, v + h),
        point(u, v + h),
      ]);
      return { corners, box, point, path, rectPath };
    }
    const skew = Number(bounds?.skew || 0);
    const topInset = Number(bounds.topInset ?? (active ? Math.min(82, bounds.w * 0.09) : 0));
    const bottomOutset = Number(bounds.bottomOutset ?? (active ? Math.min(16, bounds.w * 0.02) : 0));
    const frontDrop = Number(bounds.frontDrop ?? (active ? 18 : 0));
    const corners = {
      tl: { x: bounds.x + topInset, y: bounds.y },
      tr: { x: bounds.x + bounds.w - topInset, y: bounds.y - skew * (active ? 0.28 : 1) },
      br: { x: bounds.x + bounds.w + bottomOutset, y: bounds.y + bounds.h - skew * (active ? 0.06 : 1) + frontDrop },
      bl: { x: bounds.x - bottomOutset, y: bounds.y + bounds.h + frontDrop },
    };
    const box = {
      minX: Math.min(corners.tl.x, corners.tr.x, corners.br.x, corners.bl.x),
      maxX: Math.max(corners.tl.x, corners.tr.x, corners.br.x, corners.bl.x),
      minY: Math.min(corners.tl.y, corners.tr.y, corners.br.y, corners.bl.y),
      maxY: Math.max(corners.tl.y, corners.tr.y, corners.br.y, corners.bl.y),
    };
    const lerpPoint = (a, b, t) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    });
    const point = (u, v) => {
      const top = lerpPoint(corners.tl, corners.tr, u);
      const bottom = lerpPoint(corners.bl, corners.br, u);
      return lerpPoint(top, bottom, v);
    };
    const pathFromPoints = (points) => `M ${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} Z`;
    const path = (offsetX = 0, offsetY = 0) => pathFromPoints([
      point(0, 0),
      point(1, 0),
      point(1, 1),
      point(0, 1),
    ].map((p) => ({ x: p.x + offsetX, y: p.y + offsetY })));
    const rectPath = (u, v, w, h) => pathFromPoints([
      point(u, v),
      point(u + w, v),
      point(u + w, v + h),
      point(u, v + h),
    ]);
    return { corners, box, point, path, rectPath };
  }

  function ontologyCreateDeckScene(graph, selected, localState = {}) {
    const selectedPhase = ontologyPhaseForNode(selected);
    const activePane = localState.activePane || selectedPhase || 'present';
    const phaseLabels = { past: '과거', present: '현재', future: '미래', multiverse: '분기' };
    const phaseColor = (phase) => (phase === 'present'
      ? '#2D5A7B'
      : phase === 'past' || phase === 'multiverse'
        ? '#6F5A9A'
        : '#8A6B2E');
    const paneBounds = {
      past: {
        x: 28,
        y: 252,
        w: 216,
        h: 330,
        corners: {
          tl: { x: 44, y: 22 },
          tr: { x: 208, y: 54 },
          br: { x: 216, y: 302 },
          bl: { x: 0, y: 330 },
        },
      },
      present: {
        x: 260,
        y: 222,
        w: 804,
        h: 360,
        corners: {
          tl: { x: 92, y: 0 },
          tr: { x: 712, y: 0 },
          br: { x: 804, y: 360 },
          bl: { x: 0, y: 360 },
        },
      },
      future: {
        x: 1084,
        y: 252,
        w: 222,
        h: 330,
        corners: {
          tl: { x: 8, y: 54 },
          tr: { x: 172, y: 22 },
          br: { x: 222, y: 330 },
          bl: { x: 0, y: 302 },
        },
      },
      multiverse: { x: 920, y: 690, w: 300, h: 128, skew: 24, topInset: 22, bottomOutset: 6, frontDrop: 6 },
    };
    const enforcePaneGap = () => {
      const minGap = 18;
      const paneBox = (phase) => ontologyCreateDeckGeometry(paneBounds[phase], phase === activePane).box;
      let pastBox = paneBox('past');
      let presentBox = paneBox('present');
      if (pastBox.maxX + minGap > presentBox.minX) {
        paneBounds.past.x -= pastBox.maxX + minGap - presentBox.minX;
      }
      presentBox = paneBox('present');
      let futureBox = paneBox('future');
      if (presentBox.maxX + minGap > futureBox.minX) {
        paneBounds.future.x += presentBox.maxX + minGap - futureBox.minX;
      }
      futureBox = paneBox('future');
      if (futureBox.maxX > 1310) {
        const overflow = futureBox.maxX - 1310;
        paneBounds.future.x -= overflow;
        paneBounds.present.x -= overflow;
        pastBox = paneBox('past');
        presentBox = paneBox('present');
        if (pastBox.maxX + minGap > presentBox.minX) {
          paneBounds.past.x -= pastBox.maxX + minGap - presentBox.minX;
        }
      }
    };
    enforcePaneGap();
    const panes = new Map(Object.entries(paneBounds).map(([phase, bounds]) => {
      const active = phase === activePane;
      return [phase, {
        phase,
        bounds,
        active,
        label: phaseLabels[phase],
        color: phaseColor(phase),
        nodes: ontologyPaneInventoryNodes(graph, phase, selected),
        geometry: ontologyCreateDeckGeometry(bounds, active),
      }];
    }));
    const referenceSurfaces = {
      present: [
        {
          id: 'lower-physical',
          geometry: ontologyCreateDeckGeometry({
            x: 298,
            y: 574,
            w: 802,
            h: 166,
            corners: {
              tl: { x: 42, y: 0 },
              tr: { x: 760, y: 0 },
              br: { x: 802, y: 166 },
              bl: { x: 0, y: 166 },
            },
          }, true),
          fill: 'rgba(45, 90, 123, 0.078)',
          stroke: 'rgba(45, 90, 123, 0.28)',
          width: '1.25',
          opacity: '0.80',
        },
      ],
    };
    const temporalRoutes = [
      {
        fromPhase: 'past',
        fromId: 'entity.chat_memory',
        toPhase: 'present',
        toId: 'projection.llm_chat_session.intent.context_binding',
        kind: 'evidence-context',
        stroke: 'rgba(111, 90, 154, 0.78)',
        width: '3.4',
        label: '기억→맥락',
      },
      {
        fromPhase: 'past',
        fromId: 'projection.chat_memory.storage.trace_file',
        toPhase: 'present',
        toId: 'projection.llm_chat_session.storage.session_file',
        kind: 'storage-trace',
        stroke: 'rgba(89, 104, 117, 0.58)',
        dash: '7 5',
        width: '2.6',
      },
      {
        fromPhase: 'present',
        fromId: 'projection.llm_chat_session.intent.context_binding',
        toPhase: 'future',
        toId: 'goal',
        kind: 'intent-goal',
        stroke: 'rgba(138, 107, 46, 0.78)',
        width: '3.4',
        label: '맥락→목표',
      },
      {
        fromPhase: 'present',
        fromId: 'projection.llm_chat_session.action.message_send',
        toPhase: 'future',
        toId: 'output.structured',
        kind: 'action-output',
        stroke: 'rgba(180, 95, 77, 0.58)',
        dash: '5 5',
        width: '2.6',
      },
      {
        fromPhase: 'future',
        fromId: 'plan',
        toPhase: 'multiverse',
        toId: 'alternate.plan',
        kind: 'plan-branch',
        stroke: 'rgba(111, 90, 154, 0.64)',
        dash: '5 6',
        width: '2.7',
        label: '계획 분기',
      },
      {
        fromPhase: 'multiverse',
        fromId: 'candidate.future',
        toPhase: 'future',
        toId: 'goal',
        kind: 'candidate-select',
        stroke: 'rgba(111, 90, 154, 0.54)',
        dash: '7 6',
        width: '2.5',
      },
    ];
    return { activePane, panes, paneBounds, phaseLabels, phaseColor, temporalRoutes, referenceSurfaces };
  }

  function ontologyProjectionLabel(node) {
    const facet = ontologyProjectionFacet(node?.id);
    const axis = ontologyAxisForFacet(facet);
    if (ONTOLOGY_NODE_LABELS[node?.id]) return `${ONTOLOGY_AXIS_LABELS[axis] || '축'} · ${ONTOLOGY_NODE_LABELS[node.id]}`;
    if (!facet) return String(node?.label || node?.id || '');
    const parts = String(node.id).split('.');
    const facetIndex = parts.indexOf(facet);
    const local = parts.slice(facetIndex + 1).join('_');
    return `${ONTOLOGY_FACET_LABELS[facet]} · ${ontologyTitleCase(local)}`;
  }

  function ontologyDisplayLabel(node, mode) {
    if (!node) return '';
    if (ONTOLOGY_NODE_LABELS[node.id]) return ONTOLOGY_NODE_LABELS[node.id];
    if (node.id?.startsWith('entity.')) return node.label || ontologyTitleCase(node.id.replace(/^entity\./, ''));
    if (node.id?.startsWith('projection.') && mode === 'focus') return ontologyProjectionLabel(node);
    return String(node.label || node.id);
  }

  function ontologyNamespaceBadge(node) {
    const id = String(node?.id || '');
    const namespace = id.includes('.') ? id.split('.')[0] : '';
    if (!namespace) return '';
    if (namespace === 'egdesk') return namespace;
    if (node?.type === 'product_concept' || node?.type === 'external_concept') return namespace;
    return '';
  }

  function ontologyObjectLayerBadge(node) {
    const id = String(node?.id || '');
    const badges = {
      desktop: 'assembly',
      terminal: 'surface',
      cpu: 'resource',
      ram: 'resource',
      disk: 'resource',
      compute: 'substrate',
    };
    return badges[id] || '';
  }

  function ontologyDisplayMeta(node, mode) {
    if (!node) return '';
    if (node.id?.startsWith('projection.') && mode === 'focus') {
      const facet = ontologyProjectionFacet(node.id);
      return ONTOLOGY_FACET_LABELS[facet] || '';
    }
    const typeLabels = {
      canonical_entity: '표준 개념',
      world: '세계',
      projection: '투영',
      product_concept: '제품 개념',
      reference: '참조',
      facet: '축',
      runtime_surface: '표면',
      hardware_resource: '리소스',
      hardware_group: '리소스 묶음',
    };
    const layerLabels = {
      runtime: '런타임',
      architecture: '아키텍처',
      ontology: '온톨로지',
      evidence: '증거',
      time: '시간',
      operation: '작업',
    };
    return `${layerLabels[node.layer] || node.layer || '레이어'} · ${typeLabels[node.type] || node.type || '개념'}`;
  }

  function ontologyNodeSize(node, mode) {
    if (mode !== 'focus') return { width: 128, height: 48 };
    if (node?.id?.startsWith('entity.')) return { width: 196, height: 62 };
    if (node?.id?.startsWith('projection.')) return { width: 186, height: 56 };
    return { width: 156, height: 50 };
  }

  function ontologyTrimText(value, max) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}\u2026` : text;
  }

  function ontologyFacetDescription(facet) {
    const descriptions = {
      space: '보이는 위치, 카드, 패널, 캔버스',
      topology: '런타임 의존성, 리소스 사용',
      storage: '파일, 저장소, DB, 소스 참조',
      time: '과거, 현재, 미래, 분기',
      intent: '목표, 계획, 작업, 막힘',
      action: '읽기, 쓰기, 클릭, 실행, 전송',
    };
    return descriptions[facet] || '축 투영';
  }

  function ontologyRelationLabel(relation) {
    const labels = {
      binds: '묶음',
      represented_by: '나타남',
      derived_from: '파생됨',
      provides_evidence_for: '증거 제공',
      operates_inside: '내부에서 작동',
      uses: '사용',
      contains: '포함',
      visualizes: '시각화',
      wiki_link: '문서 링크',
      drives: '구동',
      records: '기록',
      receives_from: '받음',
    };
    return labels[relation] || relation;
  }

  function ontologyFacetPlaneColor(facet) {
    const colors = {
      space: '#2D5A7B',
      topology: '#3F7B61',
      storage: '#596875',
      time: '#6F5A9A',
      intent: '#8A6B2E',
      action: '#B45F4D',
    };
    return colors[facet] || '#5D6370';
  }

  function ontologyAxisColor(axis) {
    const colors = {
      virtual: '#8A6B2E',
      space: '#2D5A7B',
      time: '#6F5A9A',
    };
    return colors[axis] || '#5D6370';
  }

  function ontologyDepthForNode(node) {
    const facet = ontologyProjectionFacet(node?.id);
    if (facet === 'time' || facet === 'intent') return 'virtual';
    if (facet === 'space' || facet === 'topology' || facet === 'storage' || facet === 'action') return 'information';
    if (['cpu', 'ram', 'disk', 'compute'].includes(node?.id)) return 'physical';
    if (['desktop', 'terminal'].includes(node?.id)) return 'information';
    if (node?.id?.startsWith('time.') || node?.id === 'goal' || node?.id === 'plan' || node?.id === 'task') return 'virtual';
    if (node?.id === 'output.structured' || node?.layer === 'operation') return 'information';
    if (node?.type === 'product_concept') return 'virtual';
    if (node?.id?.startsWith('entity.') || node?.type === 'canonical_entity') return 'virtual';
    if (node?.layer === 'architecture' || node?.layer === 'runtime' || node?.layer === 'evidence') return 'information';
    return 'virtual';
  }

  function ontologyNormalizeDepth(depth, fallback = 'virtual') {
    if (ONTOLOGY_DEPTH_NAV_ORDER.includes(depth)) return depth;
    return ONTOLOGY_DEPTH_NAV_ORDER.includes(fallback) ? fallback : 'virtual';
  }

  function ontologyDefaultDepthForPane(pane, selected) {
    if (selected && ontologyPhaseForNode(selected) === pane) return ontologyDepthForNode(selected);
    return 'virtual';
  }

  function ontologyDepthColor(depth) {
    const colors = {
      physical: '#2D5A7B',
      information: '#3F7B61',
      virtual: '#8A6B2E',
    };
    return colors[depth] || '#5D6370';
  }

  function ontologyShiftPane(current, deltaX) {
    const order = ONTOLOGY_TIME_PANE_ORDER;
    const index = Math.max(0, order.indexOf(current));
    const next = deltaX > 0 ? index + 1 : index - 1;
    return order[Math.max(0, Math.min(order.length - 1, next))];
  }

  function ontologyShiftDepth(current, deltaY) {
    const normalized = ontologyNormalizeDepth(current);
    const index = ONTOLOGY_DEPTH_NAV_ORDER.indexOf(normalized);
    if (index < 0) return 'virtual';
    const next = deltaY > 0 ? index + 1 : index - 1;
    return ONTOLOGY_DEPTH_NAV_ORDER[Math.max(0, Math.min(ONTOLOGY_DEPTH_NAV_ORDER.length - 1, next))];
  }

  function ontologyPhaseForNode(node) {
    const id = String(node?.id || '');
    if (id === 'goal' || id === 'plan' || id === 'task' || id === 'output.structured') return 'future';
    if (id === 'alternate.plan' || id === 'candidate.future') return 'multiverse';
    if (id === 'entity.chat_memory' || id.startsWith('projection.chat_memory.')) return 'past';
    return 'present';
  }

  function ontologyProjectionLocalLabel(node) {
    if (ONTOLOGY_NODE_LABELS[node?.id]) return ONTOLOGY_NODE_LABELS[node.id];
    const label = ontologyProjectionLabel(node);
    return label.replace(/^[^·]+·\s*/, '');
  }

  function ontologyResetFocusViewport(localState) {
    localState.pan = { x: 0, y: 0 };
    localState.zoom = 1;
    localState.tilt = 0;
    localState.paneSlides = {};
  }

  function ontologyPaneSlideKey(phase, depth) {
    return `${phase || 'present'}:${ontologyNormalizeDepth(depth)}`;
  }

  function ontologyPaneSlide(localState, phase, depth) {
    const slide = localState?.paneSlides?.[ontologyPaneSlideKey(phase, depth)];
    return {
      u: Number.isFinite(slide?.u) ? slide.u : 0,
      v: Number.isFinite(slide?.v) ? slide.v : 0,
    };
  }

  function ontologySetPaneSlide(localState, phase, depth, slide) {
    localState.paneSlides = localState.paneSlides || {};
    localState.paneSlides[ontologyPaneSlideKey(phase, depth)] = {
      u: Number(slide?.u) || 0,
      v: Number(slide?.v) || 0,
    };
  }

  function ontologyPaneSurfaceGeometry(graph, selected, localState, phase = 'present', depth = 'virtual') {
    const deckScene = ontologyCreateDeckScene(graph, selected, localState);
    const paneScene = deckScene.panes.get(phase) || deckScene.panes.get('present');
    const baseGeometry = paneScene?.geometry;
    if (phase === 'present' && ontologyNormalizeDepth(depth) === 'physical') {
      const lowerSurface = (deckScene.referenceSurfaces.present || [])
        .find((surface) => surface.id === 'lower-physical');
      return lowerSurface?.geometry || baseGeometry;
    }
    return baseGeometry;
  }

  function ontologyProjectPaneDragDelta(deltaX, deltaY, geometry) {
    const rawX = Number(deltaX) || 0;
    const rawY = Number(deltaY) || 0;
    if (!geometry?.point || (Math.abs(rawX) < 0.01 && Math.abs(rawY) < 0.01)) return { u: 0, v: 0 };
    const center = geometry.point(0.5, 0.5);
    const uEdge = geometry.point(0.6, 0.5);
    const vEdge = geometry.point(0.5, 0.6);
    const uAxis = { x: (uEdge.x - center.x) * 10, y: (uEdge.y - center.y) * 10 };
    const vAxis = { x: (vEdge.x - center.x) * 10, y: (vEdge.y - center.y) * 10 };
    const determinant = uAxis.x * vAxis.y - uAxis.y * vAxis.x;
    if (Math.abs(determinant) < 0.01) return { u: 0, v: 0 };
    return {
      u: (rawX * vAxis.y - rawY * vAxis.x) / determinant,
      v: (uAxis.x * rawY - uAxis.y * rawX) / determinant,
    };
  }

  function ontologySetPane(localState, pane) {
    if (!ONTOLOGY_TIME_PANE_ORDER.includes(pane)) return false;
    localState.focusTarget = 'pane';
    localState.activePane = pane;
    localState.activeDepth = ontologyNormalizeDepth(localState.activeDepth);
    localState.selectedRelation = null;
    ontologyResetFocusViewport(localState);
    return true;
  }

  function ontologySetDepth(localState, depth) {
    if (!ONTOLOGY_DEPTH_NAV_ORDER.includes(depth)) return false;
    localState.focusTarget = 'pane';
    localState.activeDepth = depth;
    localState.selectedRelation = null;
    ontologyResetFocusViewport(localState);
    return true;
  }

  function ontologyAdjustZoom(localState, direction) {
    const factor = direction > 0 ? 1.12 : 0.88;
    localState.zoom = Math.max(0.38, Math.min(2.6, (localState.zoom || 1) * factor));
  }

  function ontologyHandleSemanticWheel(localState, ev) {
    if (ev.ctrlKey || ev.metaKey) {
      ontologyAdjustZoom(localState, ev.deltaY < 0 ? 1 : -1);
      return true;
    }
    const absX = Math.abs(ev.deltaX || 0);
    const absY = Math.abs(ev.deltaY || 0);
    if (Math.max(absX, absY) < 12) return false;
    const now = performance.now();
    if (now - (localState.lastWheelNavAt || 0) < 210) return true;
    if (absX > absY * 1.12) {
      const nextPane = ontologyShiftPane(localState.activePane || 'present', ev.deltaX);
      ontologySetPane(localState, nextPane);
      localState.lastWheelNavAt = now;
      return true;
    }
    if (absY > absX * 1.12) {
      const nextDepth = ontologyShiftDepth(localState.activeDepth, ev.deltaY);
      ontologySetDepth(localState, nextDepth);
      localState.lastWheelNavAt = now;
      return true;
    }
    return false;
  }

  function ontologyFocusNodeIds(graph, selected) {
    const ids = new Set();
    const canonicalId = ontologyCanonicalIdForNode(graph, selected);
    if (canonicalId) {
      ids.add(canonicalId);
      for (const projection of ontologyProjectionNodesForCanonical(graph, canonicalId)) ids.add(projection.id);
      for (const edge of graph?.edges || []) {
        if (edge.source === canonicalId && ['binds', 'derived_from', 'provides_evidence_for', 'operates_inside'].includes(edge.relation)) {
          ids.add(edge.target);
        }
        if (edge.target === canonicalId && ['binds', 'derived_from', 'provides_evidence_for'].includes(edge.relation)) {
          ids.add(edge.source);
        }
      }
      if (selected?.id) ids.add(selected.id);
      return ids;
    }

    if (selected?.id) ids.add(selected.id);
    for (const edge of graph?.edges || []) {
      if (edge.source === selected?.id) ids.add(edge.target);
      if (edge.target === selected?.id) ids.add(edge.source);
      if (ids.size > 16) break;
    }
    return ids;
  }

  function ontologyRelatedNodeIds(graph, selected) {
    const ids = new Set();
    const canonicalId = ontologyCanonicalIdForNode(graph, selected) || selected?.id;
    if (selected?.id) ids.add(selected.id);
    if (canonicalId) {
      ids.add(canonicalId);
      for (const projection of ontologyProjectionNodesForCanonical(graph, canonicalId)) ids.add(projection.id);
    }

    for (let pass = 0; pass < 2; pass += 1) {
      for (const edge of graph?.edges || []) {
        const touchesFocus = ids.has(edge.source) || ids.has(edge.target);
        if (!touchesFocus) continue;
        if (pass === 1 && edge.kind !== 'relation_map') continue;
        ids.add(edge.source);
        ids.add(edge.target);
      }
    }
    return ids;
  }

  function ontologyNarrativeNodeIds(graph, selected) {
    const ids = new Set();
    const add = (id) => {
      if (id && ontologyNodeById(graph, id)) ids.add(id);
    };
    const addCanonicalBundle = (canonicalId) => {
      add(canonicalId);
      for (const projection of ontologyProjectionNodesForCanonical(graph, canonicalId)) add(projection.id);
    };
    const selectedId = selected?.id || 'entity.llm_chat_session';
    const canonicalId = ontologyCanonicalIdForNode(graph, selected) || selectedId;
    addCanonicalBundle(canonicalId);

    [
      'entity.llm_chat_session',
      'projection.llm_chat_session.space.chat_card',
      'projection.llm_chat_session.topology.runtime',
      'projection.llm_chat_session.storage.session_file',
      'projection.llm_chat_session.intent.context_binding',
      'projection.llm_chat_session.action.message_send',
      'entity.chat_memory',
      'projection.chat_memory.storage.trace_file',
      'goal',
      'output.structured',
      'desktop',
      'terminal',
      'cpu',
      'ram',
      'disk',
    ].forEach(add);

    if (selectedId === 'goal' || selectedId === 'plan' || selectedId === 'task') {
      ['goal', 'plan', 'task', 'alternate.plan', 'candidate.future'].forEach(add);
    }

    return ids;
  }

  function ontologyVisibleGraph(graph, mode, selected) {
    const allNodes = graph?.nodes || [];
    const allEdges = graph?.edges || [];
    if (mode !== 'focus') return { nodes: allNodes, edges: allEdges };

    const ids = ontologyFocusNodeIds(graph, selected);
    const relationPriority = new Set(['represented_by', 'binds', 'derived_from', 'provides_evidence_for', 'operates_inside']);
    return {
      nodes: allNodes.filter((node) => ids.has(node.id)),
      edges: allEdges.filter((edge) => (
        ids.has(edge.source)
        && ids.has(edge.target)
        && (relationPriority.has(edge.relation) || edge.source === selected?.id || edge.target === selected?.id)
      )),
    };
  }

  function renderOntologySvgNode(parent, node, point, options = {}) {
    const color = options.color || ontologyLayerColor(node.layer);
    const size = options.size || ontologyNodeSize(node, options.mode || 'focus');
    const meta = Object.prototype.hasOwnProperty.call(options, 'meta')
      ? String(options.meta || '')
      : ontologyDisplayMeta(node, options.mode || 'focus');
    const namespaceBadge = Object.prototype.hasOwnProperty.call(options, 'namespaceBadge')
      ? String(options.namespaceBadge || '')
      : ontologyNamespaceBadge(node);
    const layerBadge = Object.prototype.hasOwnProperty.call(options, 'layerBadge')
      ? String(options.layerBadge || '')
      : '';
    const group = svgEl('g', {
      class: `egd-ontology-node${options.selected ? ' egd-ontology-node-selected' : ''}${options.extraClass ? ` ${options.extraClass}` : ''}`,
      transform: `translate(${point.x} ${point.y})`,
      data: { id: node.id },
      onclick: options.onclick,
    });
    group.appendChild(svgEl('rect', {
      class: 'egd-ontology-node-box',
      x: -size.width / 2,
      y: -size.height / 2,
      width: size.width,
      height: size.height,
      rx: options.rx || 8,
      fill: options.fill || (node.synthetic ? '#F7F5F0' : '#FFFFFF'),
      stroke: color,
      'stroke-width': options.selected ? '2.4' : '1.35',
    }));
    if (namespaceBadge) {
      const badgeText = ontologyTrimText(namespaceBadge === 'egdesk' ? 'egdesk' : namespaceBadge, 12);
      const badgeWidth = Math.max(54, Math.min(78, badgeText.length * 6.4 + 18));
      const badgeX = size.width / 2 - badgeWidth - 8;
      const badgeY = -size.height / 2 + 7;
      group.appendChild(svgEl('rect', {
        class: 'egd-ontology-node-namespace-badge',
        x: badgeX,
        y: badgeY,
        width: badgeWidth,
        height: 18,
        rx: 6,
        fill: 'rgba(45, 90, 123, 0.20)',
        stroke: 'rgba(45, 90, 123, 0.42)',
        'stroke-width': '1.1',
      }));
      group.appendChild(svgEl('text', {
        class: 'egd-ontology-node-namespace-text',
        x: badgeX + badgeWidth / 2,
        y: badgeY + 12.7,
        fill: 'rgba(36, 78, 109, 0.90)',
        'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
        'font-size': '8.8',
        'font-weight': '900',
        'text-anchor': 'middle',
      }, badgeText));
    }
    if (layerBadge) {
      const badgeText = ontologyTrimText(layerBadge, 10);
      const badgeWidth = Math.max(34, Math.min(62, badgeText.length * 4.8 + 12));
      const badgeX = -size.width / 2 + 7;
      const badgeY = size.height / 2 - 19;
      group.appendChild(svgEl('rect', {
        class: 'egd-ontology-node-layer-badge',
        x: badgeX,
        y: badgeY,
        width: badgeWidth,
        height: 13,
        rx: 5,
        fill: 'rgba(92, 97, 105, 0.08)',
        stroke: 'rgba(92, 97, 105, 0.18)',
        'stroke-width': '0.7',
      }));
      group.appendChild(svgEl('text', {
        class: 'egd-ontology-node-layer-text',
        x: badgeX + badgeWidth / 2,
        y: badgeY + 9.2,
        fill: '#596875',
        'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
        'font-size': '7',
        'font-weight': '750',
        'text-anchor': 'middle',
      }, badgeText));
    }
    if (options.icon) {
      const iconX = -size.width / 2 + 16;
      const iconY = meta ? -4 : 5;
      group.appendChild(svgEl('rect', {
        class: 'egd-ontology-node-icon-bg',
        x: iconX - 9,
        y: iconY - 11,
        width: 18,
        height: 18,
        rx: 4,
        fill: options.iconBg || 'rgba(92, 97, 105, 0.08)',
        stroke: options.iconBgStroke || 'rgba(92, 97, 105, 0.18)',
        'stroke-width': '0.7',
      }));
      group.appendChild(svgEl('text', {
        class: 'egd-ontology-node-icon',
        x: iconX,
        y: iconY,
        fill: options.iconColor || color,
        'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
        'font-size': options.iconSize || '13',
        'font-weight': '900',
        'text-anchor': 'middle',
        'pointer-events': 'none',
      }, String(options.icon)));
    }
    group.appendChild(svgEl('text', {
      class: 'egd-ontology-node-label',
      x: -size.width / 2 + (options.icon ? 34 : 14),
      y: layerBadge ? (meta ? -8 : -6) : (meta ? -5 : 4),
      fill: options.labelFill || '#1A1A1A',
      'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
      'font-size': '11',
      'font-weight': '700',
    }, ontologyTrimText(options.label || ontologyDisplayLabel(node, options.mode || 'focus'), options.labelMax || 25)));
    if (meta) {
      group.appendChild(svgEl('text', {
        class: 'egd-ontology-node-meta',
        x: -size.width / 2 + 14,
        y: 12,
        fill: '#5A5A5A',
        'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
        'font-size': '9',
        'font-weight': '500',
      }, ontologyTrimText(meta, options.metaMax || 28)));
    }
    if (options.showPorts) {
      group.appendChild(svgEl('circle', {
        class: 'egd-ontology-node-port egd-ontology-node-port-top',
        cx: 0,
        cy: -size.height / 2,
        r: 4,
        fill: color,
        stroke: 'rgba(255, 255, 255, 0.92)',
        'stroke-width': '1.4',
      }));
      group.appendChild(svgEl('circle', {
        class: 'egd-ontology-node-port egd-ontology-node-port-bottom',
        cx: 0,
        cy: size.height / 2,
        r: 4,
        fill: color,
        stroke: 'rgba(255, 255, 255, 0.92)',
        'stroke-width': '1.4',
      }));
    }
    parent.appendChild(group);
    return group;
  }

  function renderOntologyFocusPlanes(graphGroup, graph, selected, localState, onSelect, onPaneSelect, onRelationSelect, onDepthSelect) {
    const canonicalId = ontologyCanonicalIdForNode(graph, selected) || selected?.id;
    const canonicalNode = ontologyNodeById(graph, canonicalId) || selected;
    const projectionNodes = ontologyProjectionNodesForCanonical(graph, canonicalId);
    const projectionByFacet = new Map(projectionNodes.map((node) => [ontologyProjectionFacet(node.id), node]));
    const selectedRelatedIds = ontologyRelatedNodeIds(graph, selected);
    const narrativeIds = ontologyNarrativeNodeIds(graph, selected);
    const focusTarget = localState.focusTarget || 'object';
    const selectedPhase = ontologyPhaseForNode(selected);
    const usePaneMap = true;
    const deckScene = ontologyCreateDeckScene(graph, selected, localState);
    const activePane = deckScene.activePane || selectedPhase || 'present';
    const phaseLabels = deckScene.phaseLabels;
    const phaseColor = deckScene.phaseColor;
    const paneGroup = svgEl('g', { class: 'egd-ontology-focus-planes egd-ontology-time-panes' });
    const temporalLinkGroup = svgEl('g', { class: 'egd-ontology-temporal-object-links' });
    const centerGroup = svgEl('g', { class: 'egd-ontology-focus-center' });
    const contextGroup = svgEl('g', { class: 'egd-ontology-focus-context' });
    const noviceOverlayGroup = svgEl('g', { class: 'egd-ontology-novice-overlay' });
    localState.clipId = localState.clipId || newAgendaId('ontology-clip');
    const contentClipRootId = localState.clipId;

    const drawPane = (phase, bounds) => {
      const active = usePaneMap ? phase === activePane : phase === 'present';
      const color = phaseColor(phase);
      const pane = svgEl('g', {
        class: `egd-ontology-time-pane egd-ontology-time-pane-${phase}${active ? ' egd-ontology-time-pane-active' : ''}`,
        data: { phase },
      });
      const sliceX = bounds.x + bounds.w / 2;
      pane.appendChild(svgEl('line', {
        class: 'egd-ontology-time-slice-guide',
        x1: sliceX,
        y1: 132,
        x2: sliceX,
        y2: bounds.y + bounds.h + 26,
        stroke: color,
        'stroke-width': active ? '2.1' : '1.2',
        'stroke-opacity': active ? '0.34' : '0.14',
        'stroke-dasharray': active ? '12 12' : '8 12',
        'vector-effect': 'non-scaling-stroke',
        'pointer-events': 'none',
      }));
      pane.appendChild(svgEl('circle', {
        class: 'egd-ontology-time-slice-guide-dot',
        cx: sliceX,
        cy: 146,
        r: active ? 5.5 : 4,
        fill: '#FFFFFF',
        stroke: color,
        'stroke-width': active ? '2' : '1.2',
        'stroke-opacity': active ? '0.56' : '0.26',
        'pointer-events': 'none',
      }));
      pane.appendChild(svgEl('rect', {
        class: 'egd-ontology-pane-hit',
        x: bounds.x,
        y: bounds.y,
        width: bounds.w,
        height: bounds.h,
        rx: active ? 22 : 18,
        fill: 'transparent',
        onmousedown: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
        },
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          onPaneSelect(phase);
        },
      }));
      paneGroup.appendChild(pane);
      return pane;
    };

    paneGroup.appendChild(svgEl('line', {
      class: 'egd-ontology-trajectory-open-canvas-baseline',
      x1: 46,
      y1: 708,
      x2: 1274,
      y2: 708,
      stroke: 'rgba(138, 107, 46, 0.14)',
      'stroke-width': '1.2',
      'stroke-dasharray': '10 12',
      'vector-effect': 'non-scaling-stroke',
      'pointer-events': 'none',
    }));
    if (!usePaneMap) {
      paneGroup.appendChild(svgEl('path', {
        class: 'egd-ontology-time-flow-band',
        d: 'M 132 146 L 1148 146 L 1148 136 L 1196 166 L 1148 196 L 1148 186 L 132 186 Z',
        fill: 'rgba(111, 90, 154, 0.012)',
        stroke: 'rgba(111, 90, 154, 0.055)',
        'stroke-width': '0.8',
        'stroke-linejoin': 'miter',
        opacity: '0.54',
        'pointer-events': 'none',
      }));
      paneGroup.appendChild(svgEl('text', {
        x: 664,
        y: 170,
        fill: 'rgba(111, 90, 154, 0.38)',
        'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
        'font-size': '11',
        'font-weight': '850',
        'text-anchor': 'middle',
        'pointer-events': 'none',
      }, '과거 → 현재 → 미래'));
    }

    const paneBounds = deckScene.paneBounds;
    drawPane('past', paneBounds.past);
    drawPane('present', paneBounds.present);
    drawPane('future', paneBounds.future);
    paneGroup.appendChild(temporalLinkGroup);

    {
      const timeAxisY = 116;
      const timeAxisStart = paneBounds.past.x + paneBounds.past.w / 2;
      const timeAxisNow = paneBounds.present.x + paneBounds.present.w / 2;
      const timeAxisEnd = paneBounds.future.x + paneBounds.future.w / 2;
      centerGroup.appendChild(svgEl('path', {
        class: 'egd-ontology-time-axis',
        d: `M ${timeAxisStart} ${timeAxisY} L ${timeAxisEnd} ${timeAxisY}`,
        fill: 'none',
        stroke: 'rgba(111, 90, 154, 0.28)',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-dasharray': '10 10',
        'pointer-events': 'none',
      }));
      centerGroup.appendChild(svgEl('polygon', {
        class: 'egd-ontology-time-axis-arrow',
        points: `${timeAxisEnd + 22},${timeAxisY} ${timeAxisEnd - 4},${timeAxisY - 12} ${timeAxisEnd - 4},${timeAxisY + 12}`,
        fill: 'rgba(111, 90, 154, 0.34)',
        'pointer-events': 'none',
      }));
      [
        { x: timeAxisStart, label: '과거', fill: '#6F5A9A', active: activePane === 'past' },
        { x: timeAxisNow, label: '현재', fill: '#4E5360', active: activePane === 'present' },
        { x: timeAxisEnd, label: '미래', fill: '#6F5A9A', active: activePane === 'future' },
      ].forEach((tick) => {
        centerGroup.appendChild(svgEl('circle', {
          class: `egd-ontology-time-axis-tick${tick.active ? ' egd-ontology-time-axis-tick-active' : ''}`,
          cx: tick.x,
          cy: timeAxisY,
          r: tick.active ? 5.2 : 4,
          fill: '#FFFFFF',
          stroke: tick.fill,
          'stroke-width': tick.active ? '2' : '1.25',
          'stroke-opacity': tick.active ? '0.76' : '0.34',
          'pointer-events': 'none',
        }));
        centerGroup.appendChild(svgEl('text', {
          class: `egd-ontology-time-axis-label${tick.active ? ' egd-ontology-time-axis-label-active' : ''}`,
          x: tick.x,
          y: timeAxisY + 26,
          fill: tick.fill,
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': tick.active ? '13' : '12',
          'font-weight': tick.active ? '900' : '850',
          'text-anchor': 'middle',
          opacity: tick.active ? '0.88' : '0.54',
          'pointer-events': 'none',
        }, tick.label));
      });
    }

    const drawFocusLegend = () => {
      const legend = svgEl('g', { class: 'egd-ontology-focus-legend' });
      const x = 70;
      const y = 108;
      legend.appendChild(svgEl('rect', {
        x,
        y,
        width: 404,
        height: 132,
        rx: 14,
        fill: 'rgba(255, 255, 255, 0.92)',
        stroke: 'rgba(92, 97, 105, 0.22)',
        'stroke-width': '1.25',
      }));
      const rows = [
        { label: '시간대 간 연결', color: '#6F5A9A', dash: null, width: 3.8, arrow: true },
        { label: '시간대 안 연결', color: '#3F7B61', dash: null, width: 3.4 },
        { label: '물리 계층선', color: '#2D5A7B', dash: null, width: 3.2 },
        { label: '객체층: 물리 / 연결 / 가상', color: '#2D5A7B', swatches: ['#2D5A7B', '#3F7B61', '#8A6B2E'] },
        { label: 'EG-Desk 배지 = 커스텀 개념', color: '#2D5A7B', badge: 'EG-Desk' },
      ];
      rows.forEach((row, index) => {
        const rowY = y + 21 + index * 22;
        if (row.swatches) {
          row.swatches.forEach((color, swatchIndex) => {
            legend.appendChild(svgEl('rect', {
              x: x + 14 + swatchIndex * 15,
              y: rowY - 8,
              width: 11,
              height: 11,
              rx: 3,
              fill: color,
              opacity: '0.82',
            }));
          });
        } else if (row.badge) {
          legend.appendChild(svgEl('rect', {
            x: x + 14,
            y: rowY - 12,
            width: 58,
            height: 19,
            rx: 6,
            fill: 'rgba(45, 90, 123, 0.13)',
            stroke: 'rgba(45, 90, 123, 0.28)',
            'stroke-width': '1',
          }));
          legend.appendChild(svgEl('text', {
            x: x + 43,
            y: rowY + 1,
            fill: 'rgba(45, 90, 123, 0.78)',
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': '8.8',
            'font-weight': '900',
            'text-anchor': 'middle',
          }, row.badge));
        } else {
          legend.appendChild(svgEl('path', {
            d: `M ${x + 14} ${rowY - 2} L ${x + 56} ${rowY - 2}`,
            fill: 'none',
            stroke: row.color,
            'stroke-width': row.width || (index === 0 ? '3' : '2.2'),
            'stroke-dasharray': row.dash,
            'stroke-linecap': 'square',
          }));
          if (row.arrow) {
            legend.appendChild(svgEl('polygon', {
              points: `${x + 60},${rowY - 2} ${x + 51},${rowY - 7} ${x + 51},${rowY + 3}`,
              fill: row.color,
            }));
          }
        }
        legend.appendChild(svgEl('text', {
          x: x + 70,
          y: rowY + 2,
          fill: 'rgba(30, 38, 45, 0.80)',
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': '12',
          'font-weight': '900',
        }, row.label));
      });
      centerGroup.appendChild(legend);
    };
    if (!usePaneMap) drawFocusLegend();

    const drawBrowseSpine = () => {
      const steps = [
        { x: 286, y: 666, label: '과거 기억', meta: '저장된 흔적', color: '#6F5A9A' },
        { x: 540, y: 666, label: '현재 물리 실행', meta: '기기 · 파일 · 앱', color: '#2D5A7B' },
        { x: 794, y: 666, label: '현재 의미 연결', meta: '세션 · 컨텍스트', color: '#3F7B61' },
        { x: 1048, y: 666, label: '미래 목표', meta: '산출 · 계획', color: '#8A6B2E' },
      ];
      steps.slice(0, -1).forEach((step, index) => {
        const next = steps[index + 1];
        centerGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-browse-spine-arrow',
          d: `M ${step.x + 96} ${step.y} L ${next.x - 96} ${next.y}`,
          fill: 'none',
          stroke: 'rgba(111, 90, 154, 0.52)',
          'stroke-width': '3.2',
          'stroke-linecap': 'square',
          'pointer-events': 'none',
        }));
        centerGroup.appendChild(svgEl('polygon', {
          class: 'egd-ontology-browse-spine-arrow-head',
          points: `${next.x - 90},${next.y} ${next.x - 102},${next.y - 6} ${next.x - 102},${next.y + 6}`,
          fill: 'rgba(111, 90, 154, 0.62)',
          'pointer-events': 'none',
        }));
      });
      steps.forEach((step, index) => {
        centerGroup.appendChild(svgEl('rect', {
          class: 'egd-ontology-browse-spine-card',
          x: step.x - 96,
          y: step.y - 34,
          width: 192,
          height: 68,
          rx: 12,
          fill: 'rgba(255, 255, 255, 0.94)',
          stroke: step.color,
          'stroke-width': '2',
          'stroke-opacity': '0.46',
          'pointer-events': 'none',
        }));
        centerGroup.appendChild(svgEl('circle', {
          cx: step.x - 72,
          cy: step.y,
          r: 12,
          fill: step.color,
          opacity: '0.86',
          'pointer-events': 'none',
        }));
        centerGroup.appendChild(svgEl('text', {
          x: step.x - 72,
          y: step.y + 4,
          fill: '#FFFFFF',
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': '10',
          'font-weight': '900',
          'text-anchor': 'middle',
          'pointer-events': 'none',
        }, String(index + 1)));
        centerGroup.appendChild(svgEl('text', {
          x: step.x - 50,
          y: step.y - 6,
          fill: '#1A1A1A',
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': '13.4',
          'font-weight': '900',
          'pointer-events': 'none',
        }, step.label));
        centerGroup.appendChild(svgEl('text', {
          x: step.x - 50,
          y: step.y + 14,
          fill: 'rgba(90, 90, 90, 0.82)',
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': '10.6',
          'font-weight': '750',
          'pointer-events': 'none',
        }, step.meta));
      });
    };
    if (!usePaneMap) drawBrowseSpine();

    const drawNoviceGuideBoard = () => {
      if (!usePaneMap) return;
      const selectedGoal = selected?.id === 'goal';
      const relationFocus = selectedGoal ? 'future' : activePane;
      const isPastRelationFocus = relationFocus === 'past';
      const isCurrentRelationFocus = relationFocus === 'present';
      const isFutureRelationFocus = relationFocus === 'future';
      const board = svgEl('g', { class: 'egd-ontology-novice-guide' });
      board.appendChild(svgEl('rect', {
        x: 32,
        y: 96,
        width: 1312,
        height: 814,
        rx: 26,
        fill: 'rgba(250, 249, 246, 0.995)',
        stroke: 'rgba(92, 97, 105, 0.20)',
        'stroke-width': '1.4',
        'pointer-events': 'none',
      }));
      const drawSimpleLabel = (x, y, text, color, size = 16, anchor = 'start', opacity = '1') => {
        board.appendChild(svgEl('text', {
          x,
          y,
          fill: color,
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': String(size),
          'font-weight': '950',
          'text-anchor': anchor,
          opacity,
          'pointer-events': 'none',
        }, text));
      };
      const drawShelf = (x, y, w, h, label, color, options = {}) => {
        const opacity = options.opacity ?? '1';
        const variant = options.variant || 'pane';
        if (variant === 'physical') {
          board.appendChild(svgEl('rect', {
            x: x + 4,
            y: y + h - 12,
            width: w - 8,
            height: 14,
            rx: 5,
            fill: 'rgba(45, 90, 123, 0.16)',
            opacity,
            'pointer-events': 'none',
          }));
        }
        board.appendChild(svgEl('rect', {
          x,
          y,
          width: w,
          height: h,
          rx: options.rx || (variant === 'physical' ? 8 : variant === 'binding' ? 18 : 16),
          fill: options.fill,
          stroke: color,
          'stroke-width': variant === 'physical' ? (options.strong ? '3.8' : '2.6') : variant === 'binding' ? (options.strong ? '3' : '2.2') : (options.strong ? '3.2' : '2'),
          'stroke-opacity': variant === 'physical' ? (options.strong ? '0.86' : '0.50') : variant === 'binding' ? (options.strong ? '0.66' : '0.34') : (options.strong ? '0.78' : '0.38'),
          opacity,
          'pointer-events': 'none',
        }));
        if (variant === 'binding') {
          board.appendChild(svgEl('line', {
            x1: x + 20,
            y1: y + h / 2,
            x2: x + w - 20,
            y2: y + h / 2,
            stroke: color,
            'stroke-width': options.strong ? '7.2' : '4.8',
            'stroke-linecap': 'round',
            opacity: String(Math.min(Number(opacity) || 1, options.strong ? 0.82 : 0.34)),
            'pointer-events': 'none',
          }));
        }
        board.appendChild(svgEl('circle', {
          cx: x + 24,
          cy: y + 25,
          r: variant === 'physical' ? (options.strong ? 10 : 7) : options.strong ? 12 : 8,
          fill: color,
          opacity: variant === 'binding' ? (options.strong ? '0.74' : '0.46') : options.strong ? '0.90' : '0.58',
          'pointer-events': 'none',
        }));
        drawSimpleLabel(x + 46, y + 31, label, color, options.titleSize || 15);
        if (options.role) {
          board.appendChild(svgEl('text', {
            x: x + 46,
            y: y + 50,
            fill: color,
            opacity: '0.68',
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': options.roleSize || '10.8',
            'font-weight': '850',
            'pointer-events': 'none',
          }, options.role));
        }
      };
      const drawSimpleNode = (x, y, w, h, label, color, options = {}) => {
        const opacity = options.opacity ?? '1';
        board.appendChild(svgEl('rect', {
          x,
          y,
          width: w,
          height: h,
          rx: options.kind === 'physical' ? 5 : options.kind === 'connector' ? 16 : 10,
          fill: options.fill || 'rgba(255, 255, 255, 0.96)',
          stroke: color,
          'stroke-width': options.strong ? '3.4' : '2.2',
          'stroke-opacity': options.strong ? '0.88' : '0.62',
          opacity,
          'pointer-events': 'none',
        }));
        if (options.badge) {
          const badgeLabel = options.namespaceLabel || 'egdesk';
          board.appendChild(svgEl('rect', {
            x: x + 1,
            y: y + 1,
            width: w - 2,
            height: 28,
            rx: options.kind === 'connector' ? 15 : 9,
            fill: 'rgba(45, 90, 123, 0.18)',
            stroke: 'rgba(45, 90, 123, 0.34)',
            'stroke-width': '1',
            opacity,
            'pointer-events': 'none',
          }));
          board.appendChild(svgEl('text', {
            x: x + 14,
            y: y + 19,
            fill: 'rgba(24, 60, 86, 0.76)',
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': '11',
            'font-weight': '900',
            opacity,
            'pointer-events': 'none',
          }, options.badgeLabel || '개념'));
          board.appendChild(svgEl('text', {
            x: x + w - 18,
            y: y + 19,
            fill: 'rgba(24, 60, 86, 0.94)',
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': '12.8',
            'font-weight': '950',
            'text-anchor': 'end',
            opacity,
            'pointer-events': 'none',
          }, badgeLabel));
        }
        board.appendChild(svgEl('text', {
          x: x + 16,
          y: y + (options.badge ? 47 : 29),
          fill: '#1A1A1A',
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': options.large ? '16.5' : '14.8',
          'font-weight': '950',
          opacity,
          'pointer-events': 'none',
        }, label));
      };
      const drawRelationHub = (x, y, w, h, label, options = {}) => {
        const opacity = options.opacity ?? '1';
        const strong = Boolean(options.strong);
        const color = options.color || '#3F7B61';
        board.appendChild(svgEl('rect', {
          x,
          y,
          width: w,
          height: h,
          rx: h / 2,
          fill: strong ? 'rgba(240, 250, 245, 0.98)' : 'rgba(250, 253, 251, 0.96)',
          stroke: color,
          'stroke-width': strong ? '5.2' : '3.2',
          'stroke-opacity': strong ? '0.86' : '0.66',
          opacity,
          'pointer-events': 'none',
        }));
        board.appendChild(svgEl('line', {
          x1: x + 22,
          y1: y + h / 2,
          x2: x + w - 22,
          y2: y + h / 2,
          stroke: color,
          'stroke-width': strong ? '6.2' : '4.4',
          'stroke-linecap': 'square',
          opacity: String(Math.min(Number(opacity) || 1, strong ? 0.72 : 0.42)),
          'pointer-events': 'none',
        }));
        [x + 22, x + w - 22].forEach((cx) => {
          board.appendChild(svgEl('circle', {
            cx,
            cy: y + h / 2,
            r: strong ? 9 : 7,
            fill: '#FFFFFF',
            stroke: color,
            'stroke-width': strong ? '3.2' : '2.4',
            opacity,
            'pointer-events': 'none',
          }));
        });
        board.appendChild(svgEl('text', {
          x: x + w / 2,
          y: y + h / 2 + 5,
          fill: color,
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': '14',
          'font-weight': '950',
          'text-anchor': 'middle',
          opacity,
          'pointer-events': 'none',
        }, `관계: ${label}`));
      };
      const drawGlyphKey = (activeKind = 'same') => {
        const x = 858;
        const y = 214;
        board.appendChild(svgEl('rect', {
          x,
          y,
          width: 382,
          height: 62,
          rx: 13,
          fill: 'rgba(255, 255, 255, 0.94)',
          stroke: 'rgba(92, 97, 105, 0.20)',
          'stroke-width': '1.2',
          'pointer-events': 'none',
        }));
        board.appendChild(svgEl('text', {
          x: x + 16,
          y: y + 18,
          fill: 'rgba(26,26,26,0.70)',
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': '10.2',
          'font-weight': '950',
          'pointer-events': 'none',
        }, '지금 보는 관계'));
        const items = [
          { x: x + 58, y: y + 38, label: '현재 안', color: '#3F7B61', kind: 'socket', family: 'same', w: 108 },
          { x: x + 210, y: y + 38, label: '현재 → 미래', color: '#5B4388', kind: 'portal', family: 'time', w: 132 },
          { x: x + 58, y: y + 58, label: '부품 묶음', color: '#2D5A7B', kind: 'tree', family: 'part', w: 108 },
          { x: x + 210, y: y + 58, label: '소속 배지', color: '#2D5A7B', kind: 'badge', family: 'badge', w: 108 },
        ];
        items.filter((item) => item.family === activeKind || item.family === 'part' || item.family === 'badge').forEach((item) => {
          const gx = item.x;
          const gy = item.y;
          const active = true;
          board.appendChild(svgEl('rect', {
            x: gx - 46,
            y: gy - 13,
            width: item.w,
            height: 20,
            rx: 9,
            fill: active ? `${item.color}22` : 'rgba(255,255,255,0.58)',
            stroke: item.color,
            'stroke-width': active ? '1.8' : '0.9',
            'stroke-opacity': active ? '0.54' : '0.18',
            opacity: active ? '1' : '0.42',
            'pointer-events': 'none',
          }));
          if (item.kind === 'portal') {
            board.appendChild(svgEl('rect', { x: gx - 25, y: gy - 12, width: 11, height: 24, rx: 4, fill: 'rgba(91,67,136,0.14)', stroke: item.color, 'stroke-width': '1.5', opacity: active ? '1' : '0.42', 'pointer-events': 'none' }));
            board.appendChild(svgEl('path', { d: `M ${gx - 38} ${gy} L ${gx - 26} ${gy} M ${gx - 13} ${gy} L ${gx + 2} ${gy}`, fill: 'none', stroke: item.color, 'stroke-width': '3.2', 'stroke-dasharray': '6 4', 'stroke-linecap': 'square', opacity: active ? '1' : '0.42', 'pointer-events': 'none' }));
          } else if (item.kind === 'socket') {
            board.appendChild(svgEl('line', { x1: gx - 36, y1: gy, x2: gx + 3, y2: gy, stroke: item.color, 'stroke-width': '4.2', 'stroke-linecap': 'square', opacity: active ? '1' : '0.42', 'pointer-events': 'none' }));
            [gx - 35, gx + 2].forEach((cx) => board.appendChild(svgEl('circle', { cx, cy: gy, r: 4.2, fill: '#FFFFFF', stroke: item.color, 'stroke-width': '1.9', opacity: active ? '1' : '0.42', 'pointer-events': 'none' })));
          } else if (item.kind === 'tree') {
            board.appendChild(svgEl('path', { d: `M ${gx - 15} ${gy - 11} L ${gx - 15} ${gy + 9} M ${gx - 33} ${gy} L ${gx + 2} ${gy} M ${gx - 33} ${gy} L ${gx - 33} ${gy + 8} M ${gx + 2} ${gy} L ${gx + 2} ${gy + 8}`, fill: 'none', stroke: item.color, 'stroke-width': '3', 'stroke-linecap': 'square', opacity: active ? '1' : '0.42', 'pointer-events': 'none' }));
          } else {
            board.appendChild(svgEl('rect', { x: gx - 42, y: gy - 9, width: 51, height: 18, rx: 5, fill: 'rgba(45,90,123,0.24)', stroke: 'rgba(45,90,123,0.58)', 'stroke-width': '1', opacity: active ? '1' : '0.42', 'pointer-events': 'none' }));
            board.appendChild(svgEl('text', { x: gx - 16, y: gy + 3, fill: 'rgba(24,60,86,0.98)', 'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif', 'font-size': '8.2', 'font-weight': '950', 'text-anchor': 'middle', opacity: active ? '1' : '0.42', 'pointer-events': 'none' }, 'egdesk'));
          }
          board.appendChild(svgEl('text', {
            x: gx + 8,
            y: gy + 4,
            fill: item.color,
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': '10.2',
            'font-weight': '900',
            opacity: active ? '1' : '0.42',
            'pointer-events': 'none',
          }, item.label));
        });
      };
      const drawMiniPane = (x, title, color, side) => {
        const paneOpacity = side === activePane ? '0.72' : '0.34';
        board.appendChild(svgEl('rect', {
          x,
          y: 330,
          width: 210,
          height: 328,
          rx: 20,
          fill: 'rgba(255,255,255,0.90)',
          stroke: color,
          'stroke-width': side === activePane ? '2.6' : '1.6',
          'stroke-opacity': side === activePane ? '0.58' : '0.24',
          opacity: selectedGoal ? (side === 'future' ? '0.72' : '0.22') : paneOpacity,
          'pointer-events': 'none',
        }));
        drawSimpleLabel(x + 22, 363, title, color, 19);
        drawShelf(x + 22, 390, 166, 72, '가상', '#8A6B2E', { fill: 'rgba(255,249,237,0.78)', opacity: selectedGoal && side !== 'future' ? '0.18' : '0.78' });
        drawShelf(x + 22, 482, 166, 56, '연결', '#3F7B61', { fill: 'rgba(236,249,242,0.78)', opacity: selectedGoal && side !== 'future' ? '0.18' : '0.64' });
        drawShelf(x + 22, 558, 166, 78, '물리', '#2D5A7B', { fill: 'rgba(226,239,246,0.78)', opacity: selectedGoal && side !== 'future' ? '0.14' : '0.64' });
        if (side === 'past') {
          drawSimpleNode(x + 48, 410, 118, 42, '채팅 기억', '#6F5A9A', { opacity: selectedGoal ? '0.16' : '0.70' });
          drawSimpleNode(x + 48, 580, 118, 38, '흔적 파일', '#596875', { opacity: selectedGoal ? '0.12' : '0.54' });
        } else {
          drawSimpleNode(x + 48, 410, 118, 42, '목표', '#8A6B2E', { badge: 'egdesk', opacity: selectedGoal ? '1' : '0.62', strong: selectedGoal });
          drawSimpleNode(x + 58, 582, 106, 38, '산출', '#2D5A7B', { opacity: selectedGoal ? '0.42' : '0.40' });
        }
      };
      const drawSimplePortal = (path, color, options = {}) => {
        const opacity = options.opacity || '1';
        board.appendChild(svgEl('path', {
          d: path,
          fill: 'none',
          stroke: 'rgba(255,255,255,0.94)',
          'stroke-width': options.underlay || '11',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'miter',
          opacity,
          'pointer-events': 'none',
        }));
        board.appendChild(svgEl('path', {
          class: options.className || 'egd-ontology-guide-temporal-corridor',
          d: path,
          fill: 'none',
          stroke: color,
          'stroke-width': options.railWidth || '4.2',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'miter',
          'stroke-dasharray': options.solid ? '' : (options.dash || '13 8'),
          opacity: options.railOpacity || opacity,
          'pointer-events': 'none',
        }));
      };
      const columns = {
        past: { x: 122, w: 226, title: '과거', color: '#6F5A9A' },
        present: { x: 398, w: 570, title: '현재', color: '#2D5A7B' },
        future: { x: 1014, w: 226, title: '미래', color: '#8A6B2E' },
      };
      const rows = {
        virtual: { y: 306, h: 112, label: '가상', color: '#8A6B2E', fill: 'rgba(255,249,237,0.98)' },
        binding: { y: 446, h: 82, label: '연결', color: '#3F7B61', fill: 'rgba(236,249,242,0.98)' },
        physical: { y: 556, h: 162, label: '물리', color: '#2D5A7B', fill: 'rgba(226,239,246,0.98)' },
      };
      const paneOpacity = (key) => {
        if (!selectedGoal) return key === activePane ? '1' : '0.44';
        if (key === 'future') return '0.46';
        if (key === 'present') return '0.30';
        return '0.10';
      };
      const drawRelationLabel = (x, y, text, color, width, options = {}) => {
        const opacity = options.opacity ?? '1';
        const glyph = options.kind || '';
        const glyphSpace = glyph ? 42 : 0;
        board.appendChild(svgEl('rect', {
          x,
          y: y - 17,
          width,
          height: glyph ? 28 : 24,
          rx: glyph ? 11 : 8,
          fill: 'rgba(255,255,255,0.94)',
          stroke: color,
          'stroke-width': glyph ? '2' : '1.5',
          'stroke-opacity': glyph ? '0.62' : '0.46',
          opacity,
          'pointer-events': 'none',
        }));
        if (glyph === 'socket') {
          const gx = x + 24;
          board.appendChild(svgEl('line', { x1: gx - 13, y1: y - 3, x2: gx + 13, y2: y - 3, stroke: color, 'stroke-width': '4.2', 'stroke-linecap': 'square', opacity, 'pointer-events': 'none' }));
          [gx - 13, gx + 13].forEach((cx) => board.appendChild(svgEl('circle', { cx, cy: y - 3, r: 4.8, fill: '#FFFFFF', stroke: color, 'stroke-width': '2', opacity, 'pointer-events': 'none' })));
        } else if (glyph === 'portal') {
          const gx = x + 24;
          board.appendChild(svgEl('rect', { x: gx - 5, y: y - 16, width: 10, height: 26, rx: 4, fill: 'rgba(91,67,136,0.14)', stroke: color, 'stroke-width': '1.8', opacity, 'pointer-events': 'none' }));
          board.appendChild(svgEl('path', { d: `M ${gx - 22} ${y - 3} L ${gx - 7} ${y - 3} M ${gx + 7} ${y - 3} L ${gx + 22} ${y - 3}`, fill: 'none', stroke: color, 'stroke-width': '4', 'stroke-dasharray': '6 4', 'stroke-linecap': 'square', opacity, 'pointer-events': 'none' }));
        }
        board.appendChild(svgEl('text', {
          x: x + glyphSpace + (width - glyphSpace) / 2,
          y: glyph ? y + 1 : y,
          fill: color,
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': glyph ? '12.4' : '10.8',
          'font-weight': '950',
          'text-anchor': 'middle',
          opacity,
          'pointer-events': 'none',
        }, text));
      };
      const drawLayerGrammarBoardV2 = () => {
        const focusFuture = isFutureRelationFocus;
        const focusPast = isPastRelationFocus;
        const selectedGoal = selected?.id === 'goal';
        const timeLens = selectedGoal || focusFuture || focusPast;
        const colors = {
          past: '#6F5A9A',
          present: '#2D5A7B',
          future: '#8A6B2E',
          virtual: '#8A6B2E',
          physical: '#244E6C',
          same: '#238A66',
          axis: '#7A8086',
          time: '#6D3FA3',
        };

        const drawTimeRail = () => {
          const x1 = 172;
          const x2 = 1218;
          const y = 184;
          board.appendChild(svgEl('line', { x1, y1: y, x2, y2: y, stroke: colors.axis, 'stroke-width': '6.2', 'stroke-linecap': 'square', opacity: '0.76', 'pointer-events': 'none' }));
          board.appendChild(svgEl('polygon', { points: `${x2},${y} ${x2 - 22},${y - 10} ${x2 - 22},${y + 10}`, fill: colors.axis, opacity: '0.78', 'pointer-events': 'none' }));
          drawSimpleLabel(x2 - 6, y - 18, '시간', colors.axis, 13, 'end', '0.74');
          const boundaryColor = selectedGoal || focusFuture
            ? colors.time
            : focusPast
              ? colors.past
              : colors.present;
          const boundaryXs = selectedGoal || focusFuture
            ? [690]
            : focusPast
              ? [360, 690]
              : [260, 806];
          boundaryXs.forEach((x) => {
            board.appendChild(svgEl('line', {
              x1: x,
              y1: y - 14,
              x2: x,
              y2: y + 28,
              stroke: boundaryColor,
              'stroke-width': '3',
              'stroke-opacity': selectedGoal || focusFuture ? '0.42' : '0.48',
              'stroke-linecap': 'square',
              'pointer-events': 'none',
            }));
            board.appendChild(svgEl('line', {
              class: 'egd-ontology-time-slice-boundary',
              x1: x,
              y1: y + 20,
              x2: x,
              y2: 806,
              stroke: boundaryColor,
              'stroke-width': '2.4',
              'stroke-opacity': selectedGoal || focusFuture ? '0.34' : '0.40',
              'stroke-dasharray': '16 12',
              'pointer-events': 'none',
            }));
            board.appendChild(svgEl('line', {
              class: 'egd-ontology-time-slice-boundary-halo',
              x1: x + 5,
              y1: y + 20,
              x2: x + 5,
              y2: 806,
              stroke: boundaryColor,
              'stroke-width': '0.9',
              'stroke-opacity': '0.10',
              'stroke-dasharray': '16 12',
              'pointer-events': 'none',
            }));
          });
          const ticks = selectedGoal
            ? [[525, colors.present, 'present'], [1015, colors.future, 'future']]
            : [[226, colors.past, 'past'], [525, colors.present, 'present'], [1015, colors.future, 'future']];
          const tickLabels = { past: '과거', present: '현재', future: '미래' };
          ticks.forEach(([x, color, key]) => {
            const active = key === activePane || (selectedGoal && key === 'future');
            board.appendChild(svgEl('circle', { cx: x, cy: y, r: active ? 9 : 6.5, fill: color, stroke: '#FFFFFF', 'stroke-width': active ? '3' : '2', opacity: selectedGoal ? '0.48' : '1', 'pointer-events': 'none' }));
            drawSimpleLabel(x, y + 30, tickLabels[key] || key, color, active ? 15 : 12, 'middle', active ? '0.84' : '0.42');
          });
        };

        const drawLayerStage = (x, y, w, h, title, color, options = {}) => {
          const opacity = options.opacity ?? '1';
          drawSimpleLabel(x + 34, y + 48, title, color, options.active ? 26 : 22, 'start', opacity);
          const vx = x + 54;
          const vy = y + 78;
          const vw = w - 108;
          const vh = 142;
          board.appendChild(svgEl('rect', { x: vx, y: vy + 20, width: vw, height: vh - 24, rx: 8, fill: 'rgba(255,249,237,0.36)', stroke: colors.virtual, 'stroke-width': options.active ? '2.0' : '1.4', 'stroke-opacity': options.active ? '0.46' : '0.22', 'stroke-dasharray': options.active ? 'none' : '12 10', opacity, 'pointer-events': 'none' }));
          board.appendChild(svgEl('line', { x1: vx + 26, y1: vy + 36, x2: vx + vw - 26, y2: vy + 36, stroke: '#FFFFFF', 'stroke-width': '2', 'stroke-opacity': '0.64', opacity, 'pointer-events': 'none' }));
          const fy = y + h - 162;
          const floorOpacity = options.floorOpacity ?? opacity;
          board.appendChild(svgEl('rect', { x: x + 30, y: fy, width: w - 60, height: 156, rx: 8, fill: 'rgba(198,225,240,0.92)', stroke: colors.physical, 'stroke-width': '2.6', 'stroke-opacity': '0.74', opacity: floorOpacity, 'pointer-events': 'none' }));
          board.appendChild(svgEl('line', { x1: x + 78, y1: fy + 18, x2: x + w - 78, y2: fy + 18, stroke: '#FFFFFF', 'stroke-width': '2.2', 'stroke-opacity': '0.68', opacity: floorOpacity, 'pointer-events': 'none' }));
          const ry = y + 252;
          return {
            virtual: { x: vx, y: vy, w: vw, h: vh },
            relation: { x: x + 64, y: ry, w: w - 128, h: 56 },
            floor: { x: x + 46, y: fy, w: w - 92, h: 140 },
          };
        };

        const drawSameRelationLine = (x1, y1, x2, y2, opacity = '1') => {
          const midY = y1 + (y2 - y1) * 0.56;
          const path = `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`;
          board.appendChild(svgEl('path', { d: path, fill: 'none', stroke: colors.same, 'stroke-width': '2.4', 'stroke-opacity': '0.68', 'stroke-linecap': 'square', 'stroke-linejoin': 'miter', opacity, 'pointer-events': 'none' }));
          [[x1, y1], [x2, y2]].forEach(([cx, cy]) => board.appendChild(svgEl('circle', { cx, cy, r: 4.5, fill: '#FFFFFF', stroke: colors.same, 'stroke-width': '1.9', opacity, 'pointer-events': 'none' })));
        };

        const drawTemporalSocket = (cx, cy, options = {}) => {
          board.appendChild(svgEl('rect', { x: cx - 10, y: cy - 28, width: 20, height: 56, rx: 6, fill: 'rgba(107,73,160,0.10)', stroke: colors.time, 'stroke-width': options.strong ? '2.1' : '1.7', 'stroke-opacity': '0.72', 'pointer-events': 'none' }));
          board.appendChild(svgEl('rect', { x: cx - 3, y: cy - 16, width: 6, height: 32, rx: 2, fill: '#FFFFFF', stroke: colors.time, 'stroke-width': '1.4', 'pointer-events': 'none' }));
        };

        const drawTimeBridge = (x1, y1, x2, y2, options = {}) => {
          const midA = x1 + (x2 - x1) * 0.38;
          const midB = x1 + (x2 - x1) * 0.62;
          const straight = Math.abs(y2 - y1) < 16;
          const path = straight
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} L ${midA} ${y1} L ${midA} ${y2} L ${midB} ${y2} L ${x2} ${y2}`;
          board.appendChild(svgEl('path', { d: path, fill: 'none', stroke: 'rgba(109,63,163,0.10)', 'stroke-width': options.goal ? '8' : '7', 'stroke-linecap': 'square', 'stroke-linejoin': 'miter', 'pointer-events': 'none' }));
          board.appendChild(svgEl('path', { class: options.goal ? 'egd-ontology-guide-goal-bridge' : 'egd-ontology-guide-temporal-corridor', d: path, fill: 'none', stroke: colors.time, 'stroke-width': options.goal ? '3.2' : '2.8', 'stroke-opacity': '0.76', 'stroke-linecap': 'square', 'stroke-linejoin': 'miter', 'pointer-events': 'none' }));
          board.appendChild(svgEl('polygon', { points: `${x2},${y2} ${x2 - 12},${y2 - 6} ${x2 - 12},${y2 + 6}`, fill: colors.time, opacity: '0.88', 'pointer-events': 'none' }));
          const gateXs = options.gateXs || [midA, midB];
          gateXs.forEach((gx, index) => {
            const sideColor = options.gateSideColors?.[index];
            if (sideColor) {
              const sideX = index === 0 ? gx - 12 : gx + 12;
              board.appendChild(svgEl('line', { x1: sideX, y1: y2 - 28, x2: sideX, y2: y2 + 28, stroke: sideColor, 'stroke-width': '2.4', 'stroke-linecap': 'square', opacity: '0.48', 'pointer-events': 'none' }));
            }
            board.appendChild(svgEl('rect', { class: options.goal ? 'egd-ontology-guide-goal-gate' : 'egd-ontology-guide-boundary-gate', x: gx - 8, y: y2 - 28, width: 16, height: 56, rx: 5, fill: 'rgba(109,63,163,0.08)', stroke: colors.time, 'stroke-width': '1.7', 'stroke-opacity': '0.68', 'pointer-events': 'none' }));
          });
          [[x1, y1], [x2, y2]].forEach(([cx, cy]) => board.appendChild(svgEl('circle', { class: options.goal ? 'egd-ontology-guide-goal-endpoint' : '', cx, cy, r: 4.8, fill: '#FFFFFF', stroke: colors.time, 'stroke-width': '1.8', opacity: '0.88', 'pointer-events': 'none' })));
          gateXs.forEach((cx) => board.appendChild(svgEl('rect', { class: options.goal ? 'egd-ontology-guide-goal-gate-port' : '', x: cx - 2.2, y: y2 - 10, width: 4.4, height: 20, rx: 2, fill: '#FFFFFF', stroke: colors.time, 'stroke-width': '1.4', 'pointer-events': 'none' })));
        };

        const drawTemporalBridgeTag = (cx, cy, opacity = '1') => {
          board.appendChild(svgEl('rect', { x: cx - 52, y: cy - 18, width: 104, height: 28, rx: 11, fill: 'rgba(255,255,255,0.96)', stroke: colors.time, 'stroke-width': '1.9', 'stroke-opacity': '0.46', opacity, 'pointer-events': 'none' }));
          [-4, 4].forEach((offset) => board.appendChild(svgEl('line', { x1: cx - 38, y1: cy + offset - 4, x2: cx - 18, y2: cy + offset - 4, stroke: colors.time, 'stroke-width': '2.4', 'stroke-linecap': 'square', opacity, 'pointer-events': 'none' })));
          drawSimpleLabel(cx + 14, cy + 1, '시간 간', colors.time, 11.4, 'middle', opacity);
        };

        const drawSelectedContextFrame = () => {
          const railY = 326;
          board.appendChild(svgEl('line', { x1: 402, y1: railY, x2: 1116, y2: railY, stroke: colors.axis, 'stroke-width': '5.2', 'stroke-linecap': 'square', opacity: '0.34', 'pointer-events': 'none' }));
          board.appendChild(svgEl('polygon', { points: `1116,${railY} 1099,${railY - 8} 1099,${railY + 8}`, fill: colors.axis, opacity: '0.34', 'pointer-events': 'none' }));
          [[526, colors.present, '현재'], [1016, colors.future, '미래']].forEach(([x, color, label]) => {
            board.appendChild(svgEl('circle', { cx: x, cy: railY, r: 7, fill: color, stroke: '#FFFFFF', 'stroke-width': '2.3', opacity: '0.44', 'pointer-events': 'none' }));
            board.appendChild(svgEl('path', { d: `M ${x} ${railY + 13} L ${x} 382`, fill: 'none', stroke: color, 'stroke-width': '3.4', 'stroke-dasharray': '10 8', opacity: '0.30', 'pointer-events': 'none' }));
            drawSimpleLabel(x - 24, 374, label, color, 17, 'middle', '0.42');
          });
          board.appendChild(svgEl('rect', { x: 334, y: 360, width: 332, height: 204, rx: 26, fill: 'rgba(255,255,255,0.20)', stroke: colors.present, 'stroke-width': '2.2', 'stroke-opacity': '0.30', 'pointer-events': 'none' }));
          board.appendChild(svgEl('rect', { x: 834, y: 356, width: 358, height: 210, rx: 26, fill: 'rgba(255,255,255,0.20)', stroke: colors.future, 'stroke-width': '2.2', 'stroke-opacity': '0.32', 'pointer-events': 'none' }));
          board.appendChild(svgEl('rect', { x: 374, y: 384, width: 248, height: 66, rx: 18, fill: 'rgba(255,249,237,0.28)', stroke: colors.virtual, 'stroke-width': '1.8', 'stroke-opacity': '0.24', 'pointer-events': 'none' }));
          board.appendChild(svgEl('rect', { x: 368, y: 452, width: 270, height: 58, rx: 16, fill: 'rgba(236,249,242,0.34)', stroke: colors.same, 'stroke-width': '1.7', 'stroke-opacity': '0.24', 'pointer-events': 'none' }));
          board.appendChild(svgEl('polygon', { points: '372,514 636,514 652,552 356,552', fill: 'rgba(198,225,240,0.28)', stroke: colors.physical, 'stroke-width': '1.9', 'stroke-opacity': '0.26', 'pointer-events': 'none' }));
          board.appendChild(svgEl('rect', { x: 870, y: 392, width: 278, height: 78, rx: 18, fill: 'rgba(255,249,237,0.34)', stroke: colors.virtual, 'stroke-width': '1.8', 'stroke-opacity': '0.28', 'pointer-events': 'none' }));
          board.appendChild(svgEl('polygon', { points: '878,492 1142,492 1160,548 858,548', fill: 'rgba(198,225,240,0.20)', stroke: colors.physical, 'stroke-width': '1.8', 'stroke-opacity': '0.18', 'pointer-events': 'none' }));
        };

        const drawTimeDrop = (x, railY, targetY, color, opacity = '1') => {
          board.appendChild(svgEl('line', { x1: x, y1: railY + 12, x2: x, y2: railY + 78, stroke: color, 'stroke-width': '1.9', 'stroke-linecap': 'square', 'stroke-dasharray': '10 10', opacity: String(Number(opacity) * 0.78), 'pointer-events': 'none' }));
          board.appendChild(svgEl('circle', { cx: x, cy: railY + 84, r: 8, fill: '#FFFFFF', stroke: color, 'stroke-width': '2.4', opacity, 'pointer-events': 'none' }));
        };

        const drawDesktopTree = (x, y, scale = 1, opacity = '1') => {
          const sw = (v) => v * scale;
          const node = (nx, ny, w, h, label, strong = false) => {
            board.appendChild(svgEl('rect', { x: x + sw(nx), y: y + sw(ny), width: sw(w), height: sw(h), rx: 5, fill: '#FFFFFF', stroke: colors.physical, 'stroke-width': strong ? '2.7' : '2.1', 'stroke-opacity': '0.90', opacity, 'pointer-events': 'none' }));
            drawSimpleLabel(x + sw(nx + w / 2), y + sw(ny + h / 2 + 5), label, '#111111', 13.8 * scale, 'middle');
          };
          node(82, 0, 184, 38, '데스크톱 조립체', true);
          node(110, 58, 128, 36, '터미널', true);
          board.appendChild(svgEl('path', { d: `M ${x + sw(174)} ${y + sw(38)} L ${x + sw(174)} ${y + sw(58)} M ${x + sw(174)} ${y + sw(94)} L ${x + sw(174)} ${y + sw(122)} L ${x + sw(56)} ${y + sw(122)} L ${x + sw(56)} ${y + sw(140)} M ${x + sw(174)} ${y + sw(122)} L ${x + sw(174)} ${y + sw(140)} M ${x + sw(174)} ${y + sw(122)} L ${x + sw(292)} ${y + sw(122)} L ${x + sw(292)} ${y + sw(140)}`, fill: 'none', stroke: '#FFFFFF', 'stroke-width': sw(5.2), 'stroke-linecap': 'square', 'stroke-linejoin': 'miter', opacity, 'pointer-events': 'none' }));
          board.appendChild(svgEl('path', { d: `M ${x + sw(174)} ${y + sw(38)} L ${x + sw(174)} ${y + sw(58)} M ${x + sw(174)} ${y + sw(94)} L ${x + sw(174)} ${y + sw(122)} L ${x + sw(56)} ${y + sw(122)} L ${x + sw(56)} ${y + sw(140)} M ${x + sw(174)} ${y + sw(122)} L ${x + sw(174)} ${y + sw(140)} M ${x + sw(174)} ${y + sw(122)} L ${x + sw(292)} ${y + sw(122)} L ${x + sw(292)} ${y + sw(140)}`, fill: 'none', stroke: colors.physical, 'stroke-width': sw(2.8), 'stroke-linecap': 'square', 'stroke-linejoin': 'miter', opacity, 'pointer-events': 'none' }));
          node(10, 140, 92, 36, 'CPU');
          node(128, 140, 92, 36, 'RAM');
          node(246, 140, 92, 36, '디스크');
        };

        const drawSameLens = () => {
          drawTimeDrop(525, 184, 302, colors.present, '0.82');
          const stage = drawLayerStage(278, 302, 520, 470, '현재', colors.present, { active: true });
          drawSimpleNode(stage.virtual.x + 170, stage.virtual.y + 56, 238, 58, '채팅 세션', colors.virtual, { badge: 'egdesk', namespaceLabel: 'egdesk', strong: true, fill: 'rgba(255,255,255,0.98)' });
          drawSameRelationLine(stage.virtual.x + 289, stage.virtual.y + 114, stage.floor.x + stage.floor.w / 2, stage.floor.y + 24);
          drawDesktopTree(stage.floor.x + 30, stage.floor.y + 6, 0.84);
        };

        const drawTimeLens = () => {
          if (selectedGoal) {
            drawTimeDrop(525, 184, 338, colors.present, '0.32');
            drawTimeDrop(1015, 184, 292, colors.future, '0.56');
            const source = drawLayerStage(294, 338, 360, 420, '현재', colors.present, { opacity: '0.54', floorOpacity: '0.44' });
            const target = drawLayerStage(732, 292, 520, 492, '미래', colors.future, { active: true, opacity: '0.68', floorOpacity: '0.42' });
            const sourceNode = { x: source.virtual.x + 84, y: target.virtual.y + 58, w: 154, h: 54 };
            const targetNode = { x: target.virtual.x + 166, y: target.virtual.y + 58, w: 184, h: 58 };
            drawDesktopTree(source.floor.x + 14, source.floor.y + 8, 0.62, '0.54');
            drawSimpleNode(sourceNode.x, sourceNode.y, sourceNode.w, sourceNode.h, '채팅 세션', colors.virtual, { badge: 'egdesk', namespaceLabel: 'egdesk', opacity: '0.38', fill: 'rgba(255,255,255,0.86)' });
            drawSimpleNode(targetNode.x, targetNode.y, targetNode.w, targetNode.h, '목표', colors.virtual, { badge: 'egdesk', namespaceLabel: 'egdesk', strong: true, fill: 'rgba(255,255,255,0.98)' });
            drawTimeBridge(sourceNode.x + sourceNode.w + 12, sourceNode.y + sourceNode.h / 2, targetNode.x, targetNode.y + targetNode.h / 2, { goal: true, gateXs: [688, target.virtual.x + 18], gateSideColors: [colors.present, colors.future] });
            return;
          }
          if (focusFuture) {
            drawTimeDrop(525, 184, 338, colors.present, '0.38');
            drawTimeDrop(1015, 184, 292, colors.future, '0.86');
            const source = drawLayerStage(294, 338, 360, 420, '현재', colors.present, { opacity: '0.74', floorOpacity: '0.34' });
            const target = drawLayerStage(732, 292, 520, 492, '미래', colors.future, { active: true, floorOpacity: '0.38' });
            const sourceNode = { x: source.virtual.x + 84, y: target.virtual.y + 58, w: 154, h: 54 };
            const targetNode = { x: target.virtual.x + 166, y: target.virtual.y + 58, w: 184, h: 58 };
            drawDesktopTree(source.floor.x + 14, source.floor.y + 8, 0.62, '0.48');
            drawSimpleNode(sourceNode.x, sourceNode.y, sourceNode.w, sourceNode.h, '채팅 세션', colors.virtual, { badge: 'egdesk', namespaceLabel: 'egdesk', opacity: '0.44', fill: 'rgba(255,255,255,0.88)' });
            drawSimpleNode(targetNode.x, targetNode.y, targetNode.w, targetNode.h, '목표', colors.virtual, { badge: 'egdesk', namespaceLabel: 'egdesk', strong: true, fill: 'rgba(255,255,255,0.98)' });
            drawTimeBridge(sourceNode.x + sourceNode.w + 12, sourceNode.y + sourceNode.h / 2, targetNode.x, targetNode.y + targetNode.h / 2, { gateXs: [688, target.virtual.x + 18], gateSideColors: [colors.present, colors.future] });
            return;
          }
          const left = drawLayerStage(310, 302, 430, 470, '현재', colors.present, { active: !focusPast, floorOpacity: '0.26' });
          const right = drawLayerStage(800, 302, 430, 470, '미래', colors.future, { active: focusFuture, floorOpacity: '0.24' });
          drawSimpleNode(left.virtual.x + 148, left.virtual.y + 56, 170, 52, '채팅 세션', colors.virtual, { badge: 'egdesk', namespaceLabel: 'egdesk', opacity: focusPast ? '0.38' : '0.16', fill: 'rgba(255,255,255,0.98)' });
          drawSameRelationLine(left.virtual.x + 233, left.virtual.y + 108, left.floor.x + left.floor.w / 2, left.floor.y + 18, focusPast ? '0.22' : '0.56');
          drawSimpleNode(right.virtual.x + 110, right.virtual.y + 56, 160, 54, '목표', colors.virtual, { badge: 'egdesk', namespaceLabel: 'egdesk', strong: focusFuture, opacity: focusPast ? '0.18' : '1', fill: 'rgba(255,255,255,0.98)' });
        };

        drawTimeRail();
        if (timeLens) drawTimeLens();
        else drawSameLens();
        noviceOverlayGroup.appendChild(board);
      };
      drawLayerGrammarBoardV2();
    };

    const renderProjection = (facet, point, size = { width: 190, height: 44 }) => {
      const projection = projectionByFacet.get(facet);
      if (!projection) return;
      const axis = ontologyAxisForFacet(facet);
      renderOntologySvgNode(paneGroup, projection, point, {
        mode: 'focus',
        color: ontologyAxisColor(axis),
        fill: 'rgba(255, 255, 255, 0.95)',
        extraClass: `egd-ontology-node-projection egd-ontology-axis-projection egd-ontology-binding-${facet}`,
        selected: projection.id === selected?.id,
        label: ontologyProjectionLocalLabel(projection),
        meta: '',
        size,
        labelMax: 24,
        metaMax: 22,
        onclick: (ev) => {
          ev.stopPropagation();
          onSelect(projection.id);
        },
      });
    };

    const renderPaneInventory = (phase) => {
      const bounds = paneBounds[phase] || paneBounds.present;
      const activeDepth = ontologyNormalizeDepth(localState.activeDepth, ontologyDefaultDepthForPane(phase, selected));
      const phaseActive = !usePaneMap || phase === activePane;
      const phaseOpacity = phaseActive ? 1 : 0.28;
      const nodes = ontologyPaneInventoryNodes(graph, phase, selected);
      const guideOrder = {
        past: [
          'entity.chat_memory',
          'projection.chat_memory.storage.trace_file',
        ],
        present: [
          'desktop',
          'terminal',
          'cpu',
          'ram',
          'disk',
          'projection.llm_chat_session.storage.session_file',
          'projection.llm_chat_session.intent.context_binding',
          'projection.llm_chat_session.action.message_send',
          'entity.llm_chat_session',
        ],
        future: [
          'output.structured',
          'goal',
          'plan',
        ],
        multiverse: ['alternate.plan', 'candidate.future'],
      };
      const guideIds = guideOrder[phase] || [];
      const supplementalNodes = focusTarget === 'pane'
        ? []
        : nodes.filter((node) => !guideIds.includes(node.id) && narrativeIds.has(node.id));
      const visibleNodes = [
        ...guideIds.map((id) => nodes.find((node) => node.id === id)).filter(Boolean),
        ...supplementalNodes,
      ].filter((node, index, list) => list.findIndex((candidate) => candidate.id === node.id) === index);
      const tileWidth = phase === 'present' ? 118 : phase === 'multiverse' ? 90 : 104;
      const tileHeight = phase === 'multiverse' ? 40 : 52;
      const laneInsetX = phase === 'present' ? 38 : 28;
      const clampLaneX = (x, width = tileWidth) => {
        const min = bounds.x + laneInsetX + width / 2;
        const max = bounds.x + bounds.w - laneInsetX - width / 2;
        if (max < min) return bounds.x + bounds.w / 2;
        return Math.max(min, Math.min(max, x));
      };
      const laneXAt = (count, index, preferredCenter, preferredGap, width = tileWidth) => {
        const safeLeft = bounds.x + laneInsetX + width / 2;
        const safeRight = bounds.x + bounds.w - laneInsetX - width / 2;
        if (count <= 1 || safeRight <= safeLeft) return clampLaneX(preferredCenter, width);
        const maxGap = Math.max(0, (safeRight - safeLeft) / (count - 1));
        const gap = Math.min(preferredGap, maxGap);
        const preferredStart = preferredCenter - ((count - 1) * gap) / 2;
        const start = Math.max(safeLeft, Math.min(safeRight - (count - 1) * gap, preferredStart));
        return start + index * gap;
      };
      const tallActivePane = phaseActive && bounds.h > 430;
      const laneY = tallActivePane
        ? {
          virtual: bounds.y + 124,
          information: bounds.y + 264,
          physical: bounds.y + 422,
        }
        : phase === 'multiverse'
          ? {
            virtual: bounds.y + 42,
            information: bounds.y + 72,
            physical: bounds.y + 100,
          }
          : {
            virtual: bounds.y + 86,
            information: bounds.y + 190,
            physical: bounds.y + 300,
          };
      const laneHeightByDepth = tallActivePane
        ? { virtual: 126, information: 98, physical: 194 }
        : phase === 'multiverse'
          ? { virtual: 44, information: 32, physical: 32 }
          : { virtual: 54, information: 54, physical: 54 };
      const grouped = new Map(ONTOLOGY_DEPTH_ORDER.map((depth) => [depth, []]));
      visibleNodes.forEach((node) => grouped.get(ontologyDepthForNode(node)).push(node));

      if (phase === 'present') {
        paneGroup.appendChild(svgEl('rect', {
          class: 'egd-ontology-physical-base-plate',
          x: bounds.x + 34,
          y: bounds.y + 88,
          width: bounds.w - 68,
          height: bounds.h - 118,
          rx: 20,
          fill: 'rgba(45, 90, 123, 0.075)',
          stroke: 'rgba(45, 90, 123, 0.30)',
          'stroke-width': '1.8',
          opacity: phaseOpacity,
          'pointer-events': 'none',
        }));
      }

      ONTOLOGY_DEPTH_ORDER.forEach((depth) => {
        const laneHeight = laneHeightByDepth[depth] || 70;
        const y = laneY[depth] - laneHeight / 2;
        const highlighted = activeDepth === depth;
        const insetX = phase === 'present' ? 38 : 28;
        if (phase === 'present' && focusTarget !== 'pane') {
          paneGroup.appendChild(svgEl('rect', {
            class: `egd-ontology-present-subpane egd-ontology-present-subpane-${depth}`,
            x: bounds.x + insetX - 8,
            y: y - 8,
            width: bounds.w - (insetX - 8) * 2,
            height: laneHeight + 16,
            rx: depth === 'information' ? 12 : 20,
            fill: depth === 'physical'
              ? 'rgba(45, 90, 123, 0.105)'
              : depth === 'information'
                ? 'rgba(63, 123, 97, 0.070)'
                : 'rgba(255, 249, 237, 0.42)',
            stroke: ontologyDepthColor(depth),
            'stroke-width': highlighted ? (depth === 'physical' ? '1.9' : '1.45') : '0.95',
            'stroke-opacity': highlighted ? (depth === 'physical' ? '0.42' : '0.34') : '0.22',
            opacity: phaseOpacity,
            'pointer-events': 'none',
          }));
        }
        paneGroup.appendChild(svgEl('rect', {
          class: `egd-ontology-inventory-depth-band egd-ontology-inventory-depth-${depth}`,
            x: bounds.x + insetX,
            y,
            width: bounds.w - insetX * 2,
            height: laneHeight,
            rx: 16,
            fill: ontologyDepthColor(depth),
            opacity: phaseActive ? (highlighted ? (phase === 'present' ? '0.12' : '0.060') : '0.044') : '0.018',
            stroke: ontologyDepthColor(depth),
            'stroke-width': highlighted ? (phase === 'present' ? '1.7' : '1.2') : '0.8',
            'stroke-opacity': phaseActive ? (highlighted ? (phase === 'present' ? '0.34' : '0.16') : '0.14') : '0.04',
            'pointer-events': 'none',
          }));
        paneGroup.appendChild(svgEl('rect', {
          class: `egd-ontology-depth-hit egd-ontology-depth-hit-${phase} egd-ontology-depth-hit-${depth}`,
          x: bounds.x + insetX,
          y,
          width: bounds.w - insetX * 2,
          height: laneHeight,
          rx: 16,
          fill: 'transparent',
          onclick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onDepthSelect?.(depth, phase);
          },
        }));
      });
      if (!usePaneMap && phase !== 'multiverse') {
        const railX = bounds.x + 44;
        paneGroup.appendChild(svgEl('line', {
          class: 'egd-ontology-depth-rail',
          x1: railX,
          y1: laneY.physical,
          x2: railX,
          y2: laneY.virtual,
          stroke: 'rgba(92, 97, 105, 0.18)',
          'stroke-width': '2',
          'stroke-linecap': 'round',
          opacity: phaseOpacity,
          'pointer-events': 'none',
        }));
        ONTOLOGY_DEPTH_ORDER.forEach((depth) => {
          const highlighted = activeDepth === depth;
          paneGroup.appendChild(svgEl('circle', {
            class: `egd-ontology-depth-rail-dot egd-ontology-depth-rail-dot-${depth}`,
            cx: railX,
            cy: laneY[depth],
            r: highlighted ? 6 : 4,
          fill: ontologyDepthColor(depth),
          opacity: phaseActive ? (highlighted ? '0.82' : '0.28') : '0.14',
            stroke: 'rgba(255, 255, 255, 0.92)',
            'stroke-width': '1.4',
            'pointer-events': 'none',
          }));
        });
      }

      const placedItems = [];
      const topologyTreeIds = new Set(['desktop', 'terminal', 'cpu', 'ram', 'disk']);
      ONTOLOGY_DEPTH_ORDER.forEach((depth) => {
        const group = grouped.get(depth).filter((node) => !(phase === 'present' && topologyTreeIds.has(node.id)));
        if (phase === 'present' && depth === 'virtual') {
          const productIds = ['egdesk.desk', 'egdesk.agenda', 'egdesk.card'];
          const productNodes = productIds
            .map((id) => group.find((node) => node.id === id))
            .filter(Boolean);
          const entityNodes = group.filter((node) => !productIds.includes(node.id)).slice(0, 2);
          const entityGap = 136;
          const entityCenter = bounds.x + bounds.w * 0.48;
          const entityStart = entityCenter - ((entityNodes.length - 1) * entityGap) / 2;
          entityNodes.forEach((node, index) => {
            placedItems.push({
              node,
              depth,
              point: { x: entityStart + index * entityGap, y: laneY.virtual - 30 },
            });
          });
          const productGap = 122;
          const productCenter = bounds.x + bounds.w * 0.62;
          const productStart = productCenter - ((productNodes.length - 1) * productGap) / 2;
          productNodes.forEach((node, index) => {
            placedItems.push({
              node,
              depth,
              point: { x: productStart + index * productGap, y: laneY.virtual + 30 },
              productChain: true,
            });
          });
          return;
        }
        const maxPerLane = phase === 'present'
          ? (depth === 'physical' ? 2 : 3)
          : phase === 'multiverse'
            ? 2
            : phase === 'future' && depth === 'virtual'
              ? 3
              : 2;
        const laneNodes = group.slice(0, maxPerLane);
        const gapX = phase === 'present' ? 132 : phase === 'multiverse' ? 104 : 96;
        const centerX = phase === 'present' ? bounds.x + bounds.w * (depth === 'physical' ? 0.70 : 0.62) : bounds.x + bounds.w / 2;
        laneNodes.forEach((node, index) => {
          placedItems.push({
            node,
            depth,
            point: { x: laneXAt(laneNodes.length, index, centerX, gapX), y: laneY[depth] },
          });
        });
      });
      if (phase === 'present') {
        const treeCenterX = bounds.x + bounds.w * 0.44;
        const topologyPoints = {
          desktop: { x: treeCenterX, y: laneY.information - 50 },
          terminal: { x: treeCenterX, y: laneY.information + 16 },
          cpu: { x: treeCenterX - 132, y: laneY.physical + 63 },
          ram: { x: treeCenterX, y: laneY.physical + 63 },
          disk: { x: treeCenterX + 132, y: laneY.physical + 63 },
        };
        for (const id of ['desktop', 'terminal', 'cpu', 'ram', 'disk']) {
          const node = visibleNodes.find((candidate) => candidate.id === id);
          if (!node) continue;
          placedItems.push({
            node,
            depth: ontologyDepthForNode(node),
            point: topologyPoints[id],
            compact: true,
          });
        }
      }
      const placedById = new Map(placedItems.map((item) => [item.node.id, item]));
      placedItems.forEach((item) => {
        item.size = {
          width: item.compact ? 96 : phase === 'multiverse' ? 98 : tileWidth,
          height: item.compact ? 50 : phase === 'multiverse' ? 40 : tileHeight,
        };
        item.point.x = clampLaneX(item.point.x, item.size.width);
      });
      const productChainIds = new Set(['egdesk.desk', 'egdesk.agenda', 'egdesk.card']);
      const renderedTreeEdgeIds = new Set();
      const isRelatedItem = (item) => {
        const itemCanonicalId = ontologyCanonicalIdForNode(graph, item?.node);
        return narrativeIds.has(item?.node?.id)
          || selectedRelatedIds.has(item?.node?.id)
          || (itemCanonicalId && (narrativeIds.has(itemCanonicalId) || selectedRelatedIds.has(itemCanonicalId)));
      };
      const isNarrativeEdge = (edge) => narrativeIds.has(edge.source) && narrativeIds.has(edge.target);

      if (phase === 'present') {
        const productChain = ['egdesk.desk', 'egdesk.agenda', 'egdesk.card']
          .map((id) => placedById.get(id))
          .filter(Boolean);
        if (productChain.length > 1) {
          productChain.slice(0, -1).forEach((item, index) => {
            const next = productChain[index + 1];
            const itemSize = item.size || { width: tileWidth, height: tileHeight };
            const nextSize = next.size || { width: tileWidth, height: tileHeight };
            const y = item.point.y + tileHeight / 2 + 7;
            const startX = item.point.x + itemSize.width / 2 - 8;
            const endX = next.point.x - nextSize.width / 2 + 8;
            paneGroup.appendChild(svgEl('path', {
              class: 'egd-ontology-product-chain-connector',
              d: `M ${startX} ${y} L ${endX} ${y}`,
              fill: 'none',
              stroke: 'rgba(138, 107, 46, 0.16)',
              'stroke-width': '1.1',
              'stroke-linecap': 'square',
              'pointer-events': 'none',
            }));
          });
        }
      }

      if (phase === 'present') {
        const drawAssemblyPath = (sourceId, targetId, edgeRelation, options = {}) => {
          const from = placedById.get(sourceId);
          const to = placedById.get(targetId);
          if (!from || !to) return;
          const related = isRelatedItem(from) || isRelatedItem(to);
          const fromSize = from.size || { width: 76, height: 44 };
          const toSize = to.size || { width: 76, height: 44 };
          const start = { x: from.point.x, y: from.point.y + fromSize.height / 2 - 3 };
          const end = { x: to.point.x, y: to.point.y - toSize.height / 2 + 3 };
          const busY = options.busY || (start.y + end.y) / 2;
          const d = sourceId === 'terminal' && ['cpu', 'ram', 'disk'].includes(targetId)
            ? `M ${start.x} ${start.y} L ${start.x} ${busY} L ${end.x} ${busY} L ${end.x} ${end.y}`
            : `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
          paneGroup.appendChild(svgEl('path', {
            class: `egd-ontology-depth-connector egd-ontology-assembly-tree-connector egd-ontology-assembly-tree-${edgeRelation}`,
            d,
            fill: 'none',
            stroke: edgeRelation === 'contains' ? 'rgba(45, 90, 123, 0.48)' : 'rgba(45, 90, 123, 0.36)',
            'stroke-width': related ? '1.9' : '1.35',
            'stroke-linecap': 'square',
            'stroke-linejoin': 'miter',
            opacity: phaseActive ? (related ? '0.92' : '0.58') : '0.16',
            'pointer-events': 'none',
          }));
          [start, end].forEach((point, portIndex) => {
            paneGroup.appendChild(svgEl('circle', {
              class: `egd-ontology-depth-connector-port egd-ontology-assembly-tree-port-${portIndex ? to.depth : from.depth}`,
              cx: point.x,
              cy: point.y,
              r: related ? 4.4 : 3.5,
              fill: ontologyDepthColor(portIndex ? to.depth : from.depth),
              opacity: phaseActive ? (related ? '0.78' : '0.42') : '0.14',
              stroke: 'rgba(255, 255, 255, 0.92)',
              'stroke-width': '1.1',
              'pointer-events': 'none',
            }));
          });
        };
        const relationFor = (sourceId, targetId) => (graph?.edges || []).find((edge) => (
          edge.source === sourceId
          && edge.target === targetId
          && (edge.relation === 'contains' || edge.relation === 'uses')
        ));
        [
          ['desktop', 'terminal', null],
          ['terminal', 'cpu', laneY.physical + 48],
          ['terminal', 'ram', laneY.physical + 48],
          ['terminal', 'disk', laneY.physical + 48],
        ].forEach(([sourceId, targetId, busY]) => {
          const edge = relationFor(sourceId, targetId);
          if (!edge) return;
          renderedTreeEdgeIds.add(edge.id);
          drawAssemblyPath(sourceId, targetId, edge.relation, busY ? { busY } : {});
        });
      }

      const treeEdges = (graph?.edges || [])
        .filter((edge) => (
          !renderedTreeEdgeIds.has(edge.id)
          && (
          placedById.has(edge.source)
          && placedById.has(edge.target)
          && topologyTreeIds.has(edge.source)
          && topologyTreeIds.has(edge.target)
          && (
            edge.relation === 'contains'
            || edge.relation === 'uses'
          )
          )
        ))
        .slice(0, 6);
      treeEdges.forEach((edge, index) => {
        const from = placedById.get(edge.source);
        const to = placedById.get(edge.target);
        const fromSize = from.size || { width: tileWidth, height: tileHeight };
        const toSize = to.size || { width: tileWidth, height: tileHeight };
        const signY = Math.sign(to.point.y - from.point.y) || 1;
        const start = { x: from.point.x, y: from.point.y + signY * (fromSize.height / 2 - 5) };
        const end = { x: to.point.x, y: to.point.y - signY * (toSize.height / 2 - 5) };
        const midY = (start.y + end.y) / 2 + (index % 2 ? 6 : -6);
        paneGroup.appendChild(svgEl('path', {
          class: `egd-ontology-depth-connector egd-ontology-inventory-tree-connector egd-ontology-inventory-tree-${edge.relation}`,
          d: `M ${start.x} ${start.y} L ${start.x} ${midY} L ${end.x} ${midY} L ${end.x} ${end.y}`,
          fill: 'none',
          stroke: edge.relation === 'contains' ? 'rgba(45, 90, 123, 0.32)' : 'rgba(92, 97, 105, 0.26)',
          'stroke-width': edge.relation === 'contains' ? '1.6' : '1.25',
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          opacity: phaseOpacity,
          'pointer-events': 'none',
        }));
        [start, end].forEach((point, portIndex) => {
          paneGroup.appendChild(svgEl('circle', {
            class: `egd-ontology-depth-connector-port egd-ontology-depth-connector-port-${portIndex ? to.depth : from.depth}`,
            cx: point.x,
            cy: point.y,
            r: 3.8,
            fill: ontologyDepthColor(portIndex ? to.depth : from.depth),
            opacity: phaseActive ? '0.54' : '0.18',
            stroke: 'rgba(255, 255, 255, 0.9)',
            'stroke-width': '1',
            'pointer-events': 'none',
          }));
        });
      });

      const relationPriority = new Set(['represented_by', 'binds', 'uses']);
      const showBrowseObjectRelations = focusTarget !== 'pane'
        || (phaseActive && selected?.id && ontologyPhaseForNode(selected) === phase);
      const relationEdges = (graph?.edges || [])
        .filter((edge) => (
          showBrowseObjectRelations
          &&
          relationPriority.has(edge.relation)
          && placedById.has(edge.source)
          && placedById.has(edge.target)
          && !productChainIds.has(edge.source)
          && !productChainIds.has(edge.target)
          && (isNarrativeEdge(edge) || edge.source === selected?.id || edge.target === selected?.id)
          && (focusTarget !== 'pane' || edge.source === selected?.id || edge.target === selected?.id)
          && (phase !== 'present' || edge.kind === 'relation_map' || edge.source === selected?.id || edge.target === selected?.id)
          && !(edge.relation === 'uses' && topologyTreeIds.has(edge.source) && topologyTreeIds.has(edge.target))
        ))
        .sort((a, b) => {
          const aSelected = a.source === selected?.id || a.target === selected?.id ? 0 : 1;
          const bSelected = b.source === selected?.id || b.target === selected?.id ? 0 : 1;
          return aSelected - bSelected || String(a.id || '').localeCompare(String(b.id || ''));
        })
        .slice(0, focusTarget === 'pane' ? 2 : phase === 'present' ? 5 : 6);
      relationEdges.forEach((edge, index) => {
        const from = placedById.get(edge.source);
        const to = placedById.get(edge.target);
        const related = isNarrativeEdge(edge) || selectedRelatedIds.has(edge.source) || selectedRelatedIds.has(edge.target);
        const sameDepth = from.depth === to.depth;
        const fromSize = from.size || { width: tileWidth, height: tileHeight };
        const toSize = to.size || { width: tileWidth, height: tileHeight };
        const stroke = edge.relation === 'binds'
          ? 'rgba(63, 123, 97, 0.36)'
          : edge.relation === 'represented_by'
            ? 'rgba(138, 107, 46, 0.34)'
            : 'rgba(92, 97, 105, 0.26)';
        const signY = Math.sign(to.point.y - from.point.y) || 1;
        const signX = Math.sign(to.point.x - from.point.x) || 1;
        const start = sameDepth
          ? { x: from.point.x + signX * (fromSize.width / 2 - 4), y: from.point.y }
          : { x: from.point.x, y: from.point.y + signY * (fromSize.height / 2 - 4) };
        const end = sameDepth
          ? { x: to.point.x - signX * (toSize.width / 2 - 4), y: to.point.y }
          : { x: to.point.x, y: to.point.y - signY * (toSize.height / 2 - 4) };
        const midY = (start.y + end.y) / 2;
        const midX = (start.x + end.x) / 2;
        const busY = sameDepth
          ? start.y + (from.depth === 'virtual' ? 36 + index * 2 : -36 - index * 2)
          : midY + (index % 2 ? 8 : -8);
        const d = sameDepth
          ? `M ${start.x} ${start.y} L ${start.x} ${busY} L ${end.x} ${busY} L ${end.x} ${end.y}`
          : `M ${start.x} ${start.y} L ${start.x} ${busY} L ${end.x} ${busY} L ${end.x} ${end.y}`;
        paneGroup.appendChild(svgEl('path', {
          class: `egd-ontology-inventory-relation egd-ontology-clickable-relation egd-ontology-inventory-relation-${edge.relation}`,
          d,
          fill: 'none',
          stroke,
          'stroke-width': focusTarget === 'pane'
            ? (related ? '1.05' : '0.7')
            : related ? (edge.relation === 'binds' ? '1.45' : '1.25') : (edge.relation === 'binds' ? '0.95' : '0.8'),
          'stroke-dasharray': edge.relation === 'represented_by' ? '5 6' : '3 5',
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          opacity: phaseActive ? (related ? (focusTarget === 'pane' ? '0.52' : '0.82') : '0.12') : '0.07',
          onclick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onRelationSelect?.(edge, phase);
          },
        }));
        paneGroup.appendChild(svgEl('circle', {
          class: 'egd-ontology-inventory-relation-source',
          cx: start.x,
          cy: start.y,
          r: 3.2,
          fill: stroke,
          opacity: phaseActive ? (related ? '0.72' : '0.12') : '0.07',
          'pointer-events': 'none',
        }));
        paneGroup.appendChild(svgEl('polygon', {
          class: 'egd-ontology-inventory-relation-arrow',
          points: sameDepth
            ? `${end.x},${end.y} ${end.x - signX * 8},${end.y - 4} ${end.x - signX * 8},${end.y + 4}`
            : `${end.x},${end.y} ${end.x - 4},${end.y - signY * 8} ${end.x + 4},${end.y - signY * 8}`,
          fill: stroke,
          opacity: phaseActive ? (related ? '0.78' : '0.14') : '0.07',
          'pointer-events': 'none',
        }));
      });

      placedItems.forEach((item) => {
        const { node, depth, point, compact } = item;
        const facet = ontologyProjectionFacet(node.id);
        const axis = ontologyAxisForNode(node);
        const highlighted = activeDepth === depth;
        const related = isRelatedItem(item);
        const nodeSize = item.size || { width: compact ? 96 : phase === 'multiverse' ? 98 : tileWidth, height: compact ? 50 : phase === 'multiverse' ? 40 : tileHeight };
        const rendered = renderOntologySvgNode(paneGroup, node, point, {
          mode: 'focus',
          color: facet ? ontologyFacetPlaneColor(facet) : ontologyAxisColor(axis),
          fill: node.id?.startsWith('entity.') ? 'rgba(255, 249, 237, 0.96)' : 'rgba(255, 255, 255, 0.94)',
          extraClass: `egd-ontology-pane-inventory-node egd-ontology-depth-${depth}${related ? ' egd-ontology-pane-inventory-node-related' : ' egd-ontology-pane-inventory-node-unrelated'}${highlighted ? '' : ' egd-ontology-depth-muted'}`,
          selected: node.id === selected?.id,
          label: ontologyDisplayLabel(node, 'focus').replace(/^[^·]+·\s*/, ''),
          meta: '',
          size: nodeSize,
          labelMax: compact ? 12 : phase === 'present' ? 18 : phase === 'multiverse' ? 12 : 20,
          metaMax: compact ? 10 : phase === 'present' ? 18 : phase === 'multiverse' ? 12 : 20,
          layerBadge: ontologyObjectLayerBadge(node),
          showPorts: true,
          onclick: (ev) => {
            ev.stopPropagation();
            onSelect(node.id);
          },
        });
        rendered.dataset.phase = phase;
        rendered.dataset.depth = depth;
        if (!phaseActive) rendered.setAttribute('opacity', related ? '0.26' : '0.10');
        else if (!highlighted) rendered.setAttribute('opacity', related ? '0.72' : '0.14');
        else if (!related) rendered.setAttribute('opacity', '0.30');
      });

      if (nodes.length > placedItems.length && focusTarget !== 'pane') {
        const x = phase === 'present' ? bounds.x + bounds.w - 74 : bounds.x + bounds.w / 2;
        const y = bounds.y + bounds.h - 38;
        paneGroup.appendChild(svgEl('text', {
          class: 'egd-ontology-pane-inventory-more',
          x,
          y,
          fill: 'rgba(92, 97, 105, 0.72)',
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': '10',
          'font-weight': '800',
          'text-anchor': 'middle',
        }, `+${nodes.length - placedItems.length}`));
      }
      return {
        phase,
        bounds,
        placedItems,
        placedById,
      };
    };

    const renderDeckPaneInventory = (phase) => {
      const paneScene = deckScene.panes.get(phase) || deckScene.panes.get('present');
      const bounds = paneScene?.bounds || paneBounds.present;
      const activeDepth = ontologyNormalizeDepth(localState.activeDepth, ontologyDefaultDepthForPane(phase, selected));
      const phaseActive = Boolean(paneScene?.active ?? phase === activePane);
      const phaseOpacity = phaseActive ? 1 : 0.58;
      const nodes = paneScene?.nodes || ontologyPaneInventoryNodes(graph, phase, selected);
      const color = paneScene?.color || phaseColor(phase);
      const geometry = paneScene?.geometry || ontologyCreateDeckGeometry(bounds, phaseActive);
      const presentReferenceSurfaces = phase === 'present'
        ? (deckScene.referenceSurfaces.present || [])
        : [];
      const lowerSurface = presentReferenceSurfaces.find((surface) => surface.id === 'lower-physical');
      const itemGeometry = phase === 'present' && activeDepth === 'physical'
        ? (lowerSurface?.geometry || geometry)
        : geometry;
      const deckPoint = geometry.point;
      const itemDeckPoint = itemGeometry.point;
      const deckPath = geometry.path;
      const deckRectPath = geometry.rectPath;
      const phaseClass = `egd-ontology-deck-pane egd-ontology-deck-pane-${phase}${phaseActive ? ' egd-ontology-deck-pane-active' : ''}`;
      const deckGroup = svgEl('g', { class: phaseClass });
      const drawScaffoldNode = (parent, point, label, options = {}) => {
        const width = options.width || 96;
        const height = options.height || 30;
        const group = svgEl('g', {
          class: `egd-ontology-shape-scaffold-node${options.extraClass ? ` ${options.extraClass}` : ''}`,
          'pointer-events': 'none',
        });
        group.appendChild(svgEl('rect', {
          x: point.x - width / 2,
          y: point.y - height / 2,
          width,
          height,
          rx: 7,
          fill: options.fill || 'rgba(255, 255, 255, 0.60)',
          stroke: options.stroke || 'rgba(92, 97, 105, 0.28)',
          'stroke-width': options.strokeWidth || '1.05',
        }));
        if (options.icon) {
          group.appendChild(svgEl('text', {
            x: point.x - width / 2 + 16,
            y: point.y + 4,
            fill: options.iconFill || options.stroke || 'rgba(92, 97, 105, 0.42)',
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': '12.5',
            'font-weight': '900',
          }, options.icon));
        }
        group.appendChild(svgEl('text', {
          x: point.x + (options.icon ? 8 : 0),
          y: point.y + (options.meta ? -2 : 4),
          fill: options.textFill || 'rgba(37, 44, 51, 0.56)',
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': options.fontSize || '11',
          'font-weight': options.fontWeight || '800',
          'text-anchor': options.icon ? 'start' : 'middle',
        }, label));
        if (options.meta) {
          group.appendChild(svgEl('text', {
            x: point.x + (options.icon ? 8 : 0),
            y: point.y + 12,
            fill: options.metaFill || 'rgba(92, 97, 105, 0.42)',
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': '8.5',
            'font-weight': '700',
            'text-anchor': options.icon ? 'start' : 'middle',
          }, options.meta));
        }
        parent.appendChild(group);
        return group;
      };
      const drawScaffoldPath = (parent, points, options = {}) => {
        if (!points?.length) return null;
        const path = svgEl('path', {
          class: options.className || 'egd-ontology-shape-scaffold-path',
          d: `M ${points.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ')}`,
          fill: 'none',
          stroke: options.stroke || 'rgba(92, 97, 105, 0.24)',
          'stroke-width': options.width || '1.15',
          'stroke-dasharray': options.dash || '6 7',
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          'pointer-events': 'none',
        });
        parent.appendChild(path);
        return path;
      };
      if (phase === 'present' && lowerSurface) {
        const physicalGeometry = lowerSurface.geometry;
        const physicalPoint = physicalGeometry.point;
        const physicalActive = activeDepth === 'physical';
        const physicalGroup = svgEl('g', {
          class: `egd-ontology-physical-pane${physicalActive ? ' egd-ontology-physical-pane-active' : ''}`,
        });
        [
          [deckPoint(0.035, 0.965), physicalPoint(0.055, 0.04)],
          [deckPoint(0.965, 0.965), physicalPoint(0.945, 0.04)],
        ].forEach(([from, to]) => {
          physicalGroup.appendChild(svgEl('path', {
            class: 'egd-ontology-physical-pane-strut',
            d: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
            fill: 'none',
            stroke: 'rgba(45, 90, 123, 0.26)',
            'stroke-width': physicalActive ? '1.6' : '1.1',
            'stroke-dasharray': '8 10',
            'pointer-events': 'none',
          }));
        });
        physicalGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-deck-reference egd-ontology-deck-reference-lower-physical egd-ontology-physical-pane-surface',
          d: physicalGeometry.path(),
          fill: physicalActive ? 'rgba(234, 246, 255, 0.74)' : 'rgba(234, 246, 255, 0.48)',
          stroke: physicalActive ? 'rgba(45, 90, 123, 0.64)' : 'rgba(45, 90, 123, 0.52)',
          'stroke-width': physicalActive ? '2.1' : '1.55',
          'stroke-linejoin': 'miter',
          onclick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onDepthSelect?.('physical', phase);
          },
        }));
        const physicalRim = [
          physicalPoint(0.025, 0.025),
          physicalPoint(0.975, 0.025),
          physicalPoint(0.975, 0.975),
          physicalPoint(0.025, 0.975),
        ];
        physicalGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-physical-pane-rim',
          d: `M ${physicalRim.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ')} Z`,
          fill: 'none',
          stroke: 'rgba(45, 90, 123, 0.30)',
          'stroke-width': '1',
          'stroke-linejoin': 'miter',
          'pointer-events': 'none',
        }));
        for (let row = 0; row < 4; row += 1) {
          for (let column = 0; column < 8; column += 1) {
            const dot = physicalPoint(0.16 + column * 0.10, 0.18 + row * 0.20);
            physicalGroup.appendChild(svgEl('circle', {
              class: 'egd-ontology-physical-pane-dot',
              cx: dot.x,
              cy: dot.y,
              r: physicalActive ? 1.15 : 0.9,
              fill: 'rgba(45, 90, 123, 0.18)',
              'pointer-events': 'none',
            }));
          }
        }
        if (!physicalActive) {
          const desktopAssembly = physicalPoint(0.50, 0.20);
          const terminalSurface = physicalPoint(0.50, 0.42);
          const cpuResource = physicalPoint(0.31, 0.74);
          const ramResource = physicalPoint(0.50, 0.74);
          const diskResource = physicalPoint(0.69, 0.74);
          drawScaffoldPath(physicalGroup, [deckPoint(0.38, 0.90), desktopAssembly, terminalSurface, cpuResource], {
            stroke: 'rgba(45, 90, 123, 0.22)',
            dash: '7 8',
          });
          drawScaffoldPath(physicalGroup, [terminalSurface, ramResource], {
            stroke: 'rgba(45, 90, 123, 0.22)',
            dash: '7 8',
          });
          drawScaffoldPath(physicalGroup, [deckPoint(0.73, 0.82), diskResource], {
            stroke: 'rgba(45, 90, 123, 0.22)',
            dash: '7 8',
          });
          drawScaffoldPath(physicalGroup, [cpuResource, ramResource, diskResource], {
            stroke: 'rgba(45, 90, 123, 0.24)',
            dash: '6 7',
          });
          drawScaffoldNode(physicalGroup, desktopAssembly, '데스크톱', {
            width: 110,
            height: 38,
            meta: 'assembly',
            fill: 'rgba(245, 250, 253, 0.58)',
            stroke: 'rgba(45, 90, 123, 0.30)',
            textFill: 'rgba(45, 74, 96, 0.58)',
          });
          drawScaffoldNode(physicalGroup, terminalSurface, '터미널', {
            width: 110,
            height: 38,
            meta: 'surface',
            fill: 'rgba(245, 250, 253, 0.58)',
            stroke: 'rgba(45, 90, 123, 0.30)',
            textFill: 'rgba(45, 74, 96, 0.58)',
          });
          [
            [cpuResource, 'CPU'],
            [ramResource, 'RAM'],
            [diskResource, '디스크'],
          ].forEach(([point, label]) => {
            drawScaffoldNode(physicalGroup, point, label, {
              width: 106,
              height: 36,
              meta: 'resource',
              fill: 'rgba(245, 250, 253, 0.62)',
              stroke: 'rgba(45, 90, 123, 0.32)',
              textFill: 'rgba(45, 74, 96, 0.58)',
            });
          });
        }
        paneGroup.appendChild(physicalGroup);
      }
      if (phaseActive) {
        const frontLeft = deckPoint(0.00, 0.992);
        const frontRight = deckPoint(1.00, 0.992);
        const lipDrop = 15;
        deckGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-deck-front-lip',
          d: `M ${frontLeft.x.toFixed(1)} ${frontLeft.y.toFixed(1)} L ${frontRight.x.toFixed(1)} ${frontRight.y.toFixed(1)} L ${(frontRight.x + 2).toFixed(1)} ${(frontRight.y + lipDrop).toFixed(1)} L ${(frontLeft.x - 2).toFixed(1)} ${(frontLeft.y + lipDrop).toFixed(1)} Z`,
          fill: 'rgba(194, 188, 174, 0.22)',
          stroke: 'rgba(255, 255, 255, 0.52)',
          'stroke-width': '1.2',
          'pointer-events': 'none',
        }));
      }
      deckGroup.appendChild(svgEl('path', {
        class: 'egd-ontology-deck-surface',
        d: deckPath(),
        fill: phaseActive ? 'rgba(255, 253, 247, 0.965)' : 'rgba(255, 255, 255, 0.58)',
        stroke: phaseActive ? 'rgba(255, 255, 255, 0.94)' : color,
        'stroke-width': phaseActive ? '2.6' : '1.15',
        'stroke-opacity': phaseActive ? '0.96' : '0.28',
        opacity: phaseOpacity,
        'pointer-events': 'none',
      }));
      if (phaseActive) {
        const activeRim = [
          deckPoint(0.018, 0.018),
          deckPoint(0.982, 0.018),
          deckPoint(0.982, 0.985),
          deckPoint(0.018, 0.985),
        ];
        deckGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-deck-glass-rim',
          d: `M ${activeRim.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ')} Z`,
          fill: 'none',
          stroke: 'rgba(216, 207, 192, 0.46)',
          'stroke-width': '1.1',
          'stroke-linejoin': 'miter',
          'pointer-events': 'none',
        }));
      } else if (phase !== 'multiverse') {
        const mutedRim = [
          deckPoint(0.025, 0.025),
          deckPoint(0.975, 0.025),
          deckPoint(0.975, 0.975),
          deckPoint(0.025, 0.975),
        ];
        deckGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-deck-glass-rim egd-ontology-deck-glass-rim-muted',
          d: `M ${mutedRim.map((point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L ')} Z`,
          fill: 'none',
          stroke: 'rgba(138, 126, 113, 0.32)',
          'stroke-width': '0.9',
          'stroke-linejoin': 'miter',
          opacity: '0.62',
          'pointer-events': 'none',
        }));
      }
      if (phaseActive) {
        for (let row = 0; row < 5; row += 1) {
          for (let column = 0; column < 9; column += 1) {
            const dot = deckPoint(0.14 + column * 0.09, 0.15 + row * 0.16);
            deckGroup.appendChild(svgEl('circle', {
              class: 'egd-ontology-deck-surface-dot',
              cx: dot.x,
              cy: dot.y,
              r: 0.85,
              fill: 'rgba(138, 107, 46, 0.10)',
              'pointer-events': 'none',
            }));
          }
        }
      }
      if (!usePaneMap && phase !== 'multiverse') {
        const labelPoint = deckPoint(0.50, phaseActive ? 0.055 : 0.12);
        deckGroup.appendChild(svgEl('text', {
          class: 'egd-ontology-deck-phase-label',
          x: labelPoint.x,
          y: labelPoint.y,
          fill: phase === 'present' ? 'rgba(45, 62, 74, 0.70)' : color,
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': phaseActive ? '13' : '12',
          'font-weight': phaseActive ? '900' : '800',
          'text-anchor': 'middle',
          opacity: phaseActive ? '0.92' : '0.56',
          'pointer-events': 'none',
        }, phaseLabels[phase]));
      }

      const depthHitSpecs = {
        virtual: { u: 0.05, v: 0.05, w: 0.90, h: 0.31 },
        information: { u: 0.05, v: 0.36, w: 0.90, h: 0.23 },
        physical: { u: 0.05, v: 0.59, w: 0.90, h: 0.36 },
      };
      ['physical', 'information', 'virtual'].forEach((depth) => {
        const spec = depthHitSpecs[depth];
        deckGroup.appendChild(svgEl('path', {
          class: `egd-ontology-depth-hit egd-ontology-depth-hit-${phase} egd-ontology-depth-hit-${depth}`,
          d: deckRectPath(spec.u, spec.v, spec.w, spec.h),
          fill: 'transparent',
          onclick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onDepthSelect?.(depth, phase);
          },
        }));
      });

      const referenceGroup = svgEl('g', { class: 'egd-ontology-reference-scaffolds' });
      const drawReferenceNode = (point, label, options = {}) => {
        const width = options.width || 106;
        const height = options.height || 34;
        const opacity = options.opacity ?? (phaseActive ? 0.44 : 0.16);
        const stroke = options.stroke || 'rgba(92, 97, 105, 0.26)';
        const group = svgEl('g', {
          class: `egd-ontology-reference-node${options.extraClass ? ` ${options.extraClass}` : ''}`,
          opacity,
          'pointer-events': 'none',
        });
        group.appendChild(svgEl('rect', {
          x: point.x - width / 2,
          y: point.y - height / 2,
          width,
          height,
          rx: 7,
          fill: options.fill || 'rgba(255, 255, 255, 0.62)',
          stroke,
          'stroke-width': options.strong ? '1.4' : '1',
        }));
        if (options.icon) {
          group.appendChild(svgEl('text', {
            x: point.x - width / 2 + 16,
            y: point.y + 4,
            fill: stroke,
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': '13',
            'font-weight': '900',
          }, options.icon));
        }
        group.appendChild(svgEl('text', {
          x: point.x + (options.icon ? 8 : 0),
          y: point.y + (options.meta ? -2 : 4),
          fill: options.textFill || 'rgba(37, 44, 51, 0.62)',
          'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
          'font-size': options.fontSize || '11',
          'font-weight': options.strong ? '850' : '700',
          'text-anchor': options.icon ? 'start' : 'middle',
        }, label));
        if (options.meta) {
          group.appendChild(svgEl('text', {
            x: point.x + (options.icon ? 8 : 0),
            y: point.y + 12,
            fill: 'rgba(92, 97, 105, 0.46)',
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': '8.5',
            'font-weight': '700',
            'text-anchor': options.icon ? 'start' : 'middle',
          }, options.meta));
        }
        referenceGroup.appendChild(group);
      };
      const drawReferencePath = (points, options = {}) => {
        if (!points?.length) return;
        referenceGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-reference-connector',
          d: `M ${points.map((point) => `${point.x} ${point.y}`).join(' L ')}`,
          fill: 'none',
          stroke: options.stroke || 'rgba(92, 97, 105, 0.24)',
          'stroke-width': options.width || '1.2',
          'stroke-dasharray': options.dash || '5 6',
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          opacity: options.opacity ?? (phaseActive ? '0.38' : '0.12'),
          'pointer-events': 'none',
        }));
      };
      if (referenceGroup.childNodes.length) paneGroup.appendChild(referenceGroup);
      paneGroup.appendChild(deckGroup);
      const contentClipId = `${contentClipRootId}-${phase}-${activeDepth}`;
      paneGroup.appendChild(svgEl('defs', {},
        svgEl('clipPath', { id: contentClipId, clipPathUnits: 'userSpaceOnUse' },
          svgEl('path', { d: itemGeometry.path() }),
        ),
      ));
      const contentGroup = svgEl('g', {
        class: `egd-ontology-pane-content egd-ontology-pane-content-${phase}`,
        data: { phase, depth: activeDepth },
        'clip-path': `url(#${contentClipId})`,
      });
      paneGroup.appendChild(contentGroup);

      const nodeHomePhase = (node) => {
        const id = String(node?.id || '');
        if (id === 'alternate.plan' || id === 'candidate.future') return 'multiverse';
        if (id === 'goal' || id === 'plan' || id === 'task' || id === 'output.structured') return 'future';
        if (id === 'entity.chat_memory' || id.startsWith('projection.chat_memory.') || id === 'projection.llm_chat_session.time.memory_trace') return 'past';
        return 'present';
      };
      const guideOrder = {
        past: [
          'projection.llm_chat_session.time.memory_trace',
          'entity.chat_memory',
          'projection.chat_memory.storage.trace_file',
        ],
        present: [
          'entity.llm_chat_session',
          'projection.llm_chat_session.intent.context_binding',
          'egdesk.agenda',
          'egdesk.card',
          'projection.llm_chat_session.action.message_send',
          'desktop',
          'terminal',
          'cpu',
          'ram',
          'disk',
          'projection.llm_chat_session.storage.session_file',
        ],
        future: [
          'goal',
          'plan',
          'task',
          'output.structured',
        ],
        multiverse: ['alternate.plan', 'candidate.future'],
      };
      const homeNodes = nodes.filter((node) => nodeHomePhase(node) === phase);
      const guidedNodes = (guideOrder[phase] || [])
        .map((id) => homeNodes.find((node) => node.id === id) || ontologyNodeById(graph, id))
        .filter((node) => node && nodeHomePhase(node) === phase);
      const relationEndpointIds = localState.selectedRelation
        ? new Set([localState.selectedRelation.source, localState.selectedRelation.target])
        : new Set();
      const supplementalNodes = focusTarget === 'pane'
        ? []
        : homeNodes.filter((node) => (
          !guidedNodes.some((guided) => guided.id === node.id)
          && (node.id === selected?.id || relationEndpointIds.has(node.id) || narrativeIds.has(node.id))
        ));
      const visibleNodes = [...guidedNodes, ...supplementalNodes]
        .filter((node, index, list) => list.findIndex((candidate) => candidate.id === node.id) === index);
      const depthVisibleNodes = visibleNodes.filter((node) => ontologyDepthForNode(node) === activeDepth);

      const placements = {
        past: {
          'projection.chat_memory.time.past_evidence': { u: 0.36, v: 0.12 },
          'projection.llm_chat_session.time.memory_trace': { u: 0.48, v: 0.30 },
          'entity.chat_memory': { u: 0.58, v: 0.48 },
          'projection.chat_memory.action.file_read': { u: 0.42, v: 0.66 },
          'projection.chat_memory.storage.trace_file': { u: 0.48, v: 0.84 },
        },
        present: {
          'entity.llm_chat_session': { u: 0.24, v: 0.25 },
          'projection.llm_chat_session.intent.context_binding': { u: 0.49, v: 0.39 },
          'egdesk.agenda': { u: 0.67, v: 0.25 },
          'egdesk.card': { u: 0.83, v: 0.38 },
          'projection.llm_chat_session.action.message_send': { u: 0.30, v: 0.53 },
          desktop: { u: 0.38, v: 0.30 },
          terminal: { u: 0.58, v: 0.46 },
          cpu: { u: 0.31, v: 0.76 },
          ram: { u: 0.50, v: 0.76 },
          disk: { u: 0.69, v: 0.76 },
          'projection.llm_chat_session.storage.session_file': { u: 0.78, v: 0.42 },
          'projection.desktop_runtime.topology.hardware_os': { u: 0.26, v: 0.48 },
          'projection.desktop_runtime.space.desktop_plane': { u: 0.27, v: 0.57 },
          'projection.desktop_runtime.action.app_execution': { u: 0.76, v: 0.46 },
          'projection.desktop_runtime.storage.local_disk': { u: 0.90, v: 0.74 },
        },
        future: {
          goal: { u: 0.48, v: 0.22 },
          plan: { u: 0.36, v: 0.46 },
          task: { u: 0.62, v: 0.62 },
          'output.structured': { u: 0.48, v: 0.82 },
        },
        multiverse: {
          'alternate.plan': { u: 0.34, v: 0.42 },
          'candidate.future': { u: 0.66, v: 0.56 },
        },
      };
      const fallbackSlots = {
        virtual: [{ u: 0.28, v: 0.19 }, { u: 0.50, v: 0.24 }, { u: 0.72, v: 0.20 }],
        information: [{ u: 0.28, v: 0.48 }, { u: 0.50, v: 0.48 }, { u: 0.72, v: 0.48 }],
        physical: [{ u: 0.28, v: 0.63 }, { u: 0.50, v: 0.66 }, { u: 0.72, v: 0.63 }],
      };
      const fallbackCounts = { virtual: 0, information: 0, physical: 0 };
      const fallbackPlacement = (depth) => {
        const slots = fallbackSlots[depth] || fallbackSlots.information;
        const index = fallbackCounts[depth] % slots.length;
        fallbackCounts[depth] += 1;
        return slots[index];
      };
      const nodeSizeFor = (node, depth) => {
        const id = node?.id || '';
        if (!phaseActive) return { width: phase === 'multiverse' ? 92 : 104, height: phase === 'multiverse' ? 36 : 40 };
        if (phase === 'past') {
          if (id.startsWith('entity.')) return { width: 120, height: 42 };
          if (id.startsWith('projection.')) return { width: 126, height: 40 };
        }
        if (phase === 'future') {
          if (id === 'goal') return { width: 118, height: 44 };
          if (id === 'plan' || id === 'task') return { width: 96, height: 40 };
          if (id === 'output.structured') return { width: 124, height: 42 };
        }
        if (id.startsWith('projection.desktop_runtime.')) return { width: 124, height: 38 };
        if (['cpu', 'ram', 'disk'].includes(id)) return { width: 116, height: 42 };
        if (id === 'desktop' || id === 'terminal') return { width: 116, height: 42 };
        if (id.startsWith('egdesk.')) return { width: 116, height: 44 };
        if (id.startsWith('entity.')) return { width: depth === 'virtual' ? 142 : 132, height: 46 };
        if (id.startsWith('projection.')) return { width: 146, height: 42 };
        return { width: 122, height: 44 };
      };
      const nodeIconFor = (node) => {
        const id = String(node?.id || '');
        const icons = {
          'entity.llm_chat_session': '▢',
          'entity.chat_memory': '▢',
          'projection.llm_chat_session.intent.context_binding': '∞',
          'projection.llm_chat_session.action.message_send': '↗',
          'projection.llm_chat_session.storage.session_file': '◰',
          'projection.chat_memory.storage.trace_file': '◰',
          desktop: '▭',
          terminal: '>_',
          cpu: '▦',
          ram: '▥',
          disk: '◉',
          goal: '◎',
          plan: '▤',
          task: '☷',
          'output.structured': '◇',
        };
        return icons[id] || (id.startsWith('egdesk.') ? '□' : '');
      };
      const nodeVisualFor = (node, depth) => {
        const visualByDepth = {
          virtual: {
            stroke: '#8A6B2E',
            fill: 'rgba(255, 252, 246, 0.98)',
            iconColor: '#8A6B2E',
            iconBg: 'rgba(138, 107, 46, 0.10)',
            iconBgStroke: 'rgba(138, 107, 46, 0.20)',
            labelFill: '#1A1A1A',
          },
          binding: {
            stroke: '#3F7B61',
            fill: 'rgba(249, 255, 251, 0.98)',
            iconColor: '#3F7B61',
            iconBg: 'rgba(63, 123, 97, 0.10)',
            iconBgStroke: 'rgba(63, 123, 97, 0.20)',
            labelFill: '#1A1A1A',
          },
          physical: {
            stroke: '#326DA8',
            fill: 'rgba(250, 253, 255, 0.98)',
            iconColor: '#326DA8',
            iconBg: 'rgba(50, 109, 168, 0.10)',
            iconBgStroke: 'rgba(50, 109, 168, 0.20)',
            labelFill: '#1A1A1A',
          },
        };
        return visualByDepth[depth] || visualByDepth.virtual;
      };
      // Keep graph labels apart using the same separation model used by Dagre/ELK layouts, then relax collisions D3-force style.
      const layeredLayoutSpacing = {
        nodeNode: phaseActive ? (phase === 'present' ? 18 : 14) : 8,
        nodeNodeBetweenLayers: phaseActive ? (phase === 'present' ? 28 : 22) : 10,
        collisionIterations: 16,
      };
      const collisionPaddingFor = (a, b) => (
        a.depth === b.depth
          ? layeredLayoutSpacing.nodeNode / 2
          : layeredLayoutSpacing.nodeNodeBetweenLayers / 2
      );
      const itemBox = (item, point = item.point, padding = layeredLayoutSpacing.nodeNode / 2) => ({
        left: point.x - item.size.width / 2 - padding,
        right: point.x + item.size.width / 2 + padding,
        top: point.y - item.size.height / 2 - padding,
        bottom: point.y + item.size.height / 2 + padding,
      });
      const boxOverlap = (a, b) => (
        a.left < b.right
        && a.right > b.left
        && a.top < b.bottom
        && a.bottom > b.top
      );
      const resolvePaneCollisions = (items) => {
        const diagonalX = phase === 'past' ? -14 : phase === 'future' ? 16 : 12;
        for (let iteration = 0; iteration < layeredLayoutSpacing.collisionIterations; iteration += 1) {
          let moved = false;
          for (let i = 0; i < items.length; i += 1) {
            for (let j = i + 1; j < items.length; j += 1) {
              const fixed = items[i];
              const moving = items[j];
              const padding = collisionPaddingFor(fixed, moving);
              const fixedBox = itemBox(fixed, fixed.point, padding);
              const movingBox = itemBox(moving, moving.point, padding);
              if (!boxOverlap(fixedBox, movingBox)) continue;
              const overlapY = Math.min(fixedBox.bottom - movingBox.top, movingBox.bottom - fixedBox.top);
              const overlapX = Math.min(fixedBox.right - movingBox.left, movingBox.right - fixedBox.left);
              const yDirection = moving.point.y >= fixed.point.y ? 1 : -1;
              const xDirection = moving.point.x >= fixed.point.x ? 1 : -1;
              const preferred = {
                x: moving.point.x + diagonalX * yDirection,
                y: moving.point.y + yDirection * Math.min(52, Math.max(18, overlapY + 6)),
              };
              let nextPoint = preferred;
              if (boxOverlap(fixedBox, itemBox(moving, nextPoint, padding))) {
                nextPoint = {
                  x: moving.point.x + xDirection * Math.min(72, Math.max(24, overlapX + 8)),
                  y: moving.point.y + yDirection * Math.min(34, Math.max(14, overlapY * 0.55)),
                };
              }
              if (nextPoint.x !== moving.point.x || nextPoint.y !== moving.point.y) {
                moving.point = nextPoint;
                moved = true;
              }
            }
          }
          if (!moved) break;
        }
      };
      const paneSlide = phaseActive ? ontologyPaneSlide(localState, phase, activeDepth) : { u: 0, v: 0 };
      const placedItems = depthVisibleNodes.map((node) => {
        const depth = ontologyDepthForNode(node);
        const uv = placements[phase]?.[node.id] || fallbackPlacement(depth);
        const size = nodeSizeFor(node, depth);
        const basePoint = itemDeckPoint(uv.u + paneSlide.u, uv.v + paneSlide.v);
        return {
          node,
          depth,
          size,
          point: basePoint,
        };
      });
      resolvePaneCollisions(placedItems);
      const placedById = new Map(placedItems.map((item) => [item.node.id, item]));
      const isRelatedItem = (item) => {
        const itemCanonicalId = ontologyCanonicalIdForNode(graph, item?.node);
        return item?.node?.id === selected?.id
          || narrativeIds.has(item?.node?.id)
          || selectedRelatedIds.has(item?.node?.id)
          || (itemCanonicalId && (narrativeIds.has(itemCanonicalId) || selectedRelatedIds.has(itemCanonicalId)));
      };
      const isNarrativeEdge = (edge) => narrativeIds.has(edge.source) && narrativeIds.has(edge.target);
      const itemAnchor = (item, side = 'center') => {
        const size = item.size || { width: 100, height: 42 };
        if (side === 'top') return { x: item.point.x, y: item.point.y - size.height / 2 + 2 };
        if (side === 'bottom') return { x: item.point.x, y: item.point.y + size.height / 2 - 2 };
        if (side === 'left') return { x: item.point.x - size.width / 2 + 3, y: item.point.y };
        if (side === 'right') return { x: item.point.x + size.width / 2 - 3, y: item.point.y };
        return { x: item.point.x, y: item.point.y };
      };
      const structuralEdgeIds = new Set();
      const drawAssemblyConnector = (sourceId, targetId, edgeRelation, busY = null) => {
        const from = placedById.get(sourceId);
        const to = placedById.get(targetId);
        if (!from || !to) return;
        const related = isRelatedItem(from) || isRelatedItem(to);
        const start = itemAnchor(from, 'bottom');
        const end = itemAnchor(to, 'top');
        const midY = busY || (start.y + end.y) / 2;
        contentGroup.appendChild(svgEl('path', {
          class: `egd-ontology-depth-connector egd-ontology-assembly-tree-connector egd-ontology-assembly-tree-${edgeRelation}`,
          d: `M ${start.x} ${start.y} L ${start.x} ${midY} L ${end.x} ${midY} L ${end.x} ${end.y}`,
          fill: 'none',
          stroke: edgeRelation === 'contains' ? 'rgba(45, 90, 123, 0.50)' : 'rgba(45, 90, 123, 0.38)',
          'stroke-width': phaseActive ? (related ? '1.7' : '1.15') : '0.9',
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          opacity: phaseActive ? (related ? '0.86' : '0.40') : '0.14',
          'pointer-events': 'none',
        }));
      };
      const drawReferenceConnector = (sourceId, targetId, options = {}) => {
        const from = placedById.get(sourceId);
        const to = placedById.get(targetId);
        if (!from || !to) return;
        const start = itemAnchor(from, options.fromSide || 'bottom');
        const end = itemAnchor(to, options.toSide || 'top');
        const busY = options.busY ?? (start.y + end.y) / 2;
        const d = options.direct
          ? `M ${start.x} ${start.y} L ${end.x} ${end.y}`
          : `M ${start.x} ${start.y} L ${start.x} ${busY} L ${end.x} ${busY} L ${end.x} ${end.y}`;
        if (options.glow) {
          contentGroup.appendChild(svgEl('path', {
            class: 'egd-ontology-reference-route-glow',
            d,
            fill: 'none',
            stroke: options.glowStroke || 'rgba(255, 225, 156, 0.58)',
            'stroke-width': options.glowWidth || '8',
            'stroke-linecap': 'square',
            'stroke-linejoin': 'miter',
            opacity: phaseActive ? '0.74' : '0.12',
            'pointer-events': 'none',
          }));
        }
        contentGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-reference-route',
          d,
          fill: 'none',
          stroke: options.stroke || 'rgba(63, 123, 97, 0.42)',
          'stroke-width': options.width || '1.55',
          'stroke-dasharray': options.dash || null,
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          opacity: phaseActive ? (options.opacity || '0.68') : '0.10',
          'pointer-events': 'none',
        }));
      };
      if (phase === 'present') {
        const relationFor = (sourceId, targetId) => (graph?.edges || []).find((edge) => (
          edge.source === sourceId
          && edge.target === targetId
          && (edge.relation === 'contains' || edge.relation === 'uses')
        ));
        [
          ['desktop', 'terminal', null],
          ['terminal', 'cpu', placedById.get('terminal')?.point.y + 38],
          ['terminal', 'ram', placedById.get('terminal')?.point.y + 38],
          ['terminal', 'disk', placedById.get('terminal')?.point.y + 38],
        ].forEach(([sourceId, targetId, busY]) => {
          const edge = relationFor(sourceId, targetId);
          if (!edge) return;
          structuralEdgeIds.add(edge.id);
          drawAssemblyConnector(sourceId, targetId, edge.relation, busY);
        });
        drawReferenceConnector(
          'projection.llm_chat_session.intent.context_binding',
          'projection.llm_chat_session.action.message_send',
          { stroke: 'rgba(63, 123, 97, 0.44)', width: '1.8', opacity: '0.60' },
        );
        drawReferenceConnector(
          'projection.llm_chat_session.action.message_send',
          'desktop',
          { stroke: 'rgba(63, 123, 97, 0.34)', width: '1.35', opacity: '0.38', busY: placedById.get('desktop')?.point.y - 38 },
        );
        drawReferenceConnector(
          'projection.llm_chat_session.action.message_send',
          'terminal',
          { stroke: 'rgba(63, 123, 97, 0.34)', width: '1.35', opacity: '0.38', busY: placedById.get('terminal')?.point.y - 38 },
        );
        drawReferenceConnector(
          'projection.llm_chat_session.storage.session_file',
          'disk',
          { stroke: 'rgba(92, 97, 105, 0.24)', width: '1.2', dash: '5 6', opacity: '0.32' },
        );
      }

      const relationPriority = new Set(['represented_by', 'binds', 'derived_from', 'provides_evidence_for', 'operates_inside', 'uses']);
      const selectedRelationKey = localState.selectedRelation
        ? `${localState.selectedRelation.source}|${localState.selectedRelation.relation}|${localState.selectedRelation.target}`
        : '';
      const referenceRelationKeys = new Set([
        'entity.llm_chat_session|represented_by|projection.llm_chat_session.intent.context_binding',
      ]);
      const relationEdges = (graph?.edges || [])
        .filter((edge) => (
          !structuralEdgeIds.has(edge.id)
          && (phase !== 'present' || referenceRelationKeys.has(`${edge.source}|${edge.relation}|${edge.target}`))
          && relationPriority.has(edge.relation)
          && placedById.has(edge.source)
          && placedById.has(edge.target)
          && !(edge.relation === 'uses' && ['desktop', 'terminal', 'cpu', 'ram', 'disk'].includes(edge.source) && ['desktop', 'terminal', 'cpu', 'ram', 'disk'].includes(edge.target))
          && (
            focusTarget !== 'pane'
            || edge.source === selected?.id
            || edge.target === selected?.id
            || edge.kind === 'relation_map'
            || isNarrativeEdge(edge)
          )
          && (isNarrativeEdge(edge) || edge.source === selected?.id || edge.target === selected?.id || edge.kind === 'relation_map')
        ))
        .sort((a, b) => {
          const aSelected = a.source === selected?.id || a.target === selected?.id ? 0 : 1;
          const bSelected = b.source === selected?.id || b.target === selected?.id ? 0 : 1;
          return aSelected - bSelected || String(a.id || '').localeCompare(String(b.id || ''));
        })
        .slice(0, phase === 'present' ? 8 : 4);
      relationEdges.forEach((edge, index) => {
        const from = placedById.get(edge.source);
        const to = placedById.get(edge.target);
        const sameDepth = from.depth === to.depth;
        const selectedEdge = selectedRelationKey === `${edge.source}|${edge.relation}|${edge.target}`;
        const primaryRouteEdge = (
          edge.source === 'entity.llm_chat_session'
          && edge.target === 'projection.llm_chat_session.intent.context_binding'
        );
        const related = selectedEdge || isNarrativeEdge(edge) || selectedRelatedIds.has(edge.source) || selectedRelatedIds.has(edge.target);
        const signX = Math.sign(to.point.x - from.point.x) || 1;
        const signY = Math.sign(to.point.y - from.point.y) || 1;
        const start = sameDepth ? itemAnchor(from, signX > 0 ? 'right' : 'left') : itemAnchor(from, signY > 0 ? 'bottom' : 'top');
        const end = sameDepth ? itemAnchor(to, signX > 0 ? 'left' : 'right') : itemAnchor(to, signY > 0 ? 'top' : 'bottom');
        const busY = sameDepth
          ? start.y + (from.depth === 'virtual' ? 26 + index * 2 : -24 - index * 2)
          : (start.y + end.y) / 2 + (index % 2 ? 6 : -6);
        const stroke = primaryRouteEdge
          ? 'rgba(234, 177, 70, 0.86)'
          : edge.relation === 'binds'
          ? 'rgba(63, 123, 97, 0.54)'
          : edge.relation === 'represented_by'
            ? 'rgba(138, 107, 46, 0.48)'
            : edge.relation === 'provides_evidence_for' || edge.relation === 'derived_from'
              ? 'rgba(111, 90, 154, 0.48)'
              : 'rgba(92, 97, 105, 0.38)';
        const relationOpacity = primaryRouteEdge
          ? '0.84'
          : phaseActive
            ? (related ? '0.34' : '0.10')
            : '0.05';
        if (primaryRouteEdge) {
          contentGroup.appendChild(svgEl('path', {
            class: 'egd-ontology-inventory-relation-glow',
            d: `M ${start.x} ${start.y} L ${start.x} ${busY} L ${end.x} ${busY} L ${end.x} ${end.y}`,
            fill: 'none',
            stroke: 'rgba(255, 225, 156, 0.70)',
            'stroke-width': '10',
            'stroke-linecap': 'square',
            'stroke-linejoin': 'miter',
            opacity: phaseActive ? '0.82' : '0.10',
            'pointer-events': 'none',
          }));
        }
        contentGroup.appendChild(svgEl('path', {
          class: `egd-ontology-inventory-relation egd-ontology-clickable-relation egd-ontology-inventory-relation-${edge.relation}`,
          d: `M ${start.x} ${start.y} L ${start.x} ${busY} L ${end.x} ${busY} L ${end.x} ${end.y}`,
          fill: 'none',
          stroke,
          'stroke-width': primaryRouteEdge ? '3.6' : selectedEdge ? '1.4' : related ? '0.95' : '0.65',
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          opacity: relationOpacity,
          onclick: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onRelationSelect?.(edge, phase);
          },
        }));
        contentGroup.appendChild(svgEl('polygon', {
          class: 'egd-ontology-inventory-relation-arrow',
          points: `${end.x},${end.y} ${end.x - signX * 8},${end.y - 4} ${end.x - signX * 8},${end.y + 4}`,
          fill: stroke,
          opacity: primaryRouteEdge ? '0.76' : phaseActive ? (related ? '0.30' : '0.08') : '0.04',
          'pointer-events': 'none',
        }));
      });

      placedItems.forEach((item) => {
        const { node, depth, point, size } = item;
        const facet = ontologyProjectionFacet(node.id);
        const axis = ontologyAxisForNode(node);
        const highlighted = activeDepth === depth;
        const related = isRelatedItem(item);
        const visual = nodeVisualFor(node, depth);
        const rendered = renderOntologySvgNode(contentGroup, node, point, {
          mode: 'focus',
          color: visual.stroke || (facet ? ontologyFacetPlaneColor(facet) : ontologyAxisColor(axis)),
          fill: visual.fill,
          extraClass: `egd-ontology-pane-inventory-node egd-ontology-deck-node egd-ontology-depth-${depth}${related ? ' egd-ontology-pane-inventory-node-related' : ' egd-ontology-pane-inventory-node-unrelated'}${highlighted ? '' : ' egd-ontology-depth-muted'}`,
          selected: node.id === selected?.id,
          label: ontologyDisplayLabel(node, 'focus').replace(/^[^·]+·\s*/, ''),
          meta: '',
          size,
          labelMax: phaseActive ? (node.id?.startsWith('projection.') ? 16 : 18) : 12,
          metaMax: 0,
          namespaceBadge: '',
          layerBadge: '',
          icon: nodeIconFor(node),
          iconColor: visual.iconColor,
          iconBg: visual.iconBg,
          iconBgStroke: visual.iconBgStroke,
          labelFill: visual.labelFill,
          showPorts: phaseActive,
          onclick: (ev) => {
            ev.stopPropagation();
            onSelect(node.id);
          },
        });
        rendered.dataset.phase = phase;
        rendered.dataset.depth = depth;
        if (!phaseActive) rendered.setAttribute('opacity', related ? '0.42' : '0.20');
        else if (!highlighted) rendered.setAttribute('opacity', related ? '0.56' : '0.12');
        else if (!related) rendered.setAttribute('opacity', '0.34');
      });

      return {
        phase,
        bounds,
        placedItems,
        placedById,
      };
    };

    if (usePaneMap) {
      const panePlacements = new Map();
      ['past', 'present', 'future'].forEach((phase) => {
        panePlacements.set(phase, renderDeckPaneInventory(phase));
      });
      const drawTemporalObjectLink = (fromPhase, fromId, toPhase, toId, options = {}) => {
        const fromPane = panePlacements.get(fromPhase);
        const toPane = panePlacements.get(toPhase);
        const from = fromPane?.placedById?.get(fromId);
        const to = toPane?.placedById?.get(toId);
        if (!from || !to) return;
        const fromSize = from.size || { width: 104, height: 46 };
        const toSize = to.size || { width: 104, height: 46 };
        const forward = to.point.x >= from.point.x;
        const start = {
          x: from.point.x + (forward ? fromSize.width / 2 - 2 : -fromSize.width / 2 + 2),
          y: from.point.y,
        };
        const end = {
          x: to.point.x - (forward ? toSize.width / 2 - 2 : -toSize.width / 2 + 2),
          y: to.point.y,
        };
        const busX = options.busX || (start.x + end.x) / 2;
        const related = narrativeIds.has(fromId) || narrativeIds.has(toId) || selectedRelatedIds.has(fromId) || selectedRelatedIds.has(toId);
        const primary = options.kind === 'evidence-context' || options.kind === 'intent-goal' || options.kind === 'plan-branch';
        const glow = options.kind === 'intent-goal' || options.glow;
        const contextRoute = options.kind === 'evidence-context';
        const secondaryRoute = !glow && !contextRoute;
        temporalLinkGroup.appendChild(svgEl('path', {
          class: `egd-ontology-temporal-object-link-underlay egd-ontology-temporal-object-link-underlay-${options.kind || 'flow'}`,
          d: `M ${start.x} ${start.y} L ${busX} ${start.y} L ${busX} ${end.y} L ${end.x} ${end.y}`,
          fill: 'none',
          stroke: glow ? 'rgba(255, 225, 156, 0.72)' : 'rgba(255, 255, 255, 0.82)',
          'stroke-width': glow ? '15' : secondaryRoute ? '3.2' : String((Number(options.width || 2) || 2) + 3.4),
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          opacity: secondaryRoute ? '0.22' : '1',
          'pointer-events': 'none',
        }));
        temporalLinkGroup.appendChild(svgEl('path', {
          class: `egd-ontology-temporal-object-link egd-ontology-temporal-object-link-${options.kind || 'flow'}`,
          d: `M ${start.x} ${start.y} L ${busX} ${start.y} L ${busX} ${end.y} L ${end.x} ${end.y}`,
          fill: 'none',
          stroke: glow ? 'rgba(234, 177, 70, 0.88)' : options.stroke || 'rgba(111, 90, 154, 0.34)',
          'stroke-width': glow ? '5.6' : contextRoute ? '2.6' : secondaryRoute ? '1.15' : primary ? '2.2' : related ? options.width || '1.6' : '1.1',
          'stroke-dasharray': options.dash || null,
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          opacity: glow ? '0.98' : contextRoute ? '0.42' : secondaryRoute ? '0.16' : related ? '0.32' : '0.10',
          'pointer-events': 'none',
        }));
        temporalLinkGroup.appendChild(svgEl('circle', {
          class: 'egd-ontology-temporal-object-link-source',
          cx: start.x,
          cy: start.y,
          r: primary ? 4.2 : 3.2,
          fill: options.stroke || 'rgba(111, 90, 154, 0.34)',
          opacity: glow ? '0.72' : contextRoute ? '0.34' : secondaryRoute ? '0.12' : related ? '0.40' : '0.16',
          'pointer-events': 'none',
        }));
        temporalLinkGroup.appendChild(svgEl('polygon', {
          class: 'egd-ontology-temporal-object-link-arrow',
          points: `${end.x},${end.y} ${end.x - (forward ? 8 : -8)},${end.y - 4} ${end.x - (forward ? 8 : -8)},${end.y + 4}`,
          fill: options.stroke || 'rgba(111, 90, 154, 0.34)',
          opacity: glow ? '0.78' : contextRoute ? '0.38' : secondaryRoute ? '0.12' : related ? '0.42' : '0.16',
          'pointer-events': 'none',
        }));
        if (options.label && options.showLabel) {
          const labelX = busX + (forward ? -6 : 6);
          const labelY = (start.y + end.y) / 2 - 8;
          const labelText = String(options.label);
          const labelWidth = Math.max(64, Math.min(124, labelText.length * 9.5 + 18));
          temporalLinkGroup.appendChild(svgEl('rect', {
            class: 'egd-ontology-temporal-object-link-label-bg',
            x: labelX - labelWidth / 2,
            y: labelY - 10,
            width: labelWidth,
            height: 24,
            rx: 8,
            fill: 'rgba(255, 255, 255, 0.90)',
            stroke: options.stroke || 'rgba(111, 90, 154, 0.34)',
            'stroke-width': '0.8',
            'stroke-opacity': '0.28',
            opacity: related ? '1' : '0.42',
            'pointer-events': 'none',
          }));
          temporalLinkGroup.appendChild(svgEl('text', {
            class: 'egd-ontology-temporal-object-link-label',
            x: labelX,
            y: labelY + 4,
            fill: options.stroke || 'rgba(111, 90, 154, 0.72)',
            'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
            'font-size': primary ? '12' : '10.5',
            'font-weight': '900',
            'text-anchor': 'middle',
            opacity: related ? '1' : '0.42',
            'pointer-events': 'none',
          }, labelText));
        }
      };
      const drawGoalLensBridgeContract = () => {
        if (selected?.id !== 'goal') return;
        const fromPane = panePlacements.get('present');
        const toPane = panePlacements.get('future');
        const from = fromPane?.placedById?.get('projection.llm_chat_session.intent.context_binding');
        const to = toPane?.placedById?.get('goal');
        if (!from || !to) return;
        const start = {
          x: from.point.x + (from.size?.width || 120) / 2 - 4,
          y: from.point.y,
        };
        const end = {
          x: to.point.x - (to.size?.width || 120) / 2 + 4,
          y: to.point.y,
        };
        const busX = (start.x + end.x) / 2;
        const d = `M ${start.x} ${start.y} L ${busX} ${start.y} L ${busX} ${end.y} L ${end.x} ${end.y}`;
        temporalLinkGroup.appendChild(svgEl('path', {
          d,
          fill: 'none',
          stroke: 'rgba(255, 255, 255, 0.88)',
          'stroke-width': '8',
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          'pointer-events': 'none',
        }));
        temporalLinkGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-guide-goal-bridge',
          d,
          fill: 'none',
          stroke: 'rgba(91, 67, 136, 0.82)',
          'stroke-width': '2.4',
          'stroke-linecap': 'square',
          'stroke-linejoin': 'miter',
          'pointer-events': 'none',
        }));
        [busX - 18, busX + 18].forEach((x) => {
          temporalLinkGroup.appendChild(svgEl('rect', {
            class: 'egd-ontology-guide-goal-gate',
            x: x - 6,
            y: end.y - 22,
            width: 12,
            height: 44,
            rx: 4,
            fill: 'rgba(91, 67, 136, 0.16)',
            stroke: 'rgba(91, 67, 136, 0.70)',
            'stroke-width': '1.5',
            'pointer-events': 'none',
          }));
          temporalLinkGroup.appendChild(svgEl('circle', {
            class: 'egd-ontology-guide-goal-gate-port',
            cx: x,
            cy: end.y,
            r: 4.2,
            fill: '#FFFFFF',
            stroke: 'rgba(91, 67, 136, 0.76)',
            'stroke-width': '1.5',
            'pointer-events': 'none',
          }));
        });
        [start, end].forEach((point) => {
          temporalLinkGroup.appendChild(svgEl('circle', {
            class: 'egd-ontology-guide-goal-endpoint',
            cx: point.x,
            cy: point.y,
            r: 6,
            fill: '#FFFFFF',
            stroke: 'rgba(91, 67, 136, 0.78)',
            'stroke-width': '2',
            'pointer-events': 'none',
          }));
        });
      };
      deckScene.temporalRoutes.forEach((route) => {
        drawTemporalObjectLink(route.fromPhase, route.fromId, route.toPhase, route.toId, route);
      });
      drawGoalLensBridgeContract();
      graphGroup.appendChild(paneGroup);
      graphGroup.appendChild(centerGroup);
      graphGroup.appendChild(contextGroup);
      graphGroup.appendChild(noviceOverlayGroup);
      return;
    }

    if (canonicalNode) {
      renderOntologySvgNode(paneGroup, canonicalNode, { x: 664, y: 450 }, {
        mode: 'focus',
        color: ontologyAxisColor('virtual'),
        fill: 'rgba(255, 249, 237, 0.96)',
        extraClass: 'egd-ontology-node-canonical egd-ontology-virtual-overlay',
        selected: canonicalNode.id === selected?.id,
        label: ontologyDisplayLabel(canonicalNode, 'focus'),
        meta: '가상 오버레이 · 표준 정체성',
        size: { width: 244, height: 56 },
        labelMax: 28,
        metaMax: 22,
        onclick: (ev) => {
          ev.stopPropagation();
          onSelect(canonicalNode.id);
        },
      });
    }

    paneGroup.appendChild(svgEl('line', {
      x1: present.x + 28,
      y1: present.y + 106,
      x2: present.x + present.w - 28,
      y2: present.y + 106,
      stroke: 'rgba(45, 90, 123, 0.12)',
      'stroke-width': '1.3',
    }));
    paneGroup.appendChild(svgEl('line', {
      x1: present.x + 28,
      y1: present.y + 252,
      x2: present.x + present.w - 28,
      y2: present.y + 252,
      stroke: 'rgba(138, 107, 46, 0.12)',
      'stroke-width': '1.3',
    }));
    paneGroup.appendChild(svgEl('rect', {
      class: 'egd-ontology-physical-object-band',
      x: present.x + 34,
      y: present.y + 82,
      width: present.w - 68,
      height: 92,
      rx: 16,
      fill: 'rgba(45, 90, 123, 0.045)',
      stroke: 'rgba(45, 90, 123, 0.10)',
      'stroke-width': '1',
      'pointer-events': 'none',
    }));
    paneGroup.appendChild(svgEl('path', {
      class: 'egd-ontology-binding-ribbon',
      d: 'M 450 330 C 548 318, 766 318, 878 330',
      fill: 'none',
      stroke: 'rgba(138, 107, 46, 0.18)',
      'stroke-width': '18',
      'stroke-linecap': 'round',
      'pointer-events': 'none',
    }));
    paneGroup.appendChild(svgEl('path', {
      class: 'egd-ontology-binding-ribbon-core',
      d: 'M 450 330 C 548 318, 766 318, 878 330',
      fill: 'none',
      stroke: 'rgba(138, 107, 46, 0.24)',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'pointer-events': 'none',
    }));
    paneGroup.appendChild(svgEl('rect', {
      class: 'egd-ontology-virtual-overlay-band',
      x: present.x + 118,
      y: present.y + 308,
      width: present.w - 236,
      height: 124,
      rx: 18,
      fill: 'rgba(138, 107, 46, 0.055)',
      stroke: 'rgba(138, 107, 46, 0.13)',
      'stroke-width': '1',
      'pointer-events': 'none',
    }));
    [
      ['M 518 296 C 548 328, 614 372, 664 422', 'rgba(45, 90, 123, 0.22)'],
      ['M 664 296 C 664 334, 664 384, 664 422', 'rgba(63, 123, 97, 0.22)'],
      ['M 810 296 C 782 328, 720 372, 664 422', 'rgba(89, 104, 117, 0.22)'],
    ].forEach(([d, stroke]) => {
      paneGroup.appendChild(svgEl('path', {
        class: 'egd-ontology-meaning-ribbon',
        d,
        fill: 'none',
        stroke,
        'stroke-width': '2.4',
        'stroke-linecap': 'round',
        'stroke-dasharray': '7 6',
        'pointer-events': 'none',
      }));
    });

    renderProjection('space', { x: 518, y: 274 }, { width: 136, height: 44 });
    renderProjection('topology', { x: 664, y: 274 }, { width: 136, height: 44 });
    renderProjection('storage', { x: 810, y: 274 }, { width: 136, height: 44 });
    renderProjection('intent', { x: 664, y: 384 }, { width: 210, height: 44 });
    renderProjection('time', { x: 204, y: 346 }, { width: 178, height: 44 });
    renderProjection('action', { x: 1116, y: 346 }, { width: 178, height: 44 });

    const drawBindingAnchor = (label, x, y, color) => {
      const chip = svgEl('g', { class: 'egd-ontology-binding-anchor' });
      chip.appendChild(svgEl('title', {}, label));
      chip.appendChild(svgEl('rect', {
        x,
        y,
        width: 76,
        height: 24,
        rx: 12,
        fill: 'rgba(255, 255, 255, 0.82)',
        stroke: color,
        'stroke-width': '1.1',
        'stroke-opacity': '0.22',
      }));
      chip.appendChild(svgEl('circle', {
        cx: x + 20,
        cy: y + 12,
        r: 4.5,
        fill: color,
        opacity: '0.82',
      }));
      chip.appendChild(svgEl('line', {
        x1: x + 31,
        y1: y + 12,
        x2: x + 58,
        y2: y + 12,
        stroke: color,
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        opacity: '0.46',
      }));
      centerGroup.appendChild(chip);
    };
    drawBindingAnchor('토폴로지', 530, 330, ontologyAxisColor('space'));
    drawBindingAnchor('저장', 622, 330, ontologyAxisColor('space'));
    drawBindingAnchor('의도', 714, 330, ontologyAxisColor('virtual'));
    drawBindingAnchor('행동', 1054, 404, ontologyAxisColor('time'));

    const contextEdges = (graph?.edges || []).filter((edge) => (
      edge.source === canonicalId
      && ['binds', 'derived_from', 'provides_evidence_for', 'operates_inside'].includes(edge.relation)
    ));
    contextEdges.slice(0, 4).forEach((edge, index) => {
      const node = ontologyNodeById(graph, edge.target);
      const x = 442 + index * 164;
      const y = 604;
      const chip = svgEl('g', {
        class: 'egd-ontology-context-chip',
        onclick: (ev) => {
          ev.stopPropagation();
          onSelect(edge.target);
        },
      });
      chip.appendChild(svgEl('rect', {
        x,
        y,
        width: 150,
        height: 32,
        rx: 16,
        fill: 'rgba(247, 245, 240, 0.88)',
        stroke: 'rgba(92, 97, 105, 0.22)',
        'stroke-width': '1.2',
      }));
      chip.appendChild(svgEl('text', {
        x: x + 75,
        y: y + 21,
        fill: '#5A5A5A',
        'font-family': 'Inter, -apple-system, Segoe UI, system-ui, sans-serif',
        'font-size': '10',
        'font-weight': '700',
        'text-anchor': 'middle',
      }, ontologyTrimText(ontologyDisplayLabel(node, 'focus') || edge.target, 18)));
      contextGroup.appendChild(chip);
    });

    drawNoviceGuideBoard();

    graphGroup.appendChild(paneGroup);
    graphGroup.appendChild(centerGroup);
    graphGroup.appendChild(contextGroup);
    graphGroup.appendChild(noviceOverlayGroup);
  }

  function ontologyLaneForNode(node) {
    const id = node?.id || '';
    if (id.includes('past') || id.startsWith('history.') || id.startsWith('logs.') || id.startsWith('revisions.')) return 'past';
    if (id.includes('present') || id.startsWith('desk.') || id.startsWith('surface.') || id.startsWith('architecture.')) return 'present';
    if (id.includes('future') || id.startsWith('vision') || id.startsWith('goal') || id.startsWith('plan') || id.startsWith('task') || id.startsWith('candidate.')) return 'future';
    if (id.includes('multiverse') || id.startsWith('alternate.') || id.startsWith('simulated.') || id.startsWith('candidate.')) return 'multiverse';
    return 'support';
  }

  function ontologyProjectPoint(point, mode, tilt) {
    const z = mode === 'spatial' ? (point.z || 0) : 0;
    const factor = Math.max(0, Math.min(60, Number(tilt) || 0)) / 60;
    return {
      x: point.x + z * 46 * factor,
      y: point.y - z * 28 * factor,
    };
  }

  function ontologyLayoutGraph(graph, mode, selected) {
    const nodes = graph?.nodes || [];
    const positions = new Map();
    const layerOrder = ['reality', 'architecture', 'time', 'operation', 'runtime', 'evidence', 'ontology'];
    const timeLaneOrder = ['past', 'present', 'future', 'multiverse', 'support'];
    const coreSpatial = new Map([
      ['reality.base', { x: 70, y: 320, z: -2 }],
      ['architecture.runtime', { x: 310, y: 240, z: -1 }],
      ['time.past', { x: 250, y: 520, z: -1 }],
      ['time.present', { x: 590, y: 320, z: 0 }],
      ['operation.layer', { x: 820, y: 320, z: 1 }],
      ['actor.runtime', { x: 1020, y: 320, z: 2 }],
      ['output.structured', { x: 820, y: 540, z: 1 }],
      ['time.future', { x: 1090, y: 160, z: 2 }],
      ['time.multiverse', { x: 1120, y: 520, z: 2 }],
      ['source.ref', { x: 580, y: 560, z: 0 }],
      ['egdesk.world', { x: 560, y: 120, z: 0 }],
    ]);

    if (mode === 'focus') {
      const selectedNode = selected || nodes[0] || null;
      const canonicalId = ontologyCanonicalIdForNode(graph, selectedNode);
      const projectionNodes = ontologyProjectionNodesForCanonical(graph, canonicalId).filter((node) => nodes.some((candidate) => candidate.id === node.id));
      const canonicalNode = nodes.find((node) => node.id === canonicalId) || selectedNode;
      if (canonicalNode) positions.set(canonicalNode.id, { x: 660, y: 360, z: 0.5 });

      const facetSlots = {
        space: { x: 330, y: 190, z: -1.2 },
        topology: { x: 660, y: 145, z: -0.9 },
        storage: { x: 990, y: 190, z: -1.2 },
        time: { x: 330, y: 545, z: 1.1 },
        intent: { x: 660, y: 595, z: 1.25 },
        action: { x: 990, y: 545, z: 1.1 },
      };
      projectionNodes.forEach((node, index) => {
        const facet = ontologyProjectionFacet(node.id);
        const slot = facetSlots[facet] || {
          x: 340 + (index % 3) * 310,
          y: 190 + Math.floor(index / 3) * 320,
          z: (index % 3) - 1,
        };
        positions.set(node.id, slot);
      });

      const remainder = nodes
        .filter((node) => !positions.has(node.id))
        .sort((a, b) => a.id.localeCompare(b.id));
      remainder.forEach((node, index) => {
        const x = 365 + index * 210;
        positions.set(node.id, { x, y: 710, z: 0 });
      });
      return positions;
    }

    if (mode === 'time') {
      const groups = new Map(timeLaneOrder.map((lane) => [lane, []]));
      for (const node of nodes) groups.get(ontologyLaneForNode(node)).push(node);
      for (const [lane, group] of groups.entries()) {
        const laneIndex = timeLaneOrder.indexOf(lane);
        const x = 95 + laneIndex * 260;
        group
          .sort((a, b) => a.id.localeCompare(b.id))
          .forEach((node, index) => {
            positions.set(node.id, { x, y: 105 + index * 74, z: laneIndex - 2 });
          });
      }
      return positions;
    }

    if (mode === 'spatial') {
      const remainder = nodes.filter((node) => !coreSpatial.has(node.id));
      for (const [id, pos] of coreSpatial.entries()) positions.set(id, pos);
      const layerGroups = new Map();
      for (const node of remainder) {
        const layer = node.layer || 'ontology';
        if (!layerGroups.has(layer)) layerGroups.set(layer, []);
        layerGroups.get(layer).push(node);
      }
      for (const [layer, group] of layerGroups.entries()) {
        const layerIndex = layerOrder.indexOf(layer);
        const radius = 145 + Math.max(0, layerIndex) * 22;
        const center = layer === 'evidence'
          ? { x: 300, y: 470, z: -1 }
          : layer === 'architecture'
            ? { x: 360, y: 260, z: -1 }
            : layer === 'runtime'
              ? { x: 960, y: 370, z: 2 }
              : layer === 'time'
                ? { x: 900, y: 285, z: 1 }
                : { x: 610, y: 340, z: 0 };
        group
          .sort((a, b) => a.id.localeCompare(b.id))
          .forEach((node, index) => {
            const angle = (Math.PI * 2 * index) / Math.max(1, group.length);
            positions.set(node.id, {
              x: center.x + Math.cos(angle) * radius,
              y: center.y + Math.sin(angle) * radius * 0.58,
              z: center.z + ((index % 3) - 1) * 0.45,
            });
          });
      }
      return positions;
    }

    const groups = new Map(layerOrder.map((layer) => [layer, []]));
    for (const node of nodes) {
      const layer = groups.has(node.layer) ? node.layer : 'ontology';
      groups.get(layer).push(node);
    }
    for (const [layer, group] of groups.entries()) {
      const layerIndex = layerOrder.indexOf(layer);
      const x = 80 + layerIndex * 185;
      group
        .sort((a, b) => a.id.localeCompare(b.id))
        .forEach((node, index) => {
          positions.set(node.id, { x, y: 92 + index * 70, z: layerIndex - 3 });
        });
    }
    return positions;
  }

  function ontologyAliasLine(node) {
    return Array.isArray(node?.aliases) && node.aliases.length
      ? node.aliases.join(', ')
      : '';
  }

  function ontologyAbbreviationLines(node) {
    if (!node?.abbreviations || typeof node.abbreviations !== 'object') return [];
    return Object.entries(node.abbreviations)
      .filter(([, values]) => Array.isArray(values) && values.length)
      .map(([key, values]) => `${key}: ${values.join(' / ')}`);
  }

  function ontologyContextBundle(graph, nodeId) {
    const node = (graph?.nodes || []).find((item) => item.id === nodeId);
    if (!node) return '';
    const edges = (graph?.edges || []).filter((edge) => edge.source === nodeId || edge.target === nodeId);
    const edgeLines = edges.map((edge) => `- ${edge.source} -[${edge.relation}]-> ${edge.target}`).join('\n');
    const aliasLine = ontologyAliasLine(node);
    const abbreviationLines = ontologyAbbreviationLines(node);
    return [
      `# ${node.label || node.id}`,
      '',
      `id: ${node.id}`,
      `type: ${node.type || ''}`,
      `layer: ${node.layer || ''}`,
      `path: ${node.path || 'synthetic'}`,
      ...(aliasLine ? [`aliases: ${aliasLine}`] : []),
      '',
      node.summary || '',
      ...(abbreviationLines.length ? [
        '',
        '## Abbreviations',
        ...abbreviationLines.map((line) => `- ${line}`),
      ] : []),
      '',
      '## Relations',
      edgeLines || '- none',
      '',
      '## Body',
      node.body || '(no body)',
    ].join('\n');
  }

  function renderOntologyMap(stage, detail, graph, localState) {
    const allNodes = graph?.nodes || [];
    const allEdges = graph?.edges || [];
    const selected = allNodes.find((node) => node.id === localState.selectedId)
      || allNodes.find((node) => node.id === 'entity.llm_chat_session')
      || allNodes.find((node) => node.id === 'egdesk.world')
      || allNodes[0]
      || null;
    if (selected) localState.selectedId = selected.id;
    if (!ONTOLOGY_TIME_PANE_ORDER.includes(localState.activePane)) {
      localState.activePane = selected ? ontologyPhaseForNode(selected) : 'present';
    }
    localState.activeDepth = ontologyNormalizeDepth(
      localState.activeDepth,
      ontologyDefaultDepthForPane(localState.activePane || 'present', selected),
    );
    const visibleGraph = ontologyVisibleGraph(graph, localState.mode, selected);
    const nodes = visibleGraph.nodes || [];
    const edges = visibleGraph.edges || [];
    const positions = ontologyLayoutGraph({ ...graph, nodes }, localState.mode, selected);
    const card = stage.closest?.('.egd-ontology-card');
    if (card) card.classList.toggle('egd-ontology-canvas-first', false);
    document.documentElement.classList.toggle('egd-ontology-focus-active', localState.mode === 'focus');
    document.documentElement.classList.remove('egd-ontology-object-focus-active');
    const stageRect = stage.getBoundingClientRect?.();
    const stageAspect = stageRect?.height > 20 ? stageRect.width / stageRect.height : 1.45;
    const lensViewBox = (centerX, y, height, { minWidth = 920, maxWidth = 1120 } = {}) => {
      const width = Math.max(minWidth, Math.min(maxWidth, Math.round(height * stageAspect)));
      return `${Math.round(centerX - width / 2)} ${y} ${width} ${height}`;
    };
    const focusViewBox = (() => {
      if (localState.mode !== 'focus') return '0 0 1320 780';
      return '0 76 1320 740';
    })();

    stage.textContent = '';
    const svg = svgEl('svg', {
      class: `egd-ontology-svg egd-ontology-mode-${localState.mode}`,
      viewBox: focusViewBox,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'EG-Desk 온톨로지 지도',
      style: localState.mode === 'spatial'
        ? { transform: `perspective(1100px) rotateX(${Math.round(localState.tilt * 0.35)}deg)` }
        : {},
    });
    const graphGroup = svgEl('g', {
      class: 'egd-ontology-graph',
      transform: localState.mode === 'focus'
        ? `scale(${localState.zoom})`
        : `translate(${localState.pan.x} ${localState.pan.y}) scale(${localState.zoom})`,
      style: localState.mode === 'spatial'
        ? { transformOrigin: '50% 50%', transformBox: 'fill-box' }
        : {},
    });

    if (localState.mode === 'focus') {
      renderOntologyFocusPlanes(graphGroup, graph, selected, localState, (nodeId) => {
        const nextNode = ontologyNodeById(graph, nodeId);
        localState.focusTarget = 'object';
        localState.selectedId = nodeId;
        localState.activePane = ontologyPhaseForNode(nextNode);
        localState.activeDepth = ontologyDepthForNode(nextNode);
        localState.selectedRelation = null;
        ontologyResetFocusViewport(localState);
        renderOntologyMap(stage, detail, graph, localState);
      }, (phase) => {
        ontologySetPane(localState, phase);
        localState.activeDepth = ontologyNormalizeDepth(
          localState.activeDepth,
          ontologyDefaultDepthForPane(phase, selected),
        );
        renderOntologyMap(stage, detail, graph, localState);
      }, (edge, phase) => {
        const sourceNode = ontologyNodeById(graph, edge.source);
        localState.focusTarget = 'relation';
        localState.activePane = phase || localState.activePane || 'present';
        localState.activeDepth = ontologyDepthForNode(sourceNode);
        localState.selectedRelation = {
          source: edge.source,
          target: edge.target,
          relation: edge.relation,
          kind: edge.kind || '',
        };
        localState.selectedId = edge.source;
        ontologyResetFocusViewport(localState);
        renderOntologyMap(stage, detail, graph, localState);
      }, (depth, phase) => {
        localState.focusTarget = 'pane';
        localState.activePane = phase || localState.activePane || 'present';
        localState.activeDepth = ontologyNormalizeDepth(depth);
        localState.selectedRelation = null;
        ontologyResetFocusViewport(localState);
        renderOntologyMap(stage, detail, graph, localState);
      });
    } else {
      const edgeGroup = svgEl('g', { class: 'egd-ontology-edges' });
      for (const edge of edges) {
        const from = positions.get(edge.source);
        const to = positions.get(edge.target);
        if (!from || !to) continue;
        const p1 = ontologyProjectPoint(from, localState.mode, localState.tilt);
        const p2 = ontologyProjectPoint(to, localState.mode, localState.tilt);
        edgeGroup.appendChild(svgEl('path', {
          class: `egd-ontology-edge egd-ontology-edge-${edge.relation}`,
          d: `M ${p1.x} ${p1.y} C ${(p1.x + p2.x) / 2} ${p1.y}, ${(p1.x + p2.x) / 2} ${p2.y}, ${p2.x} ${p2.y}`,
          fill: 'none',
          stroke: 'rgba(92, 97, 105, 0.20)',
          'stroke-width': '1.35',
          'stroke-linecap': 'round',
          'vector-effect': 'non-scaling-stroke',
          'data-relation': edge.relation,
        }));
      }
      graphGroup.appendChild(edgeGroup);

      const nodeGroup = svgEl('g', { class: 'egd-ontology-nodes' });
      for (const node of nodes) {
        const pos = positions.get(node.id);
        if (!pos) continue;
        const point = ontologyProjectPoint(pos, localState.mode, localState.tilt);
        const color = ontologyLayerColor(node.layer);
        renderOntologySvgNode(nodeGroup, node, point, {
          mode: localState.mode,
          color,
          fill: node.id?.startsWith('entity.') ? '#FFF9ED' : node.synthetic ? '#F7F5F0' : '#FFFFFF',
          selected: node.id === selected?.id,
          labelMax: 19,
          metaMax: 24,
          onclick: (ev) => {
            ev.stopPropagation();
            localState.focusTarget = 'object';
            localState.selectedId = node.id;
            localState.selectedRelation = null;
            renderOntologyMap(stage, detail, graph, localState);
          },
        });
      }
      graphGroup.appendChild(nodeGroup);
    }
    svg.appendChild(graphGroup);
    stage.appendChild(svg);
    stage.appendChild(el('div', { class: 'egd-ontology-stage-mini-tools', 'aria-hidden': 'true' },
      el('span', { class: 'egd-ontology-stage-mini-tool' }, '⌁'),
      el('span', { class: 'egd-ontology-stage-mini-tool' }, '⌖'),
      el('span', { class: 'egd-ontology-stage-mini-tool' }, '+'),
      el('span', { class: 'egd-ontology-stage-mini-tool' }, '-'),
    ));

    detail.textContent = '';
    if (!selected) {
      detail.appendChild(el('div', { class: 'egd-ontology-empty' }, '불러온 온톨로지 노드가 없습니다.'));
      return;
    }
    const relationNodeLabel = (id) => {
      const node = ontologyNodeById(graph, id);
      return (node ? ontologyDisplayLabel(node, 'focus') : (ONTOLOGY_NODE_LABELS[id] || id)).replace(/^[^·]+·\s*/, '');
    };
    const lensHeader = () => detail.appendChild(el('div', { class: 'egd-ontology-lens-heading' },
      el('span', {}, '렌즈 상태'),
      el('span', { class: 'egd-ontology-lens-heading-icon' }, '▱'),
    ));
    const lensSection = (title, ...children) => {
      const section = el('section', { class: 'egd-ontology-lens-section' },
        el('div', { class: 'egd-ontology-detail-subtitle' }, title),
        ...children,
      );
      detail.appendChild(section);
      return section;
    };
    const lensCard = (...children) => el('div', { class: 'egd-ontology-lens-card' }, ...children);
    const lensButton = (text, onclick, extraClass = '') => el('button', {
      class: `egd-ontology-lens-card egd-ontology-lens-button${extraClass ? ` ${extraClass}` : ''}`,
      onclick,
    }, text);
    const lensMetricGrid = (...rows) => el('div', { class: 'egd-ontology-lens-metrics' },
      ...rows.map(([label, value]) => el('div', { class: 'egd-ontology-lens-metric' },
        el('span', {}, label),
        el('strong', {}, value),
      )),
    );
    const selectedLensCard = (node, subtitle = '') => lensCard(
      el('div', { class: 'egd-ontology-lens-object' },
        el('span', { class: 'egd-ontology-lens-object-icon' }, node?.id === 'goal' ? '◎' : node?.id?.startsWith('entity.') ? '▢' : '◇'),
        el('span', { class: 'egd-ontology-lens-object-label' }, relationNodeLabel(node?.id || selected.id)),
        el('span', { class: 'egd-ontology-lens-copy' }, '□'),
      ),
      subtitle ? el('div', { class: 'egd-ontology-lens-muted' }, subtitle) : null,
    );
    const appendChipRow = (labels) => detail.appendChild(el('div', { class: 'egd-ontology-chip-row' },
      ...labels.filter(Boolean).map((label) => el('span', { class: 'egd-ontology-chip' }, label)),
    ));
    const lensChipRow = (labels) => el('div', { class: 'egd-ontology-chip-row egd-ontology-chip-row-compact' },
      ...labels.filter(Boolean).map((label) => el('span', { class: 'egd-ontology-chip' }, label)),
    );
    if (localState.focusTarget === 'relation' && localState.selectedRelation) {
      const relation = localState.selectedRelation;
      const sourceNode = ontologyNodeById(graph, relation.source);
      const targetNode = ontologyNodeById(graph, relation.target);
      const sourceLabel = ontologyDisplayLabel(sourceNode, 'focus').replace(/^[^·]+·\s*/, '') || relation.source;
      const targetLabel = ontologyDisplayLabel(targetNode, 'focus').replace(/^[^·]+·\s*/, '') || relation.target;
      lensHeader();
      detail.appendChild(el('div', { class: 'egd-ontology-detail-title' }, '관계'));
      detail.appendChild(el('div', { class: 'egd-ontology-detail-id' }, `${sourceLabel} -> ${targetLabel}`));
      lensSection('연결 경로', lensCard(
        el('div', { class: 'egd-ontology-lens-pathline' },
          el('span', {}, sourceLabel),
          el('b', {}, '→'),
          el('span', {}, targetLabel),
        ),
      ));
      lensSection('관계 정보', lensMetricGrid(
        ['관계 수', '1'],
        ['경로 길이', '1 홉'],
        ['경로 유형', '출발 → 도착'],
        ['시간 방향', `${ONTOLOGY_TIME_PANE_LABELS[localState.activePane || 'present'] || '현재'}`],
      ));
      lensSection('양끝 객체',
        lensButton(`출발  ${sourceLabel}`, () => {
          localState.focusTarget = 'object';
          localState.selectedRelation = null;
          localState.selectedId = relation.source;
          renderOntologyMap(stage, detail, graph, localState);
        }),
        lensButton(`도착  ${targetLabel}`, () => {
          localState.focusTarget = 'object';
          localState.selectedRelation = null;
          localState.selectedId = relation.target;
          renderOntologyMap(stage, detail, graph, localState);
        }),
      );
      appendChipRow([ontologyRelationLabel(relation.relation), relation.kind]);
      detail.appendChild(el('button', {
        class: 'egd-ontology-copy',
        onclick: () => copyTextToClipboard(`${relation.source} --${relation.relation}-> ${relation.target}`),
      }, '관계 복사'));
      return;
    }
    if (localState.mode === 'focus' && localState.focusTarget === 'pane') {
      const phase = localState.activePane || 'present';
      const phaseLabels = { past: '과거', present: '현재', future: '미래', multiverse: '멀티버스' };
      const inventoryNodes = ontologyPaneInventoryNodes(graph, phase, selected);
      const paneNodeLabel = (node) => ontologyDisplayLabel(node, 'focus').replace(/^[^·]+·\s*/, '');
      const paneDepth = ontologyNormalizeDepth(localState.activeDepth, ontologyDefaultDepthForPane(phase, selected));
      lensHeader();
      detail.appendChild(el('div', { class: 'egd-ontology-detail-title' }, `${phaseLabels[phase] || phase} 시간대`));
      detail.appendChild(el('div', { class: 'egd-ontology-detail-id' }, '선택된 객체'));
      detail.appendChild(selectedLensCard(selected, phaseLabels[phase] || phase));
      lensSection('시간 위치', lensCard(
        el('div', { class: 'egd-ontology-lens-pathline' },
          el('span', { class: phase === 'past' ? 'egd-ontology-lens-dot-active' : '' }, '과거'),
          el('b', {}, '→'),
          el('span', { class: phase === 'present' ? 'egd-ontology-lens-dot-active' : '' }, '현재'),
          el('b', {}, '→'),
          el('span', { class: phase === 'future' ? 'egd-ontology-lens-dot-active' : '' }, '미래'),
        ),
      ));
      lensSection('연결 경로', lensCard(
        el('div', { class: 'egd-ontology-lens-pathline' },
          el('span', {}, '컨텍스트 연결'),
          el('b', {}, '→'),
          el('span', {}, '목표'),
        ),
      ));
      lensSection('관계 정보', lensMetricGrid(
        ['관계 수', phase === 'present' ? '2' : '1'],
        ['경로 길이', phase === 'present' ? '2 홉' : '1 홉'],
        ['경로 유형', '출발 → 도착'],
        ['시간 방향', phase === 'past' ? '과거 → 현재' : phase === 'future' ? '현재 → 미래' : '현재 → 미래'],
      ));
      const selectById = (nodeId) => {
        const node = ontologyNodeById(graph, nodeId);
        if (!node) return;
        localState.focusTarget = 'object';
        localState.selectedId = node.id;
        localState.selectedRelation = null;
        ontologyResetFocusViewport(localState);
        renderOntologyMap(stage, detail, graph, localState);
      };
      lensSection('상위 연결 (위층)',
        lensButton('컨텍스트 연결  →  목표', () => selectById('goal')),
      );
      lensSection('하위 연결 (아래층)',
        lensCard(
          el('div', { class: 'egd-ontology-lens-pathline' },
            el('span', {}, '메시지 전송'),
            el('b', {}, '↓'),
            el('span', {}, '터미널'),
          ),
          el('div', { class: 'egd-ontology-lens-muted' }, '데스크톱 → 터미널 → (CPU / RAM / 디스크)'),
        ),
      );
      lensSection('관련 객체 (동일 층)', lensChipRow({
        virtual: ['컨텍스트 연결', '아젠다', '카드'],
        binding: ['메시지 전송', '터미널'],
        physical: ['세션 파일', '데스크톱', 'CPU / RAM / 디스크'],
      }[paneDepth] || []));
      lensSection('메모', el('textarea', {
        class: 'egd-ontology-lens-memo',
        placeholder: '메모를 입력하세요...',
        rows: 3,
      }));
      return;
    }
    const selectedIdLabel = selected.id === 'goal'
      ? '미래 목표'
      : selected.id?.startsWith('egdesk.')
        ? 'egdesk 개념'
        : relationNodeLabel(selected.id);
    const selectedPhaseLabel = ONTOLOGY_TIME_PANE_LABELS[localState.activePane || ontologyPhaseForNode(selected)] || '현재';
    const outgoingEdges = allEdges.filter((edge) => edge.source === selected.id).slice(0, 4);
    const incomingEdges = allEdges.filter((edge) => edge.target === selected.id).slice(0, 4);
    lensHeader();
    detail.appendChild(el('div', { class: 'egd-ontology-detail-title' }, ontologyDisplayLabel(selected, localState.mode)));
    detail.appendChild(el('div', { class: 'egd-ontology-detail-id' }, selectedIdLabel));
    detail.appendChild(selectedLensCard(selected, selectedPhaseLabel));
    const selectedSummary = selected.id === 'goal'
      ? '현재 시간대의 컨텍스트 연결이 미래 목표로 이어지는 선택 경로입니다. 화면의 보라색 경로가 현재 컨텍스트에서 미래 목표로 가는 시간 간 연결을 보여줍니다.'
      : ONTOLOGY_NODE_SUMMARIES[selected.id] || selected.summary || '아직 요약이 없습니다.';
    lensSection('시간 위치', lensCard(
      el('div', { class: 'egd-ontology-lens-pathline' },
        el('span', {}, '과거'),
        el('b', {}, '→'),
        el('span', { class: (localState.activePane || ontologyPhaseForNode(selected)) === 'present' ? 'egd-ontology-lens-dot-active' : '' }, '현재'),
        el('b', {}, '→'),
        el('span', { class: selected.id === 'goal' || localState.activePane === 'future' ? 'egd-ontology-lens-dot-active' : '' }, '미래'),
      ),
    ));
    if (selected.id === 'goal') {
      lensSection('선택 경로', lensCard(
        el('div', { class: 'egd-ontology-lens-pathline' },
          el('span', {}, '컨텍스트 연결'),
          el('b', {}, '→'),
          el('span', {}, '목표'),
        ),
      ));
    }
    lensSection('관계 정보', lensMetricGrid(
      ['나가는 관계', String(outgoingEdges.length)],
      ['들어오는 관계', String(incomingEdges.length)],
      ['시간 위치', selectedPhaseLabel],
    ));
    detail.appendChild(el('p', { class: 'egd-ontology-summary' }, selectedSummary));
    const aliasLine = ontologyAliasLine(selected);
    const abbreviationLines = ontologyAbbreviationLines(selected);
    if (aliasLine || abbreviationLines.length) {
      const nameMetadata = el('div', { class: 'egd-ontology-relation-list' },
        el('div', { class: 'egd-ontology-detail-subtitle' }, '이름 메타데이터'),
      );
      if (aliasLine) nameMetadata.appendChild(el('div', { class: 'egd-ontology-path' }, `별칭: ${aliasLine}`));
      for (const line of abbreviationLines) {
        nameMetadata.appendChild(el('div', { class: 'egd-ontology-path' }, `약어: ${line}`));
      }
      detail.appendChild(nameMetadata);
    }
    if (selected.path) detail.appendChild(el('div', { class: 'egd-ontology-path' }, selected.path));

    const canonicalId = ontologyCanonicalIdForNode(graph, selected);
    const projectionNodes = ontologyProjectionNodesForCanonical(graph, canonicalId);
    if (canonicalId && projectionNodes.length) {
      const rail = el('div', { class: 'egd-ontology-identity-rail' },
        el('div', { class: 'egd-ontology-detail-subtitle' }, '정체성 레일'),
        el('button', {
          class: 'egd-ontology-rail-item' + (selected.id === canonicalId ? ' egd-ontology-rail-item-active' : ''),
        onclick: () => {
          localState.selectedId = canonicalId;
          localState.selectedRelation = null;
          ontologyResetFocusViewport(localState);
          renderOntologyMap(stage, detail, graph, localState);
        },
      },
          el('span', { class: 'egd-ontology-rail-facet' }, '정체성'),
          el('span', { class: 'egd-ontology-rail-label' }, ontologyDisplayLabel(ontologyNodeById(graph, canonicalId), 'focus')),
        ),
      );
      for (const projection of projectionNodes) {
        const facet = ontologyProjectionFacet(projection.id);
        rail.appendChild(el('button', {
          class: 'egd-ontology-rail-item' + (selected.id === projection.id ? ' egd-ontology-rail-item-active' : ''),
          onclick: () => {
            localState.selectedId = projection.id;
            localState.selectedRelation = null;
            ontologyResetFocusViewport(localState);
            renderOntologyMap(stage, detail, graph, localState);
          },
        },
          el('span', { class: 'egd-ontology-rail-facet' }, ONTOLOGY_FACET_LABELS[facet] || 'Facet'),
          el('span', { class: 'egd-ontology-rail-label' }, ontologyProjectionLabel(projection).replace(/^[^·]+·\s*/, '')),
        ));
      }
      detail.appendChild(rail);
    }

    const relationList = el('div', { class: 'egd-ontology-relation-list' });
    relationList.appendChild(el('div', { class: 'egd-ontology-detail-subtitle' }, '나가는 관계'));
    for (const edge of allEdges.filter((edge) => edge.source === selected.id).slice(0, 12)) {
      relationList.appendChild(el('button', {
        class: 'egd-ontology-relation',
        onclick: () => {
          localState.selectedId = edge.target;
          localState.selectedRelation = null;
          ontologyResetFocusViewport(localState);
          renderOntologyMap(stage, detail, graph, localState);
        },
      }, `${ontologyRelationLabel(edge.relation)} → ${relationNodeLabel(edge.target)}`));
    }
    relationList.appendChild(el('div', { class: 'egd-ontology-detail-subtitle' }, '들어오는 관계'));
    for (const edge of allEdges.filter((edge) => edge.target === selected.id).slice(0, 12)) {
      relationList.appendChild(el('button', {
        class: 'egd-ontology-relation',
        onclick: () => {
          localState.selectedId = edge.source;
          localState.selectedRelation = null;
          ontologyResetFocusViewport(localState);
          renderOntologyMap(stage, detail, graph, localState);
        },
      }, `${relationNodeLabel(edge.source)} → ${ontologyRelationLabel(edge.relation)}`));
    }
    detail.appendChild(relationList);

    detail.appendChild(el('button', {
      class: 'egd-ontology-copy',
      onclick: () => copyTextToClipboard(ontologyContextBundle(graph, selected.id)),
    }, '선택 관계 복사'));
  }

  async function loadOntologyGraph() {
    const response = await fetch(ONTOLOGY_GRAPH_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Ontology graph load failed: ${response.status}`);
    return response.json();
  }

  function spawnOntologyMapCard(initialState = {}) {
    const sourceRef = singletonSourceRef('ontology-map', {
      kind: 'ontology-map',
      path: 'ontology/index.md',
      openMode: 'interactive',
    });
    const existing = focusOpenSourceCard(sourceRef);
    if (existing) return existing;

    const id = `egd-ontology-card-${++cardSeq}`;
    const initialWidth = Math.min(1760, Math.max(1180, window.innerWidth - 40));
    const initialHeight = Math.min(980, Math.max(720, window.innerHeight - 40));
    const offset = ((cardSeq - 1) % 6) * 24;
    const topLeft = viewportToCanvasPoint(20 + offset, 20 + offset);
    const initialTop = Math.max(20, Math.round(topLeft.y));
    const card = el('div', {
      id,
      class: 'egd-canvas-card egd-ontology-card',
      style: {
        top: initialTop + 'px',
        left: Math.round(topLeft.x) + 'px',
        width: initialWidth + 'px',
        height: initialHeight + 'px',
        zIndex: String(++cardZ),
      },
    });

    const initialSelectedId = initialState.selectedId || 'entity.llm_chat_session';
    const initialPane = initialState.activePane || 'present';
    const localState = {
      mode: 'focus',
      selectedId: initialSelectedId,
      focusTarget: initialState.focusTarget || 'pane',
      activePane: initialPane,
      activeDepth: ontologyNormalizeDepth(
        initialState.activeDepth,
        ontologyDefaultDepthForPane(initialPane, { id: initialSelectedId }),
      ),
      pan: initialState.pan || { x: 0, y: 0 },
      paneSlides: initialState.paneSlides || {},
      zoom: Number.isFinite(initialState.zoom) ? initialState.zoom : 1,
      tilt: 0,
    };
    card._ontologyState = localState;

    let cleanup = () => {};
    let stage;
    let detail;
    card._ontologyRender = () => {
      if (stage && detail && card._ontologyGraph) renderOntologyMap(stage, detail, card._ontologyGraph, localState);
    };
    card._ontologyApplyWheelDelta = (deltaX = 0, deltaY = 0, modifiers = {}) => {
      ontologyHandleSemanticWheel(localState, {
        deltaX,
        deltaY,
        ctrlKey: !!modifiers.ctrlKey,
        metaKey: !!modifiers.metaKey,
      });
      if (stage && detail && card._ontologyGraph) renderOntologyMap(stage, detail, card._ontologyGraph, localState);
      return {
        activePane: localState.activePane,
        activeDepth: localState.activeDepth,
        paneSlides: localState.paneSlides,
        zoom: localState.zoom,
      };
    };
    const header = el('div', { class: 'egd-card-header egd-ontology-header' },
      el('div', { class: 'egd-card-topbar' },
        el('div', { class: 'egd-card-dots-shell' },
          el('div', { class: 'egd-card-dots' },
            el('span', { class: 'egd-card-dot egd-card-dot-close', onclick: (ev) => { ev.stopPropagation(); closeCanvasCard(card, cleanup); } }),
            el('span', { class: 'egd-card-dot egd-card-dot-min' }),
            el('span', { class: 'egd-card-dot egd-card-dot-max' }),
          ),
        ),
        el('div', { class: 'egd-ontology-title' }, '온톨로지 맵'),
        el('div', { class: 'egd-ontology-search-shell' },
          el('span', { class: 'egd-ontology-search-icon' }, '⌕'),
          el('input', {
            class: 'egd-ontology-search',
            type: 'search',
            placeholder: '객체, 관계, 태그 검색... (⌘K)',
            onmousedown: (ev) => ev.stopPropagation(),
            onclick: (ev) => ev.stopPropagation(),
          }),
        ),
        el('div', { class: 'egd-ontology-header-actions' },
          el('button', { class: 'egd-ontology-header-icon', title: '렌즈' }, '⌘'),
          el('button', { class: 'egd-ontology-header-icon', title: '알림' }, '⌁'),
          el('button', { class: 'egd-ontology-header-icon egd-ontology-header-badged', title: '상태' }, '▣'),
          el('div', { class: 'egd-ontology-avatar' }, 'M'),
        ),
      ),
    );

    stage = el('div', {
      class: 'egd-ontology-stage',
      tabindex: '0',
      'aria-label': 'EG-Desk ontology interaction canvas',
    },
      el('div', { class: 'egd-ontology-loading' }, '온톨로지 그래프를 불러오는 중...'),
    );
    detail = el('aside', { class: 'egd-ontology-detail' });
    const body = el('div', { class: 'egd-card-body egd-ontology-body' }, stage, detail);
    card.appendChild(header);
    card.appendChild(body);

    const host = document.getElementById('egd-canvas-layer') || document.documentElement;
    host.appendChild(card);
    bindCardSourceRef(card, sourceRef);
    markAgendaDirty('create-ontology-card', card);
    setActiveEntity(card);

    let drag = null;
    let paneSlideDrag = null;
    header.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('input, button, .egd-card-dot')) return;
      if (isCardFullscreen(card)) return;
      focusCanvasCard(card);
      drag = { x: ev.clientX, y: ev.clientY, left: card.offsetLeft, top: card.offsetTop };
      ev.preventDefault();
    });
    installCardHeaderFullscreenToggle(card, header);
    stage.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('.egd-ontology-node')) return;
      focusCanvasCard(card);
      stage.focus({ preventScroll: true });
      const phase = localState.activePane || 'present';
      const depth = ontologyNormalizeDepth(localState.activeDepth);
      paneSlideDrag = {
        x: ev.clientX,
        y: ev.clientY,
        phase,
        depth,
        slide: ontologyPaneSlide(localState, phase, depth),
        geometry: ontologyPaneSurfaceGeometry(
          card._ontologyGraph,
          ontologyNodeById(card._ontologyGraph, localState.selectedId),
          localState,
          phase,
          depth,
        ),
      };
      ev.preventDefault();
      ev.stopPropagation();
    });
    stage.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ontologyHandleSemanticWheel(localState, ev);
      if (card._ontologyGraph) renderOntologyMap(stage, detail, card._ontologyGraph, localState);
    }, { capture: true, passive: false });
    body.addEventListener('wheel', (ev) => {
      if (!stage.contains(ev.target)) ev.stopPropagation();
    }, { capture: true, passive: false });
    stage.addEventListener('keydown', (ev) => {
      let handled = true;
      if (ev.key === 'ArrowLeft') {
        ontologySetPane(localState, ontologyShiftPane(localState.activePane || 'present', -1));
      } else if (ev.key === 'ArrowRight') {
        ontologySetPane(localState, ontologyShiftPane(localState.activePane || 'present', 1));
      } else if (ev.key === 'ArrowUp') {
        ontologySetDepth(localState, ontologyShiftDepth(localState.activeDepth, -1));
      } else if (ev.key === 'ArrowDown') {
        ontologySetDepth(localState, ontologyShiftDepth(localState.activeDepth, 1));
      } else if (ev.key === '0') {
        ontologyResetFocusViewport(localState);
      } else {
        handled = false;
      }
      if (!handled) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (card._ontologyGraph) renderOntologyMap(stage, detail, card._ontologyGraph, localState);
    });

    const onMove = (ev) => {
      const s = canvasZoom();
      if (drag) {
        card.style.left = (drag.left + (ev.clientX - drag.x) / s) + 'px';
        card.style.top = (drag.top + (ev.clientY - drag.y) / s) + 'px';
        return;
      }
      if (paneSlideDrag) {
        const surfaceDelta = ontologyProjectPaneDragDelta(
          (ev.clientX - paneSlideDrag.x) / s,
          (ev.clientY - paneSlideDrag.y) / s,
          paneSlideDrag.geometry,
        );
        ontologySetPaneSlide(localState, paneSlideDrag.phase, paneSlideDrag.depth, {
          u: paneSlideDrag.slide.u + surfaceDelta.u,
          v: paneSlideDrag.slide.v + surfaceDelta.v,
        });
        if (card._ontologyGraph) renderOntologyMap(stage, detail, card._ontologyGraph, localState);
      }
    };
    const onUp = () => {
      if (drag) markAgendaDirty('move-ontology-card', card);
      drag = null;
      paneSlideDrag = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (state.activeEntityId === card.id) setActiveEntity(null);
    };
    card._cleanup = cleanup;

    loadOntologyGraph()
      .then((graph) => {
        card._ontologyGraph = graph;
        renderOntologyMap(stage, detail, graph, localState);
      })
      .catch((error) => {
        stage.textContent = '';
        stage.appendChild(el('div', { class: 'egd-ontology-error' }, `온톨로지 그래프 로드 실패: ${error.message || String(error)}`));
      });

    return card;
  }

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
    const browserAgentNotifications = (options = {}) => {
      return browserAgentHistory(options)
        .map((entry) => entry?.notification)
        .filter(Boolean);
    };
    const clearBrowserAgentHistory = () => {
      const removed = agentActionHistory.length;
      agentActionHistory.length = 0;
      return { cardId: card.id, removed };
    };
    const browserAgentActionType = (action = {}) => String(action.type || action.action || 'snapshot');
    const browserAgentElementText = (item) => {
      if (!item) return '';
      const role = item.role || item.tag || 'element';
      const label = item.label ? ` "${compactAgentText(item.label, 72)}"` : '';
      const value = item.value ? ` value "${compactAgentText(item.value, 72)}"` : '';
      return `${role}${label}${value}`.trim();
    };
    const browserAgentListText = (items = [], itemText = (item) => item, limit = 3) => {
      const values = (items || []).map(itemText).filter(Boolean).slice(0, limit);
      if (!values.length) return '';
      const remaining = Math.max(0, items.length - values.length);
      return remaining ? `${values.join(', ')} +${remaining}` : values.join(', ');
    };
    const browserAgentObservationChanged = (observation = {}) => {
      return !!(
        observation.urlChanged
        || observation.titleChanged
        || observation.visibleTextChanged
        || observation.interactiveChanged
        || observation.focusedElementChanged
        || (observation.newVisibleText || []).length
        || (observation.removedVisibleText || []).length
        || (observation.newInteractiveElements || []).length
        || (observation.removedInteractiveElements || []).length
      );
    };
    const browserAgentObservationSummary = (observation = {}) => {
      const parts = [];
      if (observation.urlChanged) parts.push(`URL changed to ${compactAgentText(observation.url || 'unknown', 120)}`);
      if (observation.titleChanged) parts.push(`title changed to "${compactAgentText(observation.title || '', 120)}"`);
      const newText = browserAgentListText(observation.newVisibleText || [], (item) => `"${compactAgentText(item, 90)}"`);
      if (newText) parts.push(`new visible text: ${newText}`);
      const removedText = browserAgentListText(observation.removedVisibleText || [], (item) => `"${compactAgentText(item, 90)}"`);
      if (removedText) parts.push(`removed visible text: ${removedText}`);
      const newControls = browserAgentListText(observation.newInteractiveElements || [], browserAgentElementText);
      if (newControls) parts.push(`new controls: ${newControls}`);
      const removedControls = browserAgentListText(observation.removedInteractiveElements || [], browserAgentElementText);
      if (removedControls) parts.push(`removed controls: ${removedControls}`);
      const focus = browserAgentElementText(observation.focusedElement);
      if (focus && observation.focusedElementChanged) parts.push(`focus: ${focus}`);
      if (!parts.length) return 'No meaningful DOM, text, control, or focus change detected.';
      return compactAgentText(parts.join('; '), 520);
    };
    const browserAgentNotificationFor = (payload = {}, meta = {}) => {
      const observation = payload?.observation || {};
      const action = payload?.action || meta.action || {};
      const after = payload?.after || {};
      const before = payload?.before || {};
      const focusedElementChanged = typeof observation.focusedElementChanged === 'boolean'
        ? observation.focusedElementChanged
        : agentElementSignature(before.focusedElement || {}) !== agentElementSignature(after.focusedElement || {});
      const normalizedObservation = {
        ...observation,
        focusedElementChanged,
      };
      return {
        type: 'browser-dom-change',
        cardId: card.id,
        actionType: browserAgentActionType(action),
        source: meta.source || 'unknown',
        ok: !!payload?.ok,
        changed: browserAgentObservationChanged(normalizedObservation),
        summary: browserAgentObservationSummary(normalizedObservation),
        url: normalizedObservation.url || after.url || before.url || browserState.uri,
        title: normalizedObservation.title || after.title || before.title || readBrowserTitle(),
        changes: {
          urlChanged: !!normalizedObservation.urlChanged,
          titleChanged: !!normalizedObservation.titleChanged,
          visibleTextChanged: !!normalizedObservation.visibleTextChanged,
          interactiveChanged: !!normalizedObservation.interactiveChanged,
          focusedElementChanged: !!normalizedObservation.focusedElementChanged,
          newVisibleText: cloneBrowserAgentPayload((normalizedObservation.newVisibleText || []).slice(0, 8)),
          removedVisibleText: cloneBrowserAgentPayload((normalizedObservation.removedVisibleText || []).slice(0, 8)),
          newInteractiveElements: cloneBrowserAgentPayload((normalizedObservation.newInteractiveElements || []).slice(0, 8)),
          removedInteractiveElements: cloneBrowserAgentPayload((normalizedObservation.removedInteractiveElements || []).slice(0, 8)),
          focusedElement: cloneBrowserAgentPayload(normalizedObservation.focusedElement || null),
        },
      };
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
      const notification = browserAgentNotificationFor(payload, meta);
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
        notification: cloneBrowserAgentPayload(notification),
      };
      if (meta.record !== false) recordBrowserAgentAction(entry);
      return {
        ...payload,
        notification: cloneBrowserAgentPayload(notification),
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
            focusedElementChanged: signature(before?.focusedElement || {}) !== signature(after?.focusedElement || {}),
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
        focusedElementChanged: agentElementSignature(before?.focusedElement || {}) !== agentElementSignature(after?.focusedElement || {}),
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
      agentNotifications: browserAgentNotifications,
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
      if (ev.target instanceof Element && ev.target.closest('.egd-ontology-stage')) {
        return;
      }
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
          openOntologyMapCard: spawnOntologyMapCard,
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
          agentNotifications: (cardOrId, options = {}) => browserCardControl(cardOrId, 'agentNotifications', options),
          agentClearHistory: (cardOrId) => browserCardControl(cardOrId, 'agentClearHistory'),
          agentDebug: (cardOrId) => browserCardControl(cardOrId, 'agentDebug'),
        },
        browserAgent: {
          snapshot: (cardOrId, options = {}) => browserCardControl(cardOrId, 'agentSnapshot', options),
          act: (cardOrId, action = {}, options = {}) => browserCardControl(cardOrId, 'agentAct', action, options),
          history: (cardOrId, options = {}) => browserCardControl(cardOrId, 'agentHistory', options),
          notifications: (cardOrId, options = {}) => browserCardControl(cardOrId, 'agentNotifications', options),
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
      window.addEventListener('resize', syncHudViewportFit);
      installPopupCapture();
      console.warn(TAG, 'ready ✅');
    } catch (err) {
      console.error(TAG, 'boot failed:', err, err.stack);
    }
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
})();
