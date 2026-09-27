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
  const SurfaceState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskSurfaceState.sys.mjs');
  const RecoveryState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskRecoveryState.sys.mjs');
  const ChatState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
  const Markdown = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskMarkdown.sys.mjs');
  const InputContext = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskInputContext.sys.mjs');
  const BriefingState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskBriefingState.sys.mjs');
  const FileCardState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskFileCardState.sys.mjs');
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
          },
          allFrames: false,
          // Remote types match prefixes: web includes Fission's webIsolated=…
          // and webCOOP+COEP family. The parent exposes no child-call handlers;
          // queries originate only from the selected Card's WindowGlobal.
          remoteTypes: ['web', 'file'],
          safeForUntrustedWebProcess: true,
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
    // 아이콘 규칙: 모노크롬 텍스트 글리프. 이모지 기본표시(컬러) 코드포인트는
    // ︎(VS15)로 텍스트 표시 강제 — macOS Firefox chrome에서 렌더 실측 완료.
    { id: 'chat',     label: '채팅',    icon: '🗨︎' },
    { id: 'shelf',    label: '파일',    icon: '▤' },
    { id: 'ontology', label: '온톨로지', icon: '❖' },
    { id: 'browser',  label: '브라우저', icon: '🌐︎' },
    { id: 'ide',      label: 'IDE',     icon: '<>' },
    { id: 'terminal', label: '터미널',  icon: '>_' },
    { id: 'settings', label: '설정',   icon: '⚙' },
    { id: 'create',   label: '추가',      icon: '+' },
  ];
  const DOCK_CENTER = [
    { id: 'pencil',   label: '펜',  icon: '✎' },
    { id: 'hand',     label: '손',    icon: '✥' },
    { id: 'square',   label: '사각형',  icon: '□' },
    { id: 'ellipse',  label: '원',      icon: '○' },
    { id: 'line',     label: '선',      icon: '╱' },
    { id: 'arrow',    label: '선택',   icon: '↖', active: true },
  ];
  const DOCK_RIGHT = [
    { id: 'trash',    label: '휴지통',   icon: '🗑︎' },
  ];

  const SELF_MEMBER = '나';
  const THREAD_KIND_META = {
    dm: {
      label: 'Codex',
      longLabel: 'Codex 대화',
      createTitle: '새 Codex 대화',
      emptyPreview: '아직 메시지가 없습니다',
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
    if (thread?.profileEnabled !== true) return { id: null, label: 'Codex', name: 'Codex', category: 'conversation', summary: '', capabilities: [], systemPrompt: null, toolMode: null };
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
      ...(thread?.cwd !== undefined ? { cwd: thread.cwd } : {}),
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
    if (ChatState.nativeBindingHeld(thread)) return 'Local';
    return thread?.conversationId ? 'Resumed' : 'Fresh';
  }

  function chatBindingNonce() {
    return window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
    if (thread.profileEnabled !== true) return `Codex · ${codexThreadSessionLabel(thread)}`;
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
    const profileEnabled = options.profileEnabled === true;
    const agentProfileId = profileEnabled ? normalizeCodexAgentProfileId(
      options.agentProfileId,
      DEFAULT_CODEX_AGENT_PROFILE_ID
    ) : null;
    const agentProfile = codexAgentProfile(agentProfileId);
    const safeSubtitle = subtitle || buildThreadSubtitle(type, participants);
    return {
      id: `thread-${type}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      title,
      subtitle: safeSubtitle,
      participants,
      participantRoles,
      profileEnabled,
      agentProfileId,
      toolMode: profileEnabled ? options.toolMode || agentProfile.toolMode : null,
      systemPrompt: profileEnabled ? options.systemPrompt || agentProfile.systemPrompt : null,
      pinned: Boolean(options.pinned),
      conversationId: null,
      messages: [],
      unreadCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function defaultCodexThreads() {
    return [createCodexThread('dm', 'Codex', '', { participants: [SELF_MEMBER, 'Codex'], pinned: true })];
  }

  const state = {
    surface: { mode: 'desk', browserCardId: null, restoring: false },
    boards: { projections: {}, activeProjectionId: null },
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
      activeTitle: 'EG-Desk',
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
      hudView: 'conversation',
      memberMenu: null,
      threadMenu: null,
      draft: '',
      threadDrafts: {},
      threadDraftRevisions: {},
      liveRevision: 0,
      loginLog: '',
      error: null,
      isSending: false,
      isStartingLogin: false,
      connected: false,
      lastBridgeLatency: null,
      showDiagnostics: false,
      chatProtocol: ChatState.createChatProtocolState(),
      localHistoryStatus: 'idle',
      localHistoryError: null,
      localHistoryBootReady: false,
      legacyChatBackupKey: null,
      legacyChatBackupRequired: false,
      activityThreadId: null,
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

  function codexMessageAuthorLabel(message) {
    const name = message?.authorName || message?.author;
    return typeof name === 'string' && name.trim()
      ? name.trim()
      : codexMessageRoleLabel(message?.role);
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
    return { text: String(message?.content || ''), links: (message?.artifacts || []).filter(ChatState.usableArtifact) };
  }

  function openChatFileReference(reference) {
    const path = reference?.target?.path;
    if (reference?.type !== 'file' || typeof path !== 'string' || !path.startsWith('/')) return false;
    const file = railSearchNsFileFromPath(path);
    try {
      if (!file?.exists?.()) throw new Error('missing');
    } catch { boardNotice('참조된 파일을 열 수 없습니다. 경로와 접근 권한을 확인해 주세요.'); return false; }
    const card = spawnBrowserCard(railSearchPathToFileUrl(path), { openMode: 'focus-existing' });
    focusCanvasCard(card);
    return card;
  }

  function openCodexResultLink(link) {
    if (!ChatState.usableArtifact(link)) return false;
    return openChatFileReference(link);
  }

  function buildCodexResultChips(message, thread, links) {
    if (ChatState.nativeBindingHeld(thread)) return null;
    const artifacts = (links || []).filter(ChatState.usableArtifact);
    if (!artifacts.length) return null;
    return el('div', { class: 'egd-codex-result-chips' }, ...artifacts.map(artifact => el('button', {
      class: 'egd-codex-result-chip egd-codex-result-chip-file', type: 'button',
      'aria-label': `참조된 파일 열기: ${artifact.label || artifact.target.path.split('/').pop()}`,
      title: `참조된 기존 파일 · ${artifact.target.path}`,
      data: { testid: 'chat-artifact', artifactId: artifact.id, answerId: artifact.answerId, runId: artifact.runId },
      onclick: ev => { ev.preventDefault(); ev.stopPropagation(); openCodexResultLink(artifact); },
    }, el('span', { class: 'egd-codex-result-label' }, artifact.label || artifact.target.path.split('/').pop()),
    el('span', { 'aria-hidden': 'true', class: 'egd-codex-result-arrow' }, '↗'))));
  }

  function codexRuns(thread) {
    return ChatState.runsForThread(state.codex.chatProtocol, thread);
  }

  function codexCurrentRun(thread) {
    const runs = codexRuns(thread);
    return runs.findLast(ChatState.isRunBusy) || runs.at(-1) || null;
  }

  function codexRunLabel(run) {
    if (!run) return '대화 준비';
    if (run.localHistory === true && !['completed', 'interrupted', 'failed', 'cancelled', 'unavailable'].includes(run.status)) return '지난 실행 · 현재 상태 미확인';
    if (ChatState.isRunBusy(run) && !state.codex.connected) return '연결 끊김 · 실행 상태 확인 필요';
    if (run.status === 'interrupted') return '중지됨';
    if (run.status === 'failed' || run.status === 'unavailable') return '실행 실패';
    if (run.status === 'completed') return '완료';
    if (run.stopRequested || run.status === 'stopping') return '중지 요청됨 · 확인 중';
    if (run.pendingApprovals?.length) return '승인 대기';
    return '응답 중';
  }

  function openCodexActivityPanel(threadId) {
    state.codex.activityThreadId = threadId;
    renderCodexActivityPanel();
  }

  function chatInputSourceForView(view) {
    if (!view?.isConnected || view.dataset.codexRole === 'auth' || view.classList.contains('egd-chat-card')) return null;
    const base = { id: `input-${chatBindingNonce()}`, label: cardLabelForViewportRail(view) || view.id,
      sourceRef: { viewId: view.id, boardId: state.boards.projections[view.dataset.projectionId]?.boardId || null } };
    if (view.classList.contains('egd-file-card')) {
      const current = view._fileView?.snapshot?.();
      if (!current?.fileId || !current?.draftId) return null;
      const name = view.querySelector('.egdesk-file-title')?.textContent?.trim() || '파일';
      return { ...base, kind: 'file', label: `${name} · 작업사본`,
        sourceRef: { ...base.sourceRef, fileId: current.fileId, draftId: current.draftId } };
    }
    if (view.classList.contains('egd-browser-card')) {
      const browser = browserCardState(view);
      if (!browser?.uri) return null;
      if (browser.uri.startsWith('file:')) {
        try {
          const file = servicesRef().io.newURI(browser.uri).QueryInterface(Ci.nsIFileURL).file;
          return { ...base, kind: 'file', label: file.leafName, sourceRef: { ...base.sourceRef, path: file.path } };
        } catch { return null; }
      }
      return { ...base, kind: 'browser', sourceRef: { ...base.sourceRef, uri: browser.uri } };
    }
    if (view.classList.contains('egd-canvas-shape')) return { ...base, kind: 'board-element' };
    return null;
  }

  function chatInputSources(viewIds) {
    return (viewIds || []).map(id => chatInputSourceForView(document.getElementById(id))).filter(Boolean);
  }

  async function captureManagedFileInput(source) {
    const { viewId, fileId, draftId } = source.sourceRef || {};
    const card = viewId && document.getElementById(viewId);
    if (!fileId || !draftId || !card?.isConnected || !card.classList.contains('egd-file-card')) {
      throw new Error('첨부한 파일 작업 창이 닫혔습니다. 현재 작업사본을 다시 선택해 주세요.');
    }
    await card._fileReady;
    const view = card._fileView;
    const current = view?.snapshot?.();
    if (!card.isConnected || typeof view?.captureRef !== 'function' || current?.fileId !== fileId || current?.draftId !== draftId) {
      throw new Error('파일 작업 창에서 다른 작업사본을 열었습니다. 현재 파일을 다시 첨부해 주세요.');
    }
    const captureRef = await view.captureRef();
    const after = view.snapshot();
    if (!card.isConnected || after?.fileId !== fileId || after?.draftId !== draftId
        || captureRef?.fileId !== fileId || captureRef?.draftId !== draftId) {
      throw new Error('작업사본이 캡처 중 바뀌었습니다. 다시 첨부해 주세요.');
    }
    return captureRef;
  }

  function captureChatInputs(sources) {
    return InputContext.captureInputSources(sources, {
      browser: async source => {
        // Do not use resolveBrowserCard's convenience fallback for a bound input.
        const card = document.getElementById(source.sourceRef.viewId);
        if (!card?.isConnected || !card._browserControls?.captureInput) throw new Error('첨부한 Browser가 닫혔습니다. 다시 연결하거나 제거해 주세요.');
        const capture = await card._browserControls.captureInput();
        return { ...capture, executionContext: { geometry: persistentEntityGeometry(card) } };
      },
      'board-element': source => {
        const view = document.getElementById(source.sourceRef.viewId);
        if (!view?.isConnected || !view.classList.contains('egd-canvas-shape')) throw new Error('첨부한 요소를 찾을 수 없습니다.');
        const record = serializeShapeState(view);
        return { text: JSON.stringify(record), mime: 'application/json', boundary: 'selected Canvas shape record',
          executionContext: { geometry: persistentEntityGeometry(view) } };
      },
    }, { nextId: () => `capture-${chatBindingNonce()}` });
  }

  function openChatInputPanel(threadId, { viewIds = null, snapshots = null } = {}) {
    const thread = getCodexThreadById(state.codex, threadId);
    if (!thread) return;
    document.getElementById('egd-codex-input-panel')?.remove();
    const panel = el('section', { id: 'egd-codex-input-panel', role: 'dialog', 'aria-label': snapshots ? '당시 입력 캡처' : 'Chat에 자료 첨부',
      data: { testid: 'chat-input-panel', threadId } });
    const close = () => { state.codex.inputInspectNonce = (state.codex.inputInspectNonce || 0) + 1; panel.remove(); };
    panel.addEventListener('mousedown', event => event.stopPropagation());
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
    panel.appendChild(el('header', {}, el('strong', {}, snapshots ? '당시 입력 캡처' : `${thread.title} · 자료 첨부`),
      el('button', { 'aria-label': '첨부 패널 닫기', onclick: close }, '닫기')));
    const body = el('div', { class: 'egd-codex-input-panel-body' });
    panel.appendChild(body);
    if (snapshots) {
      for (const snapshot of snapshots) body.appendChild(InputContext.inputSnapshotView(document, snapshot));
    } else {
      body.appendChild(el('p', {}, '선택한 자료만 다음 메시지에 첨부합니다. 선택만으로 전송하거나 실행하지 않습니다.'));
      const selected = new Set(viewIds || Array.from(document.querySelectorAll('.egd-entity-selected')).map(view => view.id));
      const sources = chatInputSources(Array.from(document.querySelectorAll('.egd-browser-card, .egd-canvas-shape, .egd-file-card')).map(view => view.id));
      const unavailable = [...selected].filter(id => !sources.some(source => source.sourceRef.viewId === id));
      if (unavailable.length) body.appendChild(el('p', { role: 'status' }, `선택한 요소 중 ${unavailable.length}개는 현재 캡처를 지원하지 않습니다. 아래에 표시된 자료만 첨부됩니다.`));
      const picked = new Map();
      for (const source of sources) {
        const checked = selected.has(source.sourceRef.viewId);
        const input = el('input', { type: 'checkbox', 'aria-label': `첨부 선택: ${source.label}`, data: { testid: 'chat-attach-source', viewId: source.sourceRef.viewId } });
        input.checked = checked;
        if (checked) picked.set(source.id, source);
        input.addEventListener('change', () => input.checked ? picked.set(source.id, source) : picked.delete(source.id));
        body.appendChild(el('label', { class: 'egd-input-source-choice' }, input,
          el('span', {}, source.label, el('small', {}, InputContext.inputSourceLocation(source)))));
      }
      if (!sources.length) body.appendChild(el('p', {}, '열린 Browser, 작업사본 또는 선택 가능한 Canvas 요소가 없습니다. 파일을 선택할 수 있습니다.'));
      body.appendChild(el('button', { 'aria-label': '로컬 파일 선택', data: { testid: 'chat-attach-file' }, onclick: async () => {
        const picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
        picker.init(window.browsingContext, 'Chat에 첨부할 파일', Ci.nsIFilePicker.modeOpenMultiple);
        picker.appendFilters(Ci.nsIFilePicker.filterAll);
        picker.open(result => {
          if (result !== Ci.nsIFilePicker.returnOK || !panel.isConnected) return;
          const files = picker.files;
          const additions = [];
          while (files.hasMoreElements()) {
            const file = files.getNext().QueryInterface(Ci.nsIFile);
            additions.push({ id: `input-${chatBindingNonce()}`, kind: 'file', label: file.leafName, sourceRef: { path: file.path }, size: file.fileSize });
          }
          state.codexBridge.addInputSources(threadId, additions);
          close();
        });
      } }, '파일 선택…'));
      body.appendChild(el('button', { 'aria-label': '선택한 자료를 Chat 초안에 첨부', data: { testid: 'chat-attach-confirm' }, onclick: () => {
        state.codexBridge.addInputSources(threadId, [...picked.values()]); close();
      } }, '선택 항목 첨부'));
    }
    document.documentElement.appendChild(panel);
    panel.querySelector('button')?.focus();
  }

  function buildChatInputTray(thread, bridge) {
    const tray = el('div', { class: 'egd-chat-input-tray', data: { testid: 'chat-attachments', threadId: thread.id } });
    tray.appendChild(el('button', { type: 'button', 'aria-label': '자료 첨부', data: { testid: 'chat-attach-open' }, onclick: () => openChatInputPanel(thread.id) }, '＋ 첨부'));
    for (const source of thread.inputSources || []) {
      tray.appendChild(el('div', { class: 'egd-chat-input-chip', data: { testid: 'chat-attachment', sourceId: source.id } },
        el('button', { type: 'button', title: InputContext.inputSourceLocation(source), 'aria-label': `첨부 내용 확인: ${source.label}`,
          data: { testid: 'chat-attachment-inspect' }, onclick: async () => {
            try {
              const refs = await bridge.captureInputs(thread.id, [source]);
              if (refs?.length) await bridge.inspectInput(thread.id, refs[0]);
            }
            catch (error) { boardNotice(error.message); }
          } }, `${source.label} · 미전송`),
        el('button', { type: 'button', 'aria-label': `첨부 제거: ${source.label}`, data: { testid: 'chat-attachment-remove' },
          onclick: () => bridge.removeInputSource(thread.id, source.id) }, '×')));
    }
    for (const reference of thread.briefingInputs || []) {
      tray.appendChild(el('div', { class: 'egd-chat-input-chip', data: { testid: 'chat-briefing-input', sourceId: reference.sourceId } },
        el('button', { type: 'button', 'aria-label': '브리핑의 고정 근거 확인', onclick: () => bridge.inspectInput(thread.id, reference) }, '브리핑 근거 · 미전송'),
        el('button', { type: 'button', 'aria-label': '브리핑 근거 첨부 제거', onclick: () => bridge.removeBriefingInput(thread.id, reference.sourceId) }, '×')));
    }
    return tray;
  }

  function briefingResolvedTargets(session, step = BriefingState.currentBriefingStep(session)) {
    const views = Array.from(document.querySelectorAll('.egd-input-evidence-card')).map(card => ({
      id: card.id, sourceId: card._inputReference?.sourceId, hash: card._inputReference?.hash,
      evidenceKey: InputContext.inputEvidenceKey(card._inputReference),
      geometry: persistentEntityGeometry(card), sourceMatches: !!card._inputEvidenceLoaded, revisionMatches: !!card._inputEvidenceLoaded,
    }));
    return BriefingState.resolveBriefingTargets(step, { references: session.references, artifacts: session.artifacts, views, identity: session.identity });
  }

  function fitBriefingTargets(resolved) {
    const bounds = BriefingState.briefingBounds(resolved);
    if (!bounds) return false;
    const safe = safeViewportRect({ margin: 28 });
    const panelTop = document.getElementById('egd-answer-briefing')?.getBoundingClientRect().top;
    if (panelTop > safe.top + 180) { safe.bottom = Math.min(safe.bottom, panelTop - 20); safe.height = safe.bottom - safe.top; }
    const camera = SurfaceState.fitSurfaceCamera(bounds, safe);
    state.setCanvasViewportTarget?.(camera, { immediate: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches });
    focusCanvasCard(document.getElementById(resolved.find(item => item.status === 'available')?.view.id));
    return true;
  }

  function closeAnswerBriefing(options = {}) {
    const session = state.codex.briefingSession;
    state.codex.briefingSession = null;
    document.getElementById('egd-answer-briefing')?.remove();
    if (!session || options.restore === false) return;
    state.setCanvasViewportTarget?.(session.previousView, { immediate: true });
    setActiveEntity(document.getElementById(session.previousView.activeEntityId));
  }

  async function openAnswerBriefing(thread, message) {
    if (!BriefingState.validBriefing(message.briefing)) return;
    if (['conversationId', 'runId', 'answerId'].some(key => message.briefing[key] !== message[key])) {
      boardNotice('이 답변에 속하는 브리핑 연결을 확인하지 못했습니다.'); return;
    }
    if (state.codex.briefingSession) closeAnswerBriefing();
    const local = thread.messages.flatMap(item => item.inputReferences || []);
    const session = state.codex.briefingSession = {
      ...BriefingState.beginBriefing(message.briefing, { pan: { ...state.panTarget }, zoom: state.zoomTarget, activeEntityId: state.activeEntityId }),
      threadId: thread.id, identity: { conversationId: message.conversationId, runId: message.runId, answerId: message.answerId },
      references: (message.contextCaptures || []).map(reference => ({ ...reference,
        localSource: local.find(item => item.sourceId === reference.sourceId)?.localSource || null })),
      artifacts: message.artifacts || [],
      presentationId: chatBindingNonce(), preparing: true,
    };
    renderAnswerBriefing();
    const isCurrent = () => state.codex.briefingSession?.presentationId === session.presentationId;
    const materialized = new Set();
    for (const step of session.briefing.steps) {
      const reference = session.references.find(item => item.sourceId === step.target?.sourceId);
      if (!reference || !isCurrent()) continue;
      if (step.target.hash && step.target.hash !== reference.hash) continue;
      try {
        const ranged = { ...reference, presentationRange: step.target.range };
        const key = InputContext.inputEvidenceKey(ranged);
        if (materialized.has(key)) continue;
        materialized.add(key);
        await state.codexBridge.openInputEvidence(thread.id, ranged, { isCurrent });
      } catch (error) { if (isCurrent()) boardNotice(error.message); }
    }
    if (!isCurrent()) return;
    state.codex.briefingSession.preparing = false;
    renderAnswerBriefing();
    fitBriefingTargets(briefingResolvedTargets(state.codex.briefingSession));
  }

  function renderAnswerBriefing() {
    const session = state.codex.briefingSession;
    if (!session) return;
    document.getElementById('egd-answer-briefing')?.remove();
    const step = BriefingState.currentBriefingStep(session);
    const resolved = briefingResolvedTargets(session);
    const panel = el('section', { id: 'egd-answer-briefing', role: 'region', 'aria-label': '답변 브리핑',
      data: { testid: 'answer-briefing', briefingId: session.briefing.id, stepId: step.id } });
    panel.addEventListener('mousedown', event => event.stopPropagation());
    const go = index => {
      state.codex.briefingSession = BriefingState.selectBriefingStep(session, index);
      renderAnswerBriefing();
      fitBriefingTargets(briefingResolvedTargets(state.codex.briefingSession));
      document.querySelector('#egd-answer-briefing nav')?.focus();
    };
    const nav = el('nav', { tabindex: '0', 'aria-label': '브리핑 단계 탐색' },
      el('button', { disabled: session.index === 0 ? 'true' : null, data: { testid: 'briefing-previous' }, onclick: () => go(session.index - 1) }, '이전'),
      el('span', { 'aria-live': 'polite' }, `${session.index + 1} / ${session.briefing.steps.length}`),
      el('button', { data: { testid: 'briefing-overview' }, onclick: () => fitBriefingTargets(session.briefing.steps.flatMap(item => briefingResolvedTargets(session, item))) }, '전체 보기'),
      el('button', { disabled: session.index === session.briefing.steps.length - 1 ? 'true' : null, data: { testid: 'briefing-next' }, onclick: () => go(session.index + 1) }, '다음'),
      el('button', { 'aria-label': '브리핑 종료하고 이전 보기로 복귀', data: { testid: 'briefing-exit' }, onclick: closeAnswerBriefing }, '종료'));
    nav.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); go(session.index + (event.key === 'ArrowRight' ? 1 : -1)); }
    });
    panel.appendChild(el('strong', {}, session.briefing.title || '답변 브리핑'));
    panel.appendChild(nav);
    panel.appendChild(el('p', {}, step.text));
    if (session.preparing) panel.appendChild(el('p', { role: 'status' }, '이 브리핑이 선택한 고정 근거를 준비하고 있습니다.'));
    for (const target of resolved) {
      if (target.status !== 'available') panel.appendChild(el('p', { role: 'status' }, target.reason || step.fallback || '대상을 확인할 수 없습니다.'));
      if (target.reference) {
        panel.appendChild(el('button', { data: { testid: 'briefing-inspect', sourceId: target.reference.sourceId },
          onclick: () => state.codexBridge.inspectInput(session.threadId, target.reference, target.target.range || {}) }, '당시 입력 보기'));
        if (target.status !== 'available' && !session.preparing) panel.appendChild(el('button', { data: { testid: 'briefing-show-evidence', sourceId: target.reference.sourceId },
          onclick: async () => {
            await state.codexBridge.openInputEvidence(session.threadId, { ...target.reference, presentationRange: target.target.range }, { isCurrent: () => state.codex.briefingSession === session });
            if (state.codex.briefingSession !== session) return;
            renderAnswerBriefing(); fitBriefingTargets(briefingResolvedTargets(session));
          } }, '고정 근거 다시 열기'));
      }
    }
    const comment = el('textarea', { rows: '2', 'aria-label': '현재 브리핑 단계 의견', placeholder: '이 단계에 대한 의견', data: { testid: 'briefing-comment' } });
    session.commentDrafts ||= {};
    comment.value = session.commentDrafts[step.id] || '';
    comment.addEventListener('input', () => { session.commentDrafts[step.id] = comment.value; });
    panel.appendChild(comment);
    panel.appendChild(el('button', { data: { testid: 'briefing-comment-attach' }, onclick: () => {
      try { state.codexBridge.attachBriefingComment(session.threadId, BriefingState.briefingCommentDraft(session, comment.value, resolved), session.references); }
      catch (error) { boardNotice(error.message); }
    } }, '다음 Chat 초안에 포함'));
    panel.appendChild(el('details', {}, el('summary', {}, '단계 목록'), ...session.briefing.steps.map((item, index) => el('button', {
      'aria-label': `${index + 1}단계로 이동`, onclick: () => go(index),
    }, `${index + 1}. ${item.text}`))));
    document.documentElement.appendChild(panel);
  }

  function spawnInputEvidence(reference, stored = null, options = {}) {
    const evidenceSnapshot = stored ? InputContext.inputEvidenceSnapshot(stored, reference) : null;
    const existing = Array.from(document.querySelectorAll('.egd-input-evidence-card')).find(card =>
      InputContext.inputEvidenceKey(card._inputReference) === InputContext.inputEvidenceKey(reference));
    if (existing && !options.restore) {
      if (stored && !existing._inputEvidenceLoaded) {
        existing._deskWindowShell.slots.content.replaceChildren(InputContext.inputSnapshotView(document, evidenceSnapshot, { includeDelivered: false }));
        existing._inputEvidenceLoaded = true;
      }
      return existing;
    }
    const shell = spawnDeskWindowShell({ id: `egd-input-evidence-${++cardSeq}`, kind: 'input-evidence', className: 'egd-input-evidence-card',
      sourceRef: { kind: 'context-snapshot', id: reference.sourceId, scope: 'immutable-input' },
      style: { left: `${180 + document.querySelectorAll('.egd-input-evidence-card').length * 680}px`, top: '160px', width: '640px', height: '480px' } });
    shell.root._inputReference = cloneJson(reference);
    shell.root._inputEvidenceLoaded = !!evidenceSnapshot;
    shell.slots.identity.appendChild(el('strong', {}, '당시 입력 · 읽기 전용'));
    if (stored) shell.slots.content.appendChild(InputContext.inputSnapshotView(document, evidenceSnapshot, { includeDelivered: false }));
    else shell.slots.content.appendChild(el('button', { 'aria-label': '저장된 당시 입력 불러오기', onclick: async () => {
      const result = await state.codexBridge.readInput(reference, reference.presentationRange);
      if (!result || !shell.root.isConnected) return;
      try {
        const snapshot = InputContext.inputEvidenceSnapshot(result, reference);
        shell.slots.content.replaceChildren(InputContext.inputSnapshotView(document, snapshot, { includeDelivered: false }));
        shell.root._inputEvidenceLoaded = true;
      } catch (error) { boardNotice(error.message); }
    } }, '당시 입력 불러오기'));
    return shell.root;
  }

  function renderCodexActivityPanel() {
    const thread = getCodexThreadById(state.codex, state.codex.activityThreadId);
    if (!thread) { document.getElementById('egd-codex-activity-panel')?.remove(); return; }
    let panel = document.getElementById('egd-codex-activity-panel');
    if (!panel) {
      panel = el('section', { id: 'egd-codex-activity-panel', role: 'region', 'aria-label': '활동 기록', data: { testid: 'chat-activity-panel' } });
      panel.addEventListener('mousedown', ev => ev.stopPropagation());
      document.documentElement.appendChild(panel);
    }
    panel.dataset.threadId = thread.id;
    const oldBody = panel.querySelector('.egd-codex-activity-body');
    const scrollTop = oldBody?.scrollTop || 0;
    const rows = [];
    for (const message of thread.messages || []) {
      if (!message.inputReferences?.length) continue;
      rows.push(el('details', { data: { testid: 'chat-input-history', requestId: message.requestId || '', runId: message.runId || '' } },
        el('summary', {}, `당시 첨부 입력 · ${message.inputReferences.length}개`),
        ...message.inputReferences.map(reference => el('button', { 'aria-label': `당시 입력 확인: ${reference.localSource?.label || reference.sourceId}`,
          data: { testid: 'chat-input-history-open', snapshotId: reference.snapshotId },
          onclick: () => state.codexBridge.inspectInput(thread.id, reference) }, reference.localSource?.label || reference.sourceId))));
    }
    if (ChatState.nativeBindingHeld(thread)) {
      const reference = thread.retainedNativeBinding;
      rows.push(el('section', { data: { testid: 'chat-retained-binding' } },
        el('p', {}, '이전 대화는 현재 계정에 연결하지 않았습니다. 로컬 기록과 이전 연결 참조는 보관됩니다.'),
        el('details', {}, el('summary', {}, '보관된 연결 참조'),
          reference.conversationId ? el('p', {}, `대화 참조: ${reference.conversationId}`) : null,
          el('p', {}, `연결 참조: ${reference.clientThreadId || '없음'}`))));
    }
    const history = state.codex.chatProtocol.histories[thread.conversationId];
    const partialHistory = thread.localHistoryCoverage?.status === 'partial' || thread.localHistoryCoverage?.status === 'unknown'
      || history?.truncated || history?.historyComplete === false
      || codexRuns(thread).some(run => run.truncated || run.historyComplete === false);
    if (partialHistory) rows.push(el('p', { role: 'status', data: { testid: 'chat-history-status', complete: 'false' } }, '일부 기록만 표시됩니다. 이전 활동이나 메시지가 빠져 있을 수 있습니다.'));
    if (state.codex.chatProtocol.unobservedPreviousRun) rows.push(el('p', { role: 'status', data: { testid: 'chat-account-reset-status' } }, '이전 Codex 연결의 실행 종료는 확인되지 않았습니다. 로그아웃은 중지 확인이 아닙니다. 이전 계정에 다시 연결해 상태를 확인하세요.'));
    for (const run of codexRuns(thread)) {
      rows.push(el('h4', { data: { runId: run.runId } }, codexRunLabel(run)));
      for (const entry of run.contextEvents || []) {
        const labels = { 'context.read.started': '자료 읽기 시작', 'context.read.completed': '요청 범위의 자료 읽기 완료',
          'context.read.failed': '자료 읽기 실패', 'reader.started': 'Reader 처리 시작', 'reader.completed': 'Reader 처리 완료', 'reader.failed': 'Reader 처리 실패' };
        rows.push(el('p', { data: { testid: 'chat-context-activity', event: entry.event, sourceId: entry.details.sourceId || '' } }, labels[entry.event] || entry.event));
      }
      const packets = [...new Map([...(run.contextPackets || []), ...(run.contextEvents || []).filter(entry => entry.event === 'context.read.completed').map(entry => entry.details)]
        .filter(packet => packet.packetId).map(packet => [packet.packetId, packet])).values()];
      for (const packet of packets) {
        const reference = run.contextCaptures?.find(capture => capture.sourceId === packet.sourceId);
        if (!reference) continue;
        rows.push(el('button', { 'aria-label': '이 읽기에서 실제 전달한 payload 확인',
          data: { testid: 'chat-delivered-input-open', packetId: packet.packetId, sourceId: packet.sourceId },
          onclick: () => state.codexBridge.inspectInput(thread.id, reference, { packetId: packet.packetId }),
        }, `${reference.label || '입력'} · 전달 payload 보기`));
      }
      if (run.summary) rows.push(el('p', { class: 'egd-codex-public-summary' }, run.summary));
      const steps = Array.isArray(run.plan) ? run.plan : run.plan?.steps;
      if (Array.isArray(steps)) rows.push(el('ul', {}, ...steps.map(step => el('li', {}, `${step.step || step.title || ''} · ${step.status || ''}`))));
      else if (run.plan?.text) rows.push(el('p', {}, run.plan.text));
      for (const activity of run.activities || []) {
        const row = el('article', { class: 'egd-codex-activity-row', data: { activityId: activity.id, status: activity.status } },
          el('strong', {}, activity.title || activity.kind || '활동'),
          el('span', {}, ({ inProgress: '진행 중', completed: '완료', failed: '실패', declined: '거절됨' })[activity.status] || activity.status || ''),
          typeof activity.detail === 'string' ? el('pre', {}, activity.detail) : null);
        if (activity.detail && typeof activity.detail === 'object') {
          for (const key of ['text', 'command', 'cwd', 'exitCode', 'durationMs', 'server', 'tool']) {
            const value = activity.detail[key];
            if (value !== undefined && value !== null && value !== '') row.appendChild(el('pre', {}, `${key}: ${value}`));
          }
        }
        for (const ref of activity.sourceRefs || []) {
          if (ref.type !== 'file' || !ref.target?.path) continue;
          row.appendChild(el('button', {
            disabled: ref.status !== 'available' || !ref.openable ? 'true' : null,
            'aria-label': `활동의 파일 열기: ${ref.target.path}`,
            onclick: () => openChatFileReference(ref),
          }, ref.target.path));
        }
        rows.push(row);
      }
      for (const approval of run.pendingApprovals || []) {
        const approvalId = approval.approvalId || approval.id;
        const block = el('section', { class: 'egd-codex-approval-pending', 'aria-label': '실행 승인', data: { testid: 'chat-approval', approvalId, runId: run.runId, status: approval.status } },
          el('strong', {}, approval.status === 'replySent' ? '응답 전달됨 · 실행 상태 확인 중' : '승인 필요'),
          el('p', {}, approval.reason || '실행이 승인을 기다리고 있습니다.'),
          approval.command ? el('pre', {}, approval.command) : null,
          approval.cwd ? el('p', {}, `작업 위치: ${approval.cwd}`) : null,
          approval.scope === 'request' ? el('p', {}, '승인 범위: 이번 요청') : null,
          ...(approval.paths || []).map(path => el('p', {}, `요청 대상: ${path}`)));
        if (approval.networkApprovalContext != null) {
          block.appendChild(el('p', {}, `네트워크 대상: ${approval.networkApprovalContext.protocol || '프로토콜 미확인'} · ${approval.networkApprovalContext.host || '호스트 미확인'} · 이번 요청`));
        }
        if (!ChatState.approvalScopeKnown(approval)) block.appendChild(el('p', {}, approval.acceptDisabledReason || '요청 범위를 확인하지 못해 허용할 수 없습니다. 거절하거나 취소할 수 있습니다.'));
        for (const decision of approval.choices || []) {
          const label = { accept: '허용', decline: '거절', cancel: '취소' }[decision];
          if (!label) continue;
          block.appendChild(el('button', {
            'aria-label': `승인 요청 ${label}`, data: { testid: 'chat-approval-choice', decision, approvalId },
            disabled: approval.status !== 'pending' || approval.replyPending || approval.stale || (decision === 'accept' && !ChatState.approvalScopeKnown(approval)) ? 'true' : null,
            onclick: () => state.codexBridge.replyApproval({ approvalId, conversationId: run.conversationId, runId: run.runId, decision }),
          }, label));
        }
        if (approval.error) block.appendChild(el('p', { role: 'alert' }, approval.error));
        rows.push(block);
      }
      if (run.error) rows.push(el('p', { class: 'egd-codex-error' }, typeof run.error === 'string' ? run.error : run.error.message || run.error.code || '실행 오류'));
    }
    if (!rows.length) rows.push(el('p', {}, '기록된 활동이 없습니다.'));
    const body = el('div', { class: 'egd-codex-activity-body' }, ...rows);
    panel.replaceChildren(el('header', {}, el('strong', {}, '활동 기록'), el('button', {
      'aria-label': '활동 상태 다시 확인', onclick: () => state.codexBridge.refreshConversation(thread.id),
    }, '새로고침'), el('button', {
      'aria-label': '활동 기록 닫기', onclick: () => { state.codex.activityThreadId = null; panel.remove(); },
    }, '닫기')), body);
    body.scrollTop = scrollTop;
  }

  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 4.5;
  const WHEEL_PAN_SPEED = 1.15;
  const WHEEL_ZOOM_SPEED = 0.0044;
  const PAN_SMOOTHING = 0.24;
  const ZOOM_SMOOTHING = 0.22;
  const WHEEL_SESSION_IDLE_MS = 140;
  const AGENDA_STORAGE_PREF = 'egdesk.agendaState.v1';
  const SURFACE_LIFECYCLE_PREF = 'egdesk.surfaceLifecycle.v1';
  const DESK_SESSION_PREF = 'egdesk.deskSession.v1';
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
            title: raw.agenda.title || 'Board',
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
    state.agenda.activeTitle = activeSnapshot?.agenda?.title || activeMeta?.title || state.agenda.activeTitle || 'EG-Desk';
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
    if (card.classList.contains('egd-input-evidence-card')) return 'input-evidence';
    if (card.classList.contains('egd-file-card')) return 'file';
    return 'card';
  }

  function runtimeStateForCard(card, type) {
    if (type === 'file') return cloneJson(card._fileRecord || { version: 1 });
    if (type === 'input-evidence') return { reference: cloneJson(card._inputReference) };
    if (type === 'browser') {
      return {
        uri: normalizeBrowserUri(card._browserState?.uri || card.querySelector('.egd-card-url')?.value || card._sourceRef?.uri || 'https://duckduckgo.com'),
        title: card._browserState?.title || '',
        firstUseBrowser: card.classList.contains('egd-first-use-browser'),
        fixedLogicalHeight: card._fixedLogicalHeight || null,
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
    if (card._savedBoardMember) return { ...cloneJson(card._savedBoardMember), id: card.id, geometry: persistentEntityGeometry(card) };
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

  function serializeDeskSnapshot() {
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
      surface: { mode: state.surface.mode, browserCardId: state.surface.browserCardId, recoveryBackupKey: state.surface.recoveryBackupKey || null, recoveryAcknowledged: !!state.surface.recoveryAcknowledged },
      boardProjections: cloneJson(state.boards),
      chat: {
        threads: cloneJson(state.codex.threads.map(({ localRuns, localHistoryCoverage, ...thread }) => ({
          ...thread, messages: (thread.messages || []).map(({ liveRevision, localHistory, localSeq, ...message }) => message),
        }))),
        activeThreadId: state.codex.activeThreadId,
        codexAccountKey: state.codex.codexAccountKey || null,
        unobservedPreviousRun: !!state.codex.chatProtocol.unobservedPreviousRun,
        threadDrafts: { ...state.codex.threadDrafts }, hudView: state.codex.hudView,
        localHistoryBackupKey: state.codex.legacyChatBackupKey || null,
      },
    };
  }

  function boardNotice(message) {
    let notice = document.getElementById('egd-board-notice');
    if (!notice) {
      notice = el('div', { id: 'egd-board-notice', role: 'status', class: 'egd-edge egd-frosted' });
      document.documentElement.appendChild(notice);
    }
    notice.replaceChildren(document.createTextNode(message), el('button', {
      'aria-label': '안내 닫기', onclick: () => notice.remove(),
    }, '×'));
  }

  function activeBoardProjection() {
    return state.boards.projections[state.boards.activeProjectionId] || null;
  }

  function serializeAgendaSnapshot(options = {}) {
    const projection = !Array.isArray(options.memberIds) && state.boards.projections[options.projectionId || state.boards.activeProjectionId];
    if (projection) {
      const records = {};
      for (const member of projection.members) {
        const view = document.getElementById(member.viewId);
        if (!view || view._savedBoardMember) continue;
        const record = member.kind === 'shape' ? serializeShapeState(view) : serializeCardState(view);
        if (record) {
          record.geometry.x -= projection.offset?.x || 0;
          record.geometry.y -= projection.offset?.y || 0;
          records[member.viewId] = record;
        }
      }
      return SurfaceState.snapshotBoardProjection(projection, records);
    }
    // A new Board requires an explicit member set, including an explicit empty set.
    if (!Array.isArray(options.memberIds) || !options.agendaId) return null;
    const views = [...new Set(options.memberIds)].map(id => document.getElementById(id)).filter(Boolean);
    return {
      version: 1, savedAt: Date.now(),
      agenda: { id: options.agendaId, title: options.title || 'Board', memberCardIds: views.filter(v => v.classList.contains('egd-canvas-card')).map(v => v.id), contextBindings: cloneJson(options.contextBindings || []) },
      cards: views.filter(v => v.classList.contains('egd-canvas-card')).map(serializeCardState).filter(Boolean),
      shapes: views.filter(v => v.classList.contains('egd-canvas-shape')).map(serializeShapeState).filter(Boolean),
    };
  }

  function mountBoardMember(projection, member, options = {}) {
    const record = cloneJson(member.record);
    const geometry = { ...(record.geometry || { x: 40, y: 80, width: 340, height: 180 }) };
    geometry.x = (geometry.x || 0) + (projection.offset?.x || 0);
    geometry.y = (geometry.y || 0) + (projection.offset?.y || 0);
    let view = null;
    let reason = '이 구성원은 연결 상태를 확인한 뒤 열 수 있습니다.';
    try {
      if (member.kind === 'shape') view = restoreShapeFromState({ ...record, id: member.viewId, geometry });
      else if (record.type === 'browser') {
        const uri = record.runtimeState?.uri || record.sourceRef?.uri;
        if (!uri) throw new Error('저장된 주소가 없습니다.');
        if (/^file:/i.test(uri)) {
          const file = servicesRef().io.newURI(uri).QueryInterface(Ci.nsIFileURL).file;
          if (!file.exists()) throw new Error('파일을 찾을 수 없습니다. 원래 위치에 복구한 뒤 다시 확인하세요.');
        }
        view = spawnBrowserCard(uri, { openMode: 'new', sourceRef: record.sourceRef || {}, firstUse: !!record.runtimeState?.firstUseBrowser && state.surface.restoring, fixedLogicalHeight: record.runtimeState?.fixedLogicalHeight });
      } else if (record.type === 'ontology') view = spawnOntologyMapCard(record.runtimeState || {});
      else if (record.type === 'input-evidence' && record.runtimeState?.reference) view = spawnInputEvidence(record.runtimeState.reference, null, { restore: true });
      else if (record.type === 'settings') view = spawnSettingsCard({ openMode: 'new' });
      else if (record.type === 'file') view = spawnFileCard({ openMode: 'new', restore: true, record: record.runtimeState });
      else if (record.type === 'terminal' && options.newTerminal === true) view = spawnTerminalCard();
    } catch (error) { reason = error.message || reason; }
    if (!view) {
      const terminal = record.type === 'terminal';
      if (terminal) reason = '저장된 터미널 배치입니다. 이전 PTY 연결은 확인되지 않았습니다. 새 세션을 직접 열 수 있으며 이전 명령은 재실행하지 않습니다.';
      view = el('div', {
        id: member.viewId, class: 'egd-canvas-card egd-board-missing', role: 'region',
        'aria-label': 'Board 구성원 연결 확인', data: { testid: 'board-missing-member' },
      }, el('strong', {}, record.sourceRef?.path || record.sourceRef?.uri || record.type || '구성원'),
      el('p', {}, reason),
      el('button', { 'aria-label': terminal ? '새 터미널 세션 열기' : '구성원 다시 확인', data: { testid: terminal ? 'board-new-terminal' : 'board-member-retry' }, onclick: () => {
        view.remove();
        state.agenda.suppressDirty = true;
        try { mountBoardMember(projection, member, { newTerminal: terminal }); } finally { state.agenda.suppressDirty = false; }
        refreshBoardRegion(projection);
      } }, terminal ? '새 터미널 세션 열기' : '다시 확인'),
      el('details', {}, el('summary', {}, '저장된 참조 보기'), el('pre', {}, JSON.stringify(record.sourceRef || { type: record.type, id: member.sourceId }, null, 2))));
      view._savedBoardMember = record;
      document.getElementById('egd-canvas-layer').appendChild(view);
    }
    retargetRestoredEntityId(view, member.viewId);
    if (record.sourceRef && !options.newTerminal) bindCardSourceRef(view, record.sourceRef);
    if (options.newTerminal) { view.dataset.runtimeContinuity = 'new-session'; registerSourceRefCard(view); }
    applyPersistentEntityGeometry(view, geometry);
    view.dataset.boardId = projection.boardId;
    view.dataset.projectionId = projection.id;
    view.dataset.memberId = member.sourceId;
    view.addEventListener('mousedown', () => selectBoardProjection(projection.id), true);
    return view;
  }

  function selectBoardProjection(projectionId) {
    const projection = state.boards.projections[projectionId];
    if (!projection) return false;
    state.boards.activeProjectionId = projection.id;
    state.agenda.activeAgendaId = projection.boardId;
    state.agenda.activeTitle = projection.title;
    state.agenda.dirty = !!projection.dirty;
    state.agenda.hasSavedState = !!coerceAgendaStore().agendas[projection.boardId];
    syncViewportAgendaRail();
    return true;
  }

  function refreshBoardRegion(projection) {
    let region = document.getElementById(projection.id);
    if (!region) {
      region = el('section', {
        id: projection.id, class: 'egd-board-region', 'aria-label': `Board ${projection.title}`,
        data: { boardId: projection.boardId, projectionId: projection.id, testid: 'board-projection' },
      }, el('div', { class: 'egd-board-region-bar' },
        el('button', { 'aria-label': `Board ${projection.title} 선택`, onclick: () => selectBoardProjection(projection.id) }, projection.title),
        el('button', { 'aria-label': '이 Board 저장', data: { testid: 'board-save', projectionId: projection.id }, onclick: () => saveCurrentAgendaState({ projectionId: projection.id }) }, '저장'),
        el('button', { 'aria-label': '이 Board의 요소를 Chat에 첨부', data: { testid: 'board-attach-chat', projectionId: projection.id },
          onclick: () => openChatInputPanel(state.codex.activeThreadId, { viewIds: projection.members.map(member => member.viewId) }) }, 'Chat 첨부'),
        el('button', { 'aria-label': '이 Board 닫기', data: { testid: 'board-close', projectionId: projection.id }, onclick: () => closeCurrentAgenda({ projectionId: projection.id }) }, '닫기')));
      document.getElementById('egd-canvas-layer').prepend(region);
    }
    const rects = projection.members.map(m => document.getElementById(m.viewId)).filter(Boolean).map(persistentEntityGeometry);
    const x = rects.length ? Math.min(...rects.map(r => r.x)) - 18 : projection.offset?.x || 40;
    const y = rects.length ? Math.min(...rects.map(r => r.y)) - 48 : projection.offset?.y || 80;
    const right = rects.length ? Math.max(...rects.map(r => r.x + r.width)) + 18 : x + 340;
    const bottom = rects.length ? Math.max(...rects.map(r => r.y + r.height)) + 18 : y + 100;
    Object.assign(region.style, { left: `${x}px`, top: `${y}px`, width: `${right - x}px`, height: `${bottom - y}px` });
    return region;
  }

  function openBoardSnapshot(snapshot, options = {}) {
    if (!snapshot?.agenda?.id) { boardNotice('저장된 Board를 읽을 수 없습니다.'); return false; }
    let projection = Object.values(state.boards.projections).find(p => p.boardId === snapshot.agenda.id);
    if (!projection) {
      let projectionId;
      do { projectionId = `egd-board-${++cardSeq}`; } while (document.getElementById(projectionId));
      projection = SurfaceState.planBoardProjection(snapshot, projectionId);
      const occupied = Array.from(document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape')).map(persistentEntityGeometry);
      const sourceMinX = Math.min(0, ...projection.members.map(m => m.record.geometry?.x || 0));
      projection.offset = { x: occupied.length ? Math.max(...occupied.map(r => r.x + r.width)) + 64 - sourceMinX : 0, y: 0 };
      state.boards.projections[projection.id] = projection;
      state.agenda.suppressDirty = true;
      try { for (const member of projection.members) mountBoardMember(projection, member); }
      finally { state.agenda.suppressDirty = false; }
    } else {
      const missing = SurfaceState.missingProjectionMembers(projection, projection.members.map(member => document.getElementById(member.viewId)?.id).filter(Boolean));
      state.agenda.suppressDirty = true;
      try { for (const member of missing) mountBoardMember(projection, member); }
      finally { state.agenda.suppressDirty = false; }
    }
    const region = refreshBoardRegion(projection);
    selectBoardProjection(projection.id);
    if (options.focus !== false) {
      state.setCanvasPanTarget?.({ x: 36 - parsePxNumber(region.style.left) * state.zoomTarget, y: 100 - parsePxNumber(region.style.top) * state.zoomTarget }, { immediate: true });
    }
    scheduleDeskSessionSave();
    return projection;
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

  async function clearCanvasEntitiesForRestore() {
    for (const card of Array.from(document.querySelectorAll('.egd-canvas-card'))) {
      try {
        if (card._beforeClose && await card._beforeClose() !== true) return false;
        if (card._closeOwnedRuntime && await card._closeOwnedRuntime() !== true) {
          boardNotice('터미널 종료를 확인하지 못해 화면을 유지했습니다. 상태를 확인한 뒤 다시 닫아 주세요.');
          return false;
        }
      } catch (error) {
        boardNotice(`화면을 유지했습니다: ${error.message}`);
        return false;
      }
      unregisterSourceRefCard(card);
      try { if (typeof card._cleanup === 'function') card._cleanup(); } catch {}
      card.remove();
    }
    if (state.cardFullscreen) exitCardFullscreen(null, { restoreRect: false });
    for (const shape of Array.from(document.querySelectorAll('.egd-canvas-shape'))) {
      try { if (typeof shape._cleanup === 'function') shape._cleanup(); } catch {}
      shape.remove();
    }
    state.sourceRefs.cardsByKey = Object.create(null);
    state.activeEntityId = null;
    state.codex.chatCardEntityId = null;
    state.codex.chatDockMode = 'hud';
    return true;
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
    return openBoardSnapshot(snapshot, options);
  }

  function restoreDeskSession(snapshot, options = {}) {
    if (!snapshot?.agenda?.id) return false;
    if (!options.merge && document.querySelector('.egd-canvas-card, .egd-canvas-shape')) return false;
    state.agenda.restoreInProgress = true;
    state.agenda.suppressDirty = true;
    try {
      // Automatic Desk restore uses its own snapshot, never a Saved Board as a substitute.
      if (!options.merge && Array.isArray(snapshot.chat?.threads)) {
        state.codex.chatProtocol.unobservedPreviousRun ||= !!snapshot.chat.unobservedPreviousRun;
        state.codex.threads = snapshot.chat.threads.map(thread => ChatState.reconcileNativeThread(
          ChatState.detachNativeThread(thread, snapshot.chat.codexAccountKey || null, chatBindingNonce()), state.codex.authStatus));
        state.codex.activeThreadId = snapshot.chat.activeThreadId;
        state.codex.threadDrafts = { ...snapshot.chat.threadDrafts };
        state.codex.hudView = snapshot.chat.hudView || 'conversation';
      }
      const records = options.merge ? RecoveryState.missingDeskRecoveryViews(snapshot,
        Array.from(document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape')).map(view => view.id)) : snapshot;
      const boardMemberIds = new Set(Object.values(snapshot.boardProjections?.projections || {}).flatMap(projection => projection.members.map(member => member.viewId)));
      for (const cardState of records.cards || []) {
        if (options.merge && cardState.type === 'chat' && state.codex.chatCardEntityId) continue;
        if (cardState.type === 'chat' && !boardMemberIds.has(cardState.id)) {
          const card = spawnCodexChatCard();
          retargetRestoredEntityId(card, cardState.id);
          applyPersistentEntityGeometry(card, cardState.geometry);
          continue;
        }
        const projection = { id: '', boardId: '', offset: { x: 0, y: 0 } };
        mountBoardMember(projection, { sourceId: cardState.id, viewId: cardState.id, kind: 'card', record: cardState });
      }
      for (const shapeState of records.shapes || []) restoreShapeFromState(shapeState);
      if (!options.merge) state.boards = snapshot.boardProjections || { projections: {}, activeProjectionId: null };
      else {
        for (const [id, projection] of Object.entries(snapshot.boardProjections?.projections || {})) {
          if (!state.boards.projections[id] && !Object.values(state.boards.projections).some(current => current.boardId === projection.boardId)) {
            state.boards.projections[id] = cloneJson(projection);
          }
        }
      }
      for (const projection of Object.values(state.boards.projections)) {
        refreshBoardRegion(projection);
        for (const member of projection.members) {
          const view = document.getElementById(member.viewId);
          if (!view) continue;
          view.dataset.boardId = projection.boardId;
          view.dataset.projectionId = projection.id;
          view.dataset.memberId = member.sourceId;
          view.addEventListener('mousedown', () => selectBoardProjection(projection.id), true);
        }
      }
      if (!options.merge) {
        state.agenda.activeAgendaId = snapshot.agenda.id || state.agenda.activeAgendaId;
        state.agenda.activeTitle = snapshot.agenda.title || state.agenda.activeTitle || 'EG-Desk';
      }
      if (!options.merge) {
        state.agenda.hasSavedState = true;
        state.agenda.lastSavedAt = snapshot.savedAt || Date.now();
      }
      if (!options.merge && snapshot.desk?.pan && typeof state.setCanvasViewportTarget === 'function') {
        state.setCanvasViewportTarget({
          pan: snapshot.desk.pan,
          zoom: Number.isFinite(snapshot.desk.zoom) ? snapshot.desk.zoom : state.zoomTarget,
        }, { immediate: true });
      }
      const active = snapshot.desk?.activeCardId ? document.getElementById(snapshot.desk.activeCardId) : null;
      if (active && !options.merge) setActiveEntity(active);
      if (!options.merge) {
        state.agenda.dirty = !!activeBoardProjection()?.dirty;
        state.agenda.dirtyReasons = [];
      }
      syncViewportAgendaRail();
      refreshDeskMinimap();
      if (!options.merge) queueMicrotask(() => state.codexBridge?.resumeVerifiedThreads?.());
      return true;
    } finally {
      state.agenda.restoreInProgress = false;
      state.agenda.suppressDirty = false;
    }
  }

  function saveCurrentAgendaState(options = {}) {
    const snapshot = serializeAgendaSnapshot(options);
    if (!snapshot) { boardNotice('저장할 Board를 선택하거나 새 Board의 포함 범위를 지정하세요.'); return null; }
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
    const projection = !Array.isArray(options.memberIds) && state.boards.projections[options.projectionId || state.boards.activeProjectionId];
    if (projection) {
      projection.source = cloneJson(snapshot);
      projection.dirty = false;
      for (const member of projection.members) {
        member.record = cloneJson([...(snapshot.cards || []), ...(snapshot.shapes || [])].find(record => record.id === member.sourceId) || member.record);
      }
    }
    state.agenda.dirty = false;
    state.agenda.dirtyReasons = [];
    state.agenda.hasSavedState = true;
    state.agenda.lastSavedAt = snapshot.savedAt;
    if (projection) selectBoardProjection(projection.id);
    else if (state.boards.activeProjectionId) selectBoardProjection(state.boards.activeProjectionId);
    syncViewportAgendaRail();
    scheduleDeskSessionSave();
    return snapshot;
  }

  function restoreSavedAgendaState(options = {}) {
    const store = coerceAgendaStore();
    const snapshot = store.agendas[state.agenda.activeAgendaId] || null;
    if (!snapshot) return false;
    return restoreAgendaSnapshot(snapshot, { markClean: options.markClean !== false });
  }

  function closeAgendaCloseGuard() {
    document.getElementById('egd-agenda-close-guard')?.remove();
    state.agenda.closeGuardOpen = false;
  }

  async function clearCurrentAgendaView(options = {}) {
    state.agenda.suppressDirty = true;
    try {
      if (!(await clearCanvasEntitiesForRestore())) return false;
      if (options.markClean !== false) {
        state.agenda.dirty = false;
        state.agenda.dirtyReasons = [];
      }
    } finally {
      state.agenda.suppressDirty = false;
      syncViewportAgendaRail();
      refreshDeskMinimap();
    }
    return true;
  }

  const boardCloseRequests = new Set();
  const boardCloseInFlight = new Map();
  function completeAgendaClose(options = {}) {
    const projectionId = options.projectionId || state.boards.activeProjectionId;
    if (boardCloseInFlight.has(projectionId)) return boardCloseInFlight.get(projectionId);
    boardCloseRequests.add(projectionId);
    const pending = finishAgendaClose({ ...options, projectionId }).finally(() => boardCloseInFlight.delete(projectionId));
    boardCloseInFlight.set(projectionId, pending);
    return pending;
  }

  async function finishAgendaClose({ saveFirst = false, projectionId = state.boards.activeProjectionId } = {}) {
    const projection = state.boards.projections[projectionId];
    if (!projection) return false;
    if (saveFirst && !saveCurrentAgendaState({ projectionId })) return false;
    const ownedIds = SurfaceState.ownedProjectionMembers(projection, Object.fromEntries(
      projection.members.map(member => [member.viewId, document.getElementById(member.viewId)?.dataset.projectionId])
    ));
    for (const id of ownedIds) {
      const view = document.getElementById(id);
      if (!view) continue;
      try {
        if (view._beforeClose && !(await view._beforeClose())) {
          boardNotice('파일 변경을 기록하지 못해 Board를 유지했습니다. 파일 창의 상태를 확인한 뒤 다시 닫아 주세요.');
          refreshBoardRegion(projection);
          return false;
        }
        if (view._closeOwnedRuntime && !(await view._closeOwnedRuntime())) {
          boardNotice('터미널 종료가 아직 확인되지 않았습니다. 해당 화면을 유지합니다.');
          refreshBoardRegion(projection);
          return false;
        }
        view._cleanup?.();
        unregisterSourceRefCard(view);
        view.remove();
      } catch (error) {
        boardNotice(`Board 구성원을 닫지 못했습니다: ${error.message}`);
        refreshBoardRegion(projection);
        return false;
      }
    }
    document.getElementById(projection.id)?.remove();
    delete state.boards.projections[projection.id];
    boardCloseRequests.delete(projection.id);
    markAgendaClosed(projection.boardId);
    if (state.boards.activeProjectionId === projection.id) {
      state.boards.activeProjectionId = null;
      state.agenda.activeTitle = 'Desk';
      state.agenda.dirty = false;
      state.agenda.dirtyReasons = [];
    }
    if (!document.getElementById(state.activeEntityId)) setActiveEntity(null);
    closeAgendaCloseGuard();
    syncViewportAgendaRail();
    scheduleDeskSessionSave();
    return true;
  }

  function showAgendaCloseGuard() {
    const projectionId = state.boards.activeProjectionId;
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
        el('div', { id: 'egd-agenda-close-title', class: 'egd-agenda-close-title' }, 'Board를 닫을까요?'),
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
              completeAgendaClose({ saveFirst: false, projectionId });
            },
          }, '버리고 닫기'),
          el('button', {
            class: 'egd-agenda-close-btn egd-agenda-close-btn-primary',
            data: { action: 'save' },
            onclick: (ev) => {
              ev.stopPropagation();
              completeAgendaClose({ saveFirst: true, projectionId });
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
    const projection = state.boards.projections[options.projectionId || state.boards.activeProjectionId];
    if (!projection) return false;
    selectBoardProjection(projection.id);
    if (projection.dirty && options.force !== true) return showAgendaCloseGuard();
    return completeAgendaClose({ projectionId: projection.id, saveFirst: options.saveFirst === true });
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
    for (const projection of Object.values(state.boards.projections)) {
      if (projection.boardId !== agendaId) continue;
      projection.title = title;
      document.getElementById(projection.id)?.remove();
      refreshBoardRegion(projection);
    }
    const ok = writeAgendaStoreAndSync(store);
    syncViewportAgendaRail();
    return ok ? title : false;
  }

  function renameAgendaWithPrompt(agendaId) {
    const entry = agendaListEntries().find((item) => item.id === agendaId);
    const nextTitle = window.prompt('Board 이름', entry?.title || 'Board');
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

  function deleteAgenda() {
    boardNotice('Board 삭제와 복구 정책은 아직 연결되지 않았습니다. 저장된 Board는 유지됩니다.');
    return false;
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
    closeAgendaSwitcher();
    return openBoardSnapshot(snapshot, options);
  }

  function showBoardScopeChooser() {
    document.getElementById('egd-board-scope')?.remove();
    const selectedIds = Array.from(document.querySelectorAll('.egd-entity-selected')).map(view => view.id);
    const name = el('input', { 'aria-label': 'Board 이름', placeholder: 'Board 이름' });
    const dialog = el('div', { id: 'egd-board-scope', class: 'egd-edge egd-frosted', role: 'dialog', 'aria-label': '새 Board 저장 범위' },
      el('h3', {}, '새 Board'), name,
      el('p', {}, '포함할 화면을 직접 선택하세요.'),
      el('button', { 'aria-label': '빈 Board 저장', onclick: () => commitScope([]) }, '빈 Board 저장'),
      el('button', { 'aria-label': '선택한 화면으로 Board 저장', disabled: selectedIds.length ? null : 'true', onclick: () => commitScope(selectedIds) }, `선택한 화면 ${selectedIds.length}개 저장`),
      el('button', { onclick: () => dialog.remove() }, '취소'));
    const commitScope = memberIds => {
      if (!name.value.trim()) { name.focus(); name.setAttribute('aria-invalid', 'true'); return; }
      const saved = saveCurrentAgendaState({ agendaId: newAgendaId(), title: name.value.trim(), memberIds });
      if (saved) { dialog.remove(); boardNotice('Board를 저장했습니다. Board 목록에서 열 수 있습니다.'); }
    };
    document.documentElement.appendChild(dialog);
    name.focus();
    return dialog;
  }

  function createNewAgenda(options = {}) {
    if (!Array.isArray(options.memberIds)) return showBoardScopeChooser();
    return saveCurrentAgendaState({ ...options, agendaId: options.agendaId || newAgendaId() });
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
      'aria-label': `Board ${entry.title} 열기`,
      data: { agendaId: entry.id, boardId: entry.id, testid: 'board-open' },
      onclick: (ev) => {
        if (ev.target?.closest?.('.egd-agenda-switch-row-action')) return;
        ev.stopPropagation();
        switchAgenda(entry.id);
      },
      onkeydown: (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        ev.stopPropagation();
        switchAgenda(entry.id);
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
        }, '🗑︎'),
      ),
    ));
    panel.replaceChildren(
      el('div', { class: 'egd-agenda-switch-head' },
        el('div', { class: 'egd-agenda-switch-title' }, 'Board'),
        el('div', { class: 'egd-agenda-switch-actions' },
          el('button', {
            class: 'egd-agenda-switch-action',
            title: '선택한 Board 저장',
            'aria-label': '선택한 Board 저장',
            data: { testid: 'board-save' },
            onclick: (ev) => {
              ev.stopPropagation();
              saveCurrentAgendaState();
              renderAgendaSwitcherPanel(panel);
            },
          }, '저장'),
          el('button', {
            class: 'egd-agenda-switch-action egd-agenda-switch-action-primary',
            title: '새 Board',
            'aria-label': '새 Board',
            onclick: (ev) => {
              ev.stopPropagation();
              createNewAgenda();
            },
          }, '새 Board'),
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
    scheduleDeskSessionSave();
    const projection = entity?.dataset?.projectionId && state.boards.projections[entity.dataset.projectionId];
    if (!projection) return;
    projection.dirty = true;
    refreshBoardRegion(projection);
    if (projection.id !== state.boards.activeProjectionId) return;
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
    const previous = state.activeEntityId ? document.getElementById(state.activeEntityId) : null;
    if (previous !== entity) state.resetWheelSession?.();
    if (previous && previous !== entity && previous.contains(document.activeElement)) {
      document.activeElement?.blur?.();
    }
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
    return groupThread?.title || 'EG-Desk';
  }

  function cardLabelForViewportRail(card) {
    if (!card) return 'Card';
    if (card.classList.contains('egd-terminal-card')) return 'Terminal';
    if (card.classList.contains('egd-settings-card')) return 'Settings';
    if (card.classList.contains('egd-ontology-card')) return 'Ontology';
    if (card.classList.contains('egd-file-card')) return card._fileRecord?.root?.name || '파일';
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
    let viewDrag = null;
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
      el('button', { class: 'egd-rail-switcher', title: 'Board 목록', 'aria-label': 'Board 목록', onclick: toggleAgendaSwitcher },
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
        title: '선택한 Board 저장',
        'aria-label': '선택한 Board 저장',
        data: { testid: 'board-save' },
        hidden: !state.agenda.dirty,
        onclick: (ev) => {
          ev.stopPropagation();
          saveCurrentAgendaState();
        },
      }, '✓'),
      el('button', {
        class: 'egd-rail-icon egd-rail-restore-btn',
        title: '저장된 Board 열기',
        'aria-label': '저장된 Board 열기',
        hidden: !state.agenda.hasSavedState,
        onclick: (ev) => {
          ev.stopPropagation();
          restoreSavedAgendaState();
        },
      }, '↺'),
      el('button', {
        class: 'egd-rail-icon egd-rail-close-agenda-btn',
        title: 'Board 닫기',
        'aria-label': '선택한 Board 닫기',
        onclick: (ev) => {
          ev.stopPropagation();
          closeCurrentAgenda();
        },
      }, '×'),
      el('button', { class: 'egd-rail-icon', title: '미니맵', onclick: toggleDeskMinimap }, '◱'),
      el('button', { id: 'egd-recovery-open', class: 'egd-rail-icon', 'aria-label': '복구 기록', title: '복구 기록', hidden: true, onclick: () => renderDeskRecoveryNotice(true) }, '↶'),
      el('button', { class: 'egd-rail-icon', title: '알림 연결 전', 'aria-label': '알림 연결 전', disabled: 'true' }, '!'),
      el('div', { class: 'egd-rail-avatar', title: '로컬 Desk', 'aria-label': '로컬 Desk' }, '○'),
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
          data: { id: item.id, kind, ...(item.id === 'shelf' ? { testid: 'file-dock-open' } : {}) },
          'aria-label': item.label,
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
              } else if (item.id === 'shelf') {
                spawnFileCard();
              } else if (item.id === 'ontology') {
                spawnOntologyMapCard();
              } else if (item.id === 'chat') {
                state.codex.hudView = 'conversation';
                spawnCodexChatCard();
                state.codexBridge?.selectThread(state.codex.activeThreadId, { openConversation: true });
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
    bag.appendChild(el('button', { class: 'egd-bag-chip', title: '파일 작업 열기', 'aria-label': '파일 작업 열기',
      data: { testid: 'file-sidebar-open' }, onclick: () => spawnFileCard() }, '파일'));

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
      const computedStyle = getComputedStyle(hud);
      const computedLeft = Number.parseFloat(computedStyle.left);
      // visualOffset은 조상 transform/zoom 보정용 — HUD 자신의 진행 중
      // slide-in transform(translateX)까지 포함하면 오픈 직후 left가
      // 화면 중앙으로 밀렸다가 240ms 후 우측으로 스냅하는 글리치 발생.
      // 자기 transform의 X 성분은 측정에서 제외한다.
      let ownTx = 0;
      if (computedStyle.transform && computedStyle.transform !== 'none') {
        try { ownTx = new DOMMatrixReadOnly(computedStyle.transform).e; } catch {}
      }
      const visualOffset = Number.isFinite(computedLeft) ? rect.left - ownTx - computedLeft : 0;
      const width = Math.min(rect.width || 396, maxWidth);
      let left = Math.max(margin, viewportW - width - margin - visualOffset);
      hud.style.left = `${left}px`;
      hud.style.right = 'auto';
      // overflow 보정도 자기 transform 제외한 layout 기준으로 측정 —
      // gBCR 그대로 쓰면 slide-in 중 재측정이 left를 다시 중앙으로 끌어내린다
      const adjustedRect = hud.getBoundingClientRect();
      const overflowRight = (adjustedRect.right - ownTx) - viewportW + margin;
      if (overflowRight > 0) {
        left = Math.max(margin, left - overflowRight);
        hud.style.left = `${left}px`;
      }
      const finalRect = hud.getBoundingClientRect();
      const overflowLeft = margin - (finalRect.left - ownTx);
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
    return Markdown.plainMarkdownText(text);
  }
  function appendRichText(container, text, message, thread) {
    const run = thread && codexRuns(thread).find(item => item.answerId === message?.answerId
      && item.runId === message?.runId && item.conversationId === message?.conversationId);
    Markdown.appendMarkdown(container, text, {
      answerId: message?.answerId, runId: message?.runId, conversationId: message?.conversationId,
      artifacts: ChatState.nativeBindingHeld(thread) ? [] : run?.artifacts || message?.artifacts || [],
      openArtifact: artifact => {
        const current = getCodexThreadById(state.codex, thread?.id);
        if (current && !ChatState.nativeBindingHeld(current)) return openCodexResultLink(artifact);
        return false;
      },
      openWeb: url => openUrlInBrowserCard(url),
    });
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
    let composerObserver = null;
    let compositionInProgress = false;
    let deferredCodex = null;
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
      if (compositionInProgress) {
        deferredCodex = codex;
        return;
      }
      const oldInput = body.querySelector('.egd-codex-input');
      const oldMessages = body.querySelector('.egd-codex-messages');
      const inputState = oldInput ? {
        threadId: oldInput.dataset.threadId,
        focused: document.activeElement === oldInput,
        start: oldInput.selectionStart,
        end: oldInput.selectionEnd,
        direction: oldInput.selectionDirection,
        scrollTop: oldInput.scrollTop,
      } : null;
      const messageState = oldMessages ? {
        threadId: oldMessages.dataset.threadId,
        lastUserMessageId: oldMessages.dataset.lastUserMessageId,
        top: oldMessages.scrollTop,
        atBottom: oldMessages.scrollHeight - oldMessages.scrollTop - oldMessages.clientHeight < 24,
        anchor: (() => {
          const top = oldMessages.getBoundingClientRect();
          const row = Array.from(oldMessages.querySelectorAll('[data-testid="chat-message"]'))
            .find(item => item.getBoundingClientRect().bottom > top.top);
          return row ? { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top.top } : null;
        })(),
      } : null;
      composerObserver?.disconnect();
      composerObserver = null;
      body.textContent = '';
      const explicitActiveThread = codex.activeThreadId
        ? getCodexThreadById(codex, codex.activeThreadId)
        : null;
      const activeThread = explicitActiveThread || codex.threads[0] || null;
      if (activeThread && codex.activeThreadId !== activeThread.id) {
        codex.activeThreadId = activeThread.id;
      }

      const hudView = normalizeHudView(codex.hudView) === 'conversation' && explicitActiveThread
        ? 'conversation' : 'list';
      const isHudListView = hudView === 'list';
      const isHudConversationView = hudView === 'conversation';

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

      if (isHudListView) {
        const unreadCountTotal = codex.threads.reduce((sum, thread) => sum + (thread.unreadCount || 0), 0);
        threadTop.appendChild(el('div', { class: 'egd-codex-thread-home-head' },
          el('div', { class: 'egd-codex-thread-home-title-row' },
            el('div', { class: 'egd-codex-thread-home-title' }, 'Chat'),
            el('button', {
              class: 'egd-codex-thread-home-new',
              title: '새 Codex 대화',
              onclick: () => codexBridge.createThread('dm', { openConversation: true }),
            }, '+'),
          ),
          el('div', { class: 'egd-codex-thread-home-sub' }, 'Codex · 선택한 Agent'),
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
          el('button', {
            class: 'egd-codex-thread-menu-item', 'aria-label': '기본 Codex 선택',
            onclick: () => codexBridge.setThreadAgentProfile(thread.id, null),
          }, '기본 Codex'),
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
            onclick: () => codexBridge.createThread(options.type, { openConversation: true }),
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
          item.addEventListener('click', () => codexBridge.selectThread(thread.id, { openConversation: true }));
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
        if (mode === 'hud' || activeThread.type === 'dm') {
          const threadMenuOpen = Boolean(codex.threadMenu && codex.threadMenu.threadId === activeThread.id);
          conversation.appendChild(el('div', { class: 'egd-codex-conversation-hud-head' },
            el('button', {
              class: 'egd-codex-conversation-back',
              title: '목록 홈으로',
              'aria-label': '대화 목록으로 돌아가기',
              onclick: () => codexBridge.setHudView('list'),
            }, '←'),
            el('div', { class: 'egd-codex-conversation-hud-center' },
              el('div', { class: 'egd-codex-conversation-hud-title' }, activeThread.title),
              activeThread.type === 'group'
                ? el('div', { class: 'egd-codex-conversation-hud-sub' }, (activeThread.participants || []).join(' · '))
                : null,
            ),
            el('button', {
              class: `egd-codex-conversation-menu-trigger${threadMenuOpen ? ' egd-codex-conversation-menu-trigger-active' : ''}`,
              title: '채팅방 메뉴',
              'aria-label': '채팅방 메뉴',
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
            el('button', {
              class: 'egd-codex-conversation-back',
              'aria-label': '대화 목록으로 돌아가기',
              onclick: () => codexBridge.setHudView('list'),
            }, '←'),
            el('div', { class: 'egd-codex-thread-active-title' }, activeThread.title),
            el('button', {
              class: 'egd-codex-conversation-menu-trigger',
              'aria-label': '채팅방 메뉴',
              onclick: (ev) => {
                ev.stopPropagation();
                codexBridge.toggleThreadMenu(activeThread.id, ev.currentTarget);
              },
            }, '⋯'),
            memberRowWrap,
          ));
          if (codex.threadMenu?.threadId === activeThread.id) conversation.appendChild(renderThreadMenu(activeThread));
        }

        const messages = el('div', {
          class: 'egd-codex-messages',
          role: 'log',
          'aria-label': '대화 내역',
          'aria-live': 'polite',
          data: {
            threadId: activeThread.id,
            lastUserMessageId: activeThread.messages.filter(message => message.role === 'user').at(-1)?.id || '',
          },
        });
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
            if (message.role === 'assistant' && message.status === 'streaming' && !message.content) return;
            const previous = activeThread.messages[index - 1] || null;
            const next = activeThread.messages[index + 1] || null;
            const previousDelta = message.createdAt && previous?.createdAt ? Math.abs(message.createdAt - previous.createdAt) : Infinity;
            const nextDelta = message.createdAt && next?.createdAt ? Math.abs(next.createdAt - message.createdAt) : Infinity;
            const author = codexMessageAuthorLabel(message);
            const groupedWithPrevious = previous?.role === message.role && codexMessageAuthorLabel(previous) === author && previousDelta < 120000;
            const groupedWithNext = next?.role === message.role && codexMessageAuthorLabel(next) === author && nextDelta < 120000;
            const parts = extractCodexResultLinks(message);
            const content = el('div', { class: 'egd-codex-bubble-content egd-codex-richtext' });
            appendRichText(content, parts.text || (message.status === 'streaming' ? '…' : ''), message, activeThread);
            const resultChips = buildCodexResultChips(message, activeThread, parts.links);
            const briefingControl = BriefingState.validBriefing(message.briefing) ? el('button', {
              class: 'egd-codex-result-chip', data: { testid: 'briefing-open', answerId: message.answerId },
              onclick: () => openAnswerBriefing(activeThread, message),
            }, '브리핑 보기') : null;
            const bubble = el('div', {
              class: [
                'egd-codex-bubble',
                `egd-codex-bubble-${message.role}`,
                groupedWithPrevious ? 'egd-codex-bubble-grouped-prev' : '',
                groupedWithNext ? 'egd-codex-bubble-grouped-next' : '',
                ['error', 'failed'].includes(message.status) ? 'egd-codex-bubble-error' : '',
              ].filter(Boolean).join(' '),
            },
            content,
            );
            if (message.role === 'user' && ['submitting', 'unconfirmed', 'failed'].includes(message.status)) {
              bubble.appendChild(el('span', { class: 'egd-codex-message-time', role: 'status' }, ({ submitting: '보내는 중', unconfirmed: '접수 미확인', failed: '전송 거절됨' })[message.status]));
            }
            if (message.status === 'streaming' && message.role === 'assistant' && activeThread.profileEnabled === true && !ChatState.nativeBindingHeld(activeThread)) {
              bubble.appendChild(el('div', {
                class: 'egd-codex-streaming',
                role: 'status',
                'aria-label': `${author} 응답 중`,
              }, el('div', { class: 'egd-codex-typing-dots', 'aria-hidden': 'true' }, el('span'), el('span'), el('span'))));
            }
            const roleLabel = !groupedWithPrevious && message.role !== 'user'
              ? el('div', { class: 'egd-codex-message-role' }, author)
              : null;
            const meta = codexMessageTimeMeta(message, activeThread);
            const messageLine = el('div', { class: 'egd-codex-message-line' }, bubble);
            const messageStack = el('div', { class: 'egd-codex-message-stack' }, roleLabel, messageLine, resultChips, briefingControl, meta);
            if (message.inputReferences?.length) messageStack.appendChild(el('button', {
              class: 'egd-codex-result-chip', data: { testid: 'chat-message-inputs', requestId: message.requestId || '' },
              onclick: () => openCodexActivityPanel(activeThread.id),
            }, `첨부 입력 ${message.inputReferences.length}개 · 기록 보기`));
            const avatar = message.role !== 'user'
              ? el('div', {
                  class: `egd-codex-message-avatar${groupedWithPrevious ? ' egd-codex-message-avatar-spacer' : ''}`,
                  'aria-hidden': 'true',
                }, groupedWithPrevious ? '' : author.slice(0, 1))
              : null;
            messages.appendChild(el('div', {
              data: { messageId: message.id, runId: message.runId || '', testid: 'chat-message', role: message.role },
              class: [
                'egd-codex-message-row',
                `egd-codex-message-row-${message.role || 'assistant'}`,
                groupedWithPrevious ? 'egd-codex-message-row-grouped' : '',
              ].filter(Boolean).join(' '),
            }, avatar, messageStack));
          });
        }
        conversation.appendChild(messages);
        if (activeThread.localHistoryCoverage && activeThread.localHistoryCoverage.status !== 'complete') conversation.appendChild(el('p', {
          class: 'egd-codex-run-status', role: 'status', data: { testid: 'chat-local-history-coverage' },
        }, '로컬 기록 일부를 확인하지 못했습니다. 표시된 대화는 유지됩니다.'));
        if (codex.localHistoryStatus === 'error' && codex.localHistoryError) conversation.appendChild(el('p', {
          class: 'egd-codex-error', role: 'status', data: { testid: 'chat-local-history-error' },
        }, codex.localHistoryError));
        const bindingHeld = ChatState.nativeBindingHeld(activeThread);
        if (bindingHeld) conversation.appendChild(el('div', {
          class: 'egd-codex-error', role: 'status', data: { testid: 'chat-binding-held', bindingState: activeThread.bindingState },
        }, '이전 대화의 계정 소유가 확인되지 않아 연결을 보류했습니다. 로컬 기록은 유지됩니다.',
        el('button', { class: 'egd-codex-chip', 'aria-label': '새 Codex 대화 열기', data: { testid: 'chat-new-unbound-room' }, onclick: () => codexBridge.createThread('dm', { openConversation: true }) }, '새 Codex 대화')));
        const run = codexCurrentRun(activeThread);
        const pending = Object.values(codex.chatProtocol.requests).find(request => ChatState.requestBelongsToThread(request, activeThread) && ['submitting', 'unconfirmed'].includes(request.status));
        const status = activeThread.preparingInput ? 'preparing-input' : activeThread.resuming ? 'restoring' : pending?.status || run?.status || 'ready';
        const statusText = bindingHeld ? '로컬 기록 · 연결 확인 필요' : activeThread.preparingInput ? '첨부 캡처 준비 중 · 아직 전송하지 않음' : activeThread.resuming ? '대화 상태 확인 중' : pending ? (pending.status === 'unconfirmed' ? '접수 상태 확인 필요' : '요청 보내는 중')
          : !run && codex.chatProtocol.unobservedPreviousRun ? '이전 연결의 실행 상태 미확인' : codexRunLabel(run);
        conversation.appendChild(el('div', {
          class: 'egd-codex-run-status', role: 'status', 'aria-live': 'polite',
          data: { testid: 'chat-run-status', status, runId: run?.runId || '', stopConfirmed: String(run?.status === 'interrupted') },
        }, el('span', {}, statusText),
        el('button', { 'aria-label': '활동 기록 열기', data: { testid: 'chat-activity-open', threadId: activeThread.id }, onclick: () => codexBridge.openActivity(activeThread.id) }, run?.pendingApprovals?.length ? `활동 기록 · 승인 ${run.pendingApprovals.length}건` : '활동 기록')));
        if (pending?.status === 'unconfirmed') conversation.appendChild(el('button', {
          class: 'egd-codex-chip', 'aria-label': '요청 접수 상태 다시 확인', data: { testid: 'chat-reconcile' },
          onclick: () => codexBridge.reconcileRequest(activeThread.id),
        }, '접수 상태 다시 확인'));
        if (activeThread.sendError) conversation.appendChild(el('p', { class: 'egd-codex-error', role: 'alert' }, activeThread.sendError));
        if (!activeThread.messages.some(message => message.role === 'assistant' && message.runId === run?.runId)) {
          const chips = buildCodexResultChips(null, activeThread, run?.artifacts);
          if (chips) conversation.appendChild(chips);
        }
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

      const allowComposer = Boolean(activeThread && isHudConversationView);
      const footer = allowComposer
        ? (() => {
            const input = el('textarea', {
              class: 'egd-codex-input',
              rows: '2',
              placeholder: '메시지 보내기',
              'aria-label': `${activeThread.title}에 보낼 메시지`,
              data: { threadId: activeThread.id, testid: 'chat-composer' },
            });
            const sendButton = el('button', {
              class: 'egd-codex-send',
              type: 'button',
              'aria-label': '메시지 보내기',
              title: '보내기',
              data: { testid: 'chat-send' },
              onclick: () => { if (!compositionInProgress) void codexBridge.sendMessage(); },
            }, el('span', { 'aria-hidden': 'true' }, '↑'));
            input.value = getCodexThreadDraft(codex, activeThread.id);
            const resizeComposer = () => {
              if (!input.isConnected) return;
              input.style.height = 'auto';
              const height = Math.min(144, Math.max(48, input.scrollHeight));
              input.style.height = `${height}px`;
              input.style.overflowY = input.scrollHeight > height ? 'auto' : 'hidden';
              const nativeSendHeld = activeThread.conversationId && !ChatState.canResumeNativeThread(activeThread, codex.authStatus);
              sendButton.disabled = ChatState.nativeBindingHeld(activeThread) || nativeSendHeld || activeThread.preparingInput || codex.isSending || !input.value.trim() || !codex.authStatus.isLoggedIn || !codex.connected;
              sendButton.title = ChatState.nativeBindingHeld(activeThread) || nativeSendHeld ? '보관된 연결을 현재 계정에 자동 연결하지 않습니다' : !codex.authStatus.isLoggedIn ? 'Codex 연결 후 전송할 수 있습니다' : !codex.connected ? 'Codex 연결을 확인해 주세요' : '보내기';
            };
            input.addEventListener('input', () => {
              codexBridge.setDraft(input.value, activeThread.id);
              resizeComposer();
            });
            input.addEventListener('keydown', (ev) => {
              if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey) || ev.shiftKey || ev.altKey) return;
              if (ev.isComposing || compositionInProgress || ev.keyCode === 229) return;
              ev.preventDefault();
              void codexBridge.sendMessage();
            });
            input.addEventListener('compositionstart', () => { compositionInProgress = true; });
            input.addEventListener('compositionend', () => {
              compositionInProgress = false;
              codexBridge.setDraft(input.value, activeThread.id);
              resizeComposer();
              if (deferredCodex) {
                const next = deferredCodex;
                deferredCodex = null;
                queueMicrotask(() => render(next));
              }
            });
            let composerWidth = 0;
            composerObserver = new ResizeObserver(() => {
              if (input.clientWidth === composerWidth) return;
              composerWidth = input.clientWidth;
              resizeComposer();
            });
            composerObserver.observe(input);
            queueMicrotask(resizeComposer);
            const run = codexCurrentRun(activeThread);
            const stopButton = run && ChatState.isRunBusy(run) ? el('button', {
              class: 'egd-codex-stop', type: 'button', 'aria-label': '이 업무 중지',
              data: { testid: 'chat-stop', runId: run.runId, conversationId: run.conversationId },
              disabled: run.stopPending || run.stopRequested ? 'true' : null,
              onclick: () => codexBridge.interrupt(activeThread.id),
            }, run.stopRequested ? '확인 중' : '중지') : null;
            return el('div', { class: 'egd-codex-footer' },
              buildChatInputTray(activeThread, codexBridge),
              el('div', { class: 'egd-codex-input-row' },
                input,
                el('div', { class: 'egd-codex-compose-actions' }, stopButton, sendButton),
              ),
            );
          })()
        : null;

      const shellClasses = [
        'egd-codex-chat-shell',
        mode === 'canvas' ? 'egd-codex-chat-shell-canvas' : 'egd-codex-chat-shell-hud',
        `egd-codex-hud-view-${hudView}`,
      ].join(' ');
      const contentChildren = [];
      if (isHudListView) {
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
      if (msgEl) requestAnimationFrame(() => {
        if (!msgEl.isConnected) return;
        const sentNewMessage = msgEl.dataset.lastUserMessageId !== messageState?.lastUserMessageId;
        if (messageState?.threadId === activeThread?.id && !messageState.atBottom && !sentNewMessage) {
          const anchor = messageState.anchor && Array.from(msgEl.querySelectorAll('[data-testid="chat-message"]'))
            .find(item => item.dataset.messageId === messageState.anchor.id);
          msgEl.scrollTop = anchor
            ? msgEl.scrollTop + anchor.getBoundingClientRect().top - msgEl.getBoundingClientRect().top - messageState.anchor.offset
            : messageState.top;
        } else msgEl.scrollTop = msgEl.scrollHeight;
      });
      const newInput = body.querySelector('.egd-codex-input');
      if (newInput && inputState?.threadId === activeThread?.id && inputState.focused) {
        newInput.focus({ preventScroll: true });
        newInput.setSelectionRange(inputState.start, inputState.end, inputState.direction);
        requestAnimationFrame(() => { if (newInput.isConnected) newInput.scrollTop = inputState.scrollTop; });
      }
    };

    unsubscribe = codexBridge.subscribe(render)
    body._codexCleanup = () => {
      unsubscribe?.();
      composerObserver?.disconnect();
      compositionInProgress = false;
      deferredCodex = null;
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
      requestId: options.requestId || null,
      inputReferences: cloneJson(options.inputReferences || []),
      readBy,
      createdAt: Date.now(),
    };
  }

  function installCodexBridge(initialLegacyRecords = []) {
    const listeners = new Set();
    const protocol = state.codex.chatProtocol;
    const epochScope = ChatState.createChatEpochScope({ makeController: () => new window.AbortController() });
    const refreshing = new Map();
    const resumedNativeBindings = new Set();
    const confirmedLegacyImports = new Set();
    const initialDefaultThreadId = state.codex.threads[0]?.id;
    let localLoadPromise = null;
    let lastLocalLoadAt = 0;
    let legacyHistoryRecords = initialLegacyRecords;
    let localRetryTimer = null;
    let localRetryBudget = 1;
    let localAutoRetryEligible = false;
    let streamReady = false;
    let source = null;
    let reconnectTimer = null;

    function threadBusy(thread) {
      return !!thread?.resuming || !!thread?.preparingInput || ChatState.runsForThread(protocol, thread).some(ChatState.isRunBusy)
        || Object.values(protocol.requests).some(request => ChatState.requestBelongsToThread(request, thread) && ['submitting', 'unconfirmed'].includes(request.status));
    }

    function syncProtocolRun(run, { liveEvent = true } = {}) {
      if (!run) return;
      const threadId = run.localThreadId || state.codex.threads.find(thread => ChatState.clientThreadBinding(thread) === run.clientThreadId || thread.conversationId === run.conversationId)?.id;
      if (!threadId || !getCodexThreadById(state.codex, threadId)) return;
      if (ChatState.nativeBindingHeld(getCodexThreadById(state.codex, threadId))) return;
      run.localThreadId = threadId;
      const liveRevision = liveEvent ? ++state.codex.liveRevision : null;
      const thread = updateThreadById(threadId, current => ({
        ...current, conversationId: run.conversationId, sendError: null,
        ...ChatState.nativeBindingForRun(current, run),
        contextToolsAvailable: current.contextToolsAvailable === true || Array.isArray(run.contextCaptures),
        messages: (liveEvent ? ChatState.projectRunMessages(current.messages, run)
          : ChatState.mergeLocalChatMessages(current.messages, ChatState.projectRunMessages(current.messages, run))).map(message =>
          liveEvent && message.runId === run.runId && message.conversationId === run.conversationId
            ? { ...message, liveRevision, localHistory: false } : message),
      }));
      for (const message of run.messages) bindMessageToThread(message.id, threadId);
      if (thread) markUserMessagesReadBy(threadId, thread.profileEnabled ? codexThreadAgentProfile(thread).name : 'Codex');
    }

    async function captureThreadInputs(thread, sources, token) {
      if (!sources?.length) return [];
      if (sources.length > 16) throw new Error('한 요청에는 최대 16개 자료를 첨부할 수 있습니다. 첨부를 나누거나 제거해 주세요.');
      const attachments = [];
      for (const source of sources || []) {
        if (!epochScope.valid(token)) throw new Error('연결이 바뀌어 자료 캡처를 중단했습니다.');
        const snapshot = source.kind === 'file' ? null : (await captureChatInputs([source]))[0];
        const managedFileView = source.kind === 'file' && source.sourceRef?.draftId
          ? await captureManagedFileInput(source) : null;
        if (!epochScope.valid(token)) throw new Error('연결이 바뀌어 자료 캡처를 중단했습니다.');
        attachments.push(InputContext.captureAttachment(source, snapshot, Date.now(), managedFileView));
      }
      const result = await fetchJson('/context/captures', { method: 'POST', signal: token.signal,
        body: JSON.stringify({ clientThreadId: ChatState.clientThreadBinding(thread), attachments }) });
      if (!epochScope.valid(token)) throw new Error('연결이 바뀌어 자료 캡처를 중단했습니다.');
      if (!Array.isArray(result.captures) || result.captures.length !== sources.length) throw new Error('일부 첨부의 캡처 저장을 확인하지 못했습니다.');
      return sources.map(source => InputContext.capturedInputReference(source, result.captures.find(capture => capture.id === source.id)));
    }

    async function ensureNativeReadyForSend(thread) {
      if (!thread?.conversationId) return true;
      if (!ChatState.canResumeNativeThread(thread, state.codex.authStatus)) return false;
      const key = `${ChatState.clientThreadBinding(thread)}|${thread.conversationId}`;
      if (resumedNativeBindings.has(key)) return true;
      const snapshot = await refreshConversation(thread, true);
      if (!snapshot) return false;
      resumedNativeBindings.add(key);
      return true;
    }

    async function refreshConversation(thread, resume = false) {
      if (!thread?.conversationId || refreshing.has(thread.conversationId)) return null;
      if (resume && !ChatState.canResumeNativeThread(thread, state.codex.authStatus)) return null;
      const conversationId = thread.conversationId;
      const token = epochScope.begin();
      refreshing.set(conversationId, token);
      updateThreadById(thread.id, current => ({ ...current, resuming: true }));
      emit();
      try {
        const snapshot = resume
          ? await fetchJson('/chat/resume', { method: 'POST', signal: token.signal, body: JSON.stringify({ conversationId, clientThreadId: ChatState.clientThreadBinding(thread) }) })
          : await fetchJson(`/chat/state?conversationId=${encodeURIComponent(conversationId)}`, { signal: token.signal });
        if (!epochScope.valid(token)) return null;
        if (snapshot.conversationId !== conversationId) throw new Error('요청한 대화와 다른 연결 응답입니다. 기존 기록은 유지됩니다.');
        for (const run of ChatState.mergeChatSnapshot(protocol, snapshot, ChatState.clientThreadBinding(thread))) syncProtocolRun(run, { liveEvent: false });
        if (resume && ChatState.settleReconciledRequests(protocol, thread.id, snapshot)) updateThreadById(thread.id, current => ({ ...current, sendError: '대화 기록을 다시 확인했습니다. 접수 미확인 메시지와 실제 기록을 확인한 뒤 다음 요청을 보내세요.' }));
        emit();
        return snapshot;
      } catch (error) {
        if (!epochScope.valid(token)) return null;
        updateThreadById(thread.id, current => ({ ...current, sendError: `상태를 확인하지 못했습니다: ${error.message}` }));
        emit();
        return null;
      } finally {
        epochScope.finish(token);
        if (refreshing.get(conversationId) === token) refreshing.delete(conversationId);
        if (epochScope.valid(token)) {
          updateThreadById(thread.id, current => ({ ...current, resuming: false }));
          emit();
        }
      }
    }

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
        const agentProfileId = thread.profileEnabled === true ? normalizeCodexAgentProfileId(
          thread.agentProfileId,
          DEFAULT_CODEX_AGENT_PROFILE_ID
        ) : null;
        const agentProfile = codexAgentProfile(agentProfileId);
        return {
          ...thread,
          participants,
          participantRoles,
          profileEnabled: thread.profileEnabled === true,
          agentProfileId,
          toolMode: thread.profileEnabled === true ? thread.toolMode || agentProfile.toolMode : null,
          systemPrompt: thread.profileEnabled !== true ? null : typeof thread.systemPrompt === 'string' && thread.systemPrompt.trim()
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
      state.codex.isSending = threadBusy(active);
    };

    const emit = () => {
      normalizeThreads();
      for (const listener of listeners) {
        try { listener(state.codex); } catch (error) { console.warn(TAG, 'codex listener failed', error); }
      }
      renderCodexActivityPanel();
      scheduleDeskSessionSave();
    };
    const update = (patch) => {
      const accountKey = ChatState.codexAccountKey(patch.authStatus);
      if (ChatState.codexAccountChanged(state.codex.codexAccountKey, patch.authStatus)) resetThreadConversations();
      if (accountKey) state.codex.codexAccountKey = accountKey;
      Object.assign(state.codex, patch);
      state.codex.threads = state.codex.threads.map(thread => ChatState.reconcileNativeThread(thread, state.codex.authStatus));
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
      const liveRevision = ++state.codex.liveRevision;
      return updateThreadById(threadId, (thread) => ({
        ...thread,
        unreadCount: countUnread && thread.id !== state.codex.activeThreadId
          ? thread.unreadCount + 1
          : thread.unreadCount,
        messages: [...thread.messages, { ...message, liveRevision, localHistory: false }],
      }));
    };
    const patchMessageInThread = (threadId, messageId, updater) => {
      const liveRevision = ++state.codex.liveRevision;
      return updateThreadById(threadId, (thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId ? { ...updater(message), liveRevision, localHistory: false } : message
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
    const resetThreadConversations = () => {
      epochScope.reset();
      ChatState.resetChatProtocol(protocol);
      refreshing.clear();
      resumedNativeBindings.clear();
      streamReady = false;
      try { source?.close(); } catch {}
      source = null;
      state.codex.threads = state.codex.threads.map(thread => ({
        ...ChatState.detachNativeThread(thread, state.codex.codexAccountKey, chatBindingNonce()), updatedAt: Date.now(),
      }));
      state.codex.pendingThreadId = null;
      state.codex.messageThreadMap = {};
      state.codex.memberMenu = null;
      state.codex.threadMenu = null;
      state.codex.activityThreadId = null;
      document.getElementById('egd-codex-input-panel')?.remove();
      closeAnswerBriefing({ restore: false });
      state.codex.codexAccountKey = null;
      state.codex.connected = false;
      state.codex.loginLog = '';
      state.codex.error = null;
      normalizeThreads();
      scheduleReconnect();
    };

    const fetchJson = async (path, options = {}) => {
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid bridge path');
      const response = await fetch(`http://127.0.0.1:39218${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });
      if (!response.ok) {
        const text = await response.text();
        let payload = null;
        try { payload = JSON.parse(text); } catch {}
        const error = new Error(payload?.error || text || `${response.status} ${response.statusText}`);
        error.status = response.status;
        error.code = payload?.code || null;
        error.conversationId = payload?.conversationId || null;
        error.accepted = payload?.accepted;
        error.resumeRequired = payload?.resumeRequired;
        throw error;
      }
      return response.json();
    };

    async function listLocalHistoryThreads() {
      const threads = [];
      const seenIds = new Set();
      const seenCursors = new Set();
      let cursor = null;
      while (true) {
        const query = cursor == null ? '?limit=100' : `?cursor=${encodeURIComponent(cursor)}&limit=100`;
        const page = await fetchJson(`/chat/history/threads${query}`);
        if (page?.protocolVersion !== 1 || !Array.isArray(page.threads)) throw new Error('로컬 기록 목록 형식이 올바르지 않습니다.');
        for (const thread of page.threads) {
          if (typeof thread?.clientThreadId !== 'string' || !thread.clientThreadId || seenIds.has(thread.clientThreadId)) continue;
          seenIds.add(thread.clientThreadId);
          threads.push(thread);
        }
        if (page.hasMore !== true) return threads;
        if (page.nextCursor == null || seenCursors.has(String(page.nextCursor))) throw new Error('로컬 기록 목록 페이지 연결을 확인하지 못했습니다.');
        cursor = page.nextCursor;
        seenCursors.add(String(cursor));
      }
    }

    function ensureLocalHistoryThread(summary, detail = {}) {
      const clientThreadId = summary.clientThreadId;
      if (getCodexThreadById(state.codex, clientThreadId)) return;
      const type = detail.type === 'group' ? 'group' : 'dm';
      const title = detail.title || summary.title || 'Codex';
      const base = createCodexThread(type, title, detail.subtitle || '', {
        participants: detail.participants, participantRoles: detail.participantRoles,
        profileEnabled: detail.profileEnabled === true, agentProfileId: detail.agentProfileId,
      });
      const recordedAccountKey = detail.bindingAccountKey || detail.retainedNativeBinding?.accountKey;
      const originalAccountKey = ChatState.knownCodexAccountKey(recordedAccountKey) ? recordedAccountKey : null;
      const restored = ChatState.reconcileNativeThread(ChatState.detachNativeThread({ ...base, id: clientThreadId,
        createdAt: summary.createdAt || base.createdAt, updatedAt: summary.updatedAt || base.updatedAt,
        conversationId: detail.conversationId || summary.conversationId || null,
        localConversationId: summary.localConversationId,
        bindingAccountKey: originalAccountKey,
        retainedNativeBinding: detail.retainedNativeBinding || null,
      }, null, chatBindingNonce()), state.codex.authStatus);
      const placeholder = state.codex.threads.find(thread => thread.id === initialDefaultThreadId);
      if (placeholder && state.codex.threads.length === 1 && !placeholder.messages.length && !placeholder.conversationId
          && !placeholder.localConversationId && !placeholder.inputSources?.length && !placeholder.briefingInputs?.length
          && !getCodexThreadDraft(state.codex, placeholder.id)) {
        state.codex.threads = [restored];
        if (state.codex.activeThreadId === placeholder.id) state.codex.activeThreadId = restored.id;
      } else state.codex.threads = [...state.codex.threads, restored];
      emit();
    }

    async function loadLocalHistoryThread(summary) {
      const clientThreadId = summary.clientThreadId;
      let afterSeq = 0;
      const seenCursors = new Set();
      let knownGap = false;
      while (true) {
        const liveFenceRevision = state.codex.liveRevision;
        const page = await fetchJson(`/chat/history?clientThreadId=${encodeURIComponent(clientThreadId)}&afterSeq=${encodeURIComponent(afterSeq)}&limit=100`);
        const normalized = ChatState.normalizeLocalHistoryPage({ ...page,
          thread: { ...summary, ...(page.thread || {}) },
        }, clientThreadId);
        if (!normalized || normalized.localConversationId !== summary.localConversationId) throw new Error('로컬 기록의 채팅방 연결을 확인하지 못했습니다.');
        const seqs = normalized.events.map(event => event.seq);
        if (seqs.some((seq, index) => !Number.isSafeInteger(seq) || seq <= Number(afterSeq)
            || index > 0 && seq <= seqs[index - 1])) knownGap = true;
        if (normalized.knownGap || normalized.hasMore && !seqs.length) knownGap = true;
        const coverage = normalized.coverage || summary.coverage || { scope: 'egdesk-local', status: 'unknown', reasons: [], nativeHistoryComplete: null };
        if (knownGap || normalized.hasMore) normalized.coverage = { ...coverage, status: 'partial', reasons: [
          ...(coverage.reasons || []), knownGap ? 'local-event-gap' : 'pagination-in-progress',
        ] };
        ensureLocalHistoryThread(summary, normalized.threadSnapshot);
        const current = getCodexThreadById(state.codex, clientThreadId);
        if (current?.localConversationId && current.localConversationId !== normalized.localConversationId) throw new Error('로컬 기록의 채팅방 식별자가 바뀌었습니다.');
        updateThreadById(clientThreadId, current => ChatState.hydrateLocalChatThread(current, normalized, { liveFenceRevision }));
        emit();
        if (!normalized.hasMore) return;
        const nextSeq = Number(normalized.nextCursor);
        if (!Number.isSafeInteger(nextSeq) || nextSeq <= Number(afterSeq) || seenCursors.has(String(nextSeq))) throw new Error('로컬 기록 페이지 연결을 확인하지 못했습니다.');
        afterSeq = nextSeq;
        seenCursors.add(String(afterSeq));
      }
    }

    function queueLocalHistoryRetry() {
      if (!localAutoRetryEligible || localRetryBudget <= 0 || localRetryTimer) return;
      localRetryTimer = window.setTimeout(() => {
        localRetryTimer = null;
        if (state.codex.localHistoryStatus !== 'error' || localRetryBudget <= 0) return;
        localRetryBudget--;
        void loadLocalHistory([], { force: true });
      }, 30000);
    }

    async function loadLocalHistory(legacyRecords = [], { force = false } = {}) {
      if (legacyRecords.length) legacyHistoryRecords = legacyRecords;
      if (!state.codex.localHistoryBootReady) return false;
      if (state.codex.localHistoryStatus === 'unsupported') return false;
      if (localLoadPromise) return localLoadPromise;
      if (!force && state.codex.localHistoryStatus === 'error' && Date.now() - lastLocalLoadAt < 30000) return false;
      lastLocalLoadAt = Date.now();
      localLoadPromise = (async () => {
        state.codex.localHistoryStatus = 'loading';
        emit();
        let stage = 'list';
        try {
          let summaries = await listLocalHistoryThreads();
          const existing = new Set(summaries.map(thread => thread.clientThreadId));
          const acknowledged = new Map();
          if (state.codex.legacyChatBackupKey) for (const record of legacyHistoryRecords) {
            if (existing.has(record.clientThreadId) || confirmedLegacyImports.has(record.importId)) continue;
            const snapshot = ChatState.legacyPublicChatSnapshot(record);
            if (!snapshot) continue; // Empty rooms and unrecognized roles remain in the backed-up pref.
            stage = 'import';
            const result = await fetchJson('/chat/history/import', { method: 'POST', body: JSON.stringify({
              clientThreadId: record.clientThreadId, importId: record.importId, snapshot,
            }) });
            if (result.clientThreadId !== record.clientThreadId || !result.imported && !result.alreadyImported) throw new Error('로컬 기록 가져오기 확인에 실패했습니다.');
            acknowledged.set(record.clientThreadId, record.importId);
          }
          if (acknowledged.size) {
            stage = 'list';
            summaries = await listLocalHistoryThreads();
            const visible = new Set(summaries.map(thread => thread.clientThreadId));
            if ([...acknowledged.keys()].some(clientThreadId => !visible.has(clientThreadId))) throw new Error('가져온 로컬 기록을 목록에서 확인하지 못했습니다.');
            for (const importId of acknowledged.values()) confirmedLegacyImports.add(importId);
          }
          stage = 'history';
          for (const summary of summaries) await loadLocalHistoryThread(summary);
          const backupFailed = state.codex.legacyChatBackupRequired && !state.codex.legacyChatBackupKey;
          state.codex.localHistoryStatus = backupFailed ? 'error' : 'ready';
          state.codex.localHistoryError = backupFailed ? '기존 채팅 기록의 백업을 확인하지 못했습니다. 원본 저장값은 유지됩니다.' : null;
          localAutoRetryEligible = false;
          if (localRetryTimer) { window.clearTimeout(localRetryTimer); localRetryTimer = null; }
          emit();
          return true;
        } catch (error) {
          if (error.status === 404 && stage === 'list') {
            // Older fixture transports do not implement local history yet.
            state.codex.localHistoryStatus = 'unsupported';
            state.codex.localHistoryError = null;
            localAutoRetryEligible = false;
          } else {
            state.codex.localHistoryStatus = 'error';
            state.codex.localHistoryError = '로컬 기록을 확인하지 못했습니다. 기존 채팅과 초안은 유지됩니다.';
            localAutoRetryEligible = error.status == null || error.status >= 500;
            queueLocalHistoryRetry();
            console.warn(TAG, 'local chat history load failed', error);
          }
          emit();
          return false;
        }
      })();
      try { return await localLoadPromise; }
      finally { localLoadPromise = null; }
    }

    const scheduleReconnect = () => {
      if (reconnectTimer) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1200);
    };

    const handleEvent = (event) => {
      if (event?.type?.startsWith('assistant-')) return;
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
          if (event.v === 2) {
            if (!ChatState.canAdmitChatEvent(protocol, state.codex.threads, event)) return;
            const run = ChatState.reduceChatEvent(protocol, event);
            if (run) { syncProtocolRun(run); emit(); }
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
      }
    };

    const connect = async () => {
      const token = epochScope.begin();
      streamReady = false;
      try {
      try {
        const bridgeState = await fetchJson('/v1/state', { signal: token.signal });
        if (!epochScope.valid(token)) return;
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
        if (!epochScope.valid(token)) return;
        try {
          const status = await fetchJson('/auth/status', { signal: token.signal });
          if (!epochScope.valid(token)) return;
          update({ authStatus: status, isStartingLogin: Boolean(status.loginInProgress), connected: true, error: null });
        } catch (fallbackError) {
          if (!epochScope.valid(token)) return;
          update({ connected: false, error: `코덱스 브리지에 연결할 수 없습니다: ${fallbackError.message}` });
          scheduleReconnect();
        }
      }

      if (!epochScope.valid(token)) return;
      const streamEpoch = epochScope.current();
      try {
        source = new EventSource('http://127.0.0.1:39218/events?chatProtocol=2');
      } catch (error) {
        scheduleReconnect();
        return;
      }

      const connectionSource = source;
      connectionSource.addEventListener('ready', () => {
        if (!epochScope.valid(streamEpoch) || source !== connectionSource) return;
        streamReady = true;
        resumedNativeBindings.clear();
        update({ connected: true });
        if (state.codex.localHistoryStatus === 'error') {
          if (localAutoRetryEligible && localRetryBudget > 0) {
            localRetryBudget--;
            if (localRetryTimer) { window.clearTimeout(localRetryTimer); localRetryTimer = null; }
            void loadLocalHistory([], { force: true });
          }
        } else void loadLocalHistory();
      });

      const receive = (message) => {
        if (!epochScope.valid(streamEpoch) || source !== connectionSource) return;
        try {
          handleEvent(JSON.parse(message.data));
        } catch (error) {
          console.warn(TAG, 'codex event parse failed', error);
        }
      };
      source.addEventListener('codex', receive);
      source.addEventListener('message', receive);
      source.addEventListener('chat.event', receive);

      connectionSource.onerror = () => {
        if (!epochScope.valid(streamEpoch) || source !== connectionSource) return;
        try { connectionSource.close(); } catch {}
        source = null;
        streamReady = false;
        protocol.connection = 'offline';
        update({ connected: false });
        scheduleReconnect();
      };
      } finally { epochScope.finish(token); }
    };

    connect();

    return {
      loadLocalHistory,
      async reconcileRequest(threadId = state.codex.activeThreadId) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread) return null;
        if (thread.conversationId) return refreshConversation(thread, false);
        const token = epochScope.begin();
        try {
          const snapshot = await fetchJson('/chat/state', { signal: token.signal });
          if (!epochScope.valid(token)) return null;
          const requests = Object.values(protocol.requests).filter(request => ChatState.requestBelongsToThread(request, thread));
          const matching = (snapshot.runs || []).filter(run => requests.some(request => request.requestId === run.requestId));
          for (const run of matching) {
            for (const updated of ChatState.mergeChatSnapshot(protocol, { ...snapshot, conversationId: run.conversationId, runs: [run] }, ChatState.clientThreadBinding(thread))) syncProtocolRun(updated, { liveEvent: false });
          }
          if (!matching.length) updateThreadById(threadId, current => ({ ...current, sendError: '서버에서 이 요청의 실행을 아직 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.' }));
          emit();
          return snapshot;
        } catch (error) {
          if (epochScope.valid(token)) { updateThreadById(threadId, current => ({ ...current, sendError: error.message })); emit(); }
          return null;
        } finally { epochScope.finish(token); }
      },
      refreshConversation(threadId = state.codex.activeThreadId) {
        return refreshConversation(getCodexThreadById(state.codex, threadId), false);
      },
      runState(threadId = state.codex.activeThreadId) {
        return cloneJson(ChatState.runsForThread(protocol, getCodexThreadById(state.codex, threadId)));
      },
      openActivity(threadId = state.codex.activeThreadId) { openCodexActivityPanel(threadId); },
      async replyApproval({ approvalId, conversationId, runId, decision }) {
        const run = protocol.runs[ChatState.runKey(conversationId, runId)];
        const approval = run?.pendingApprovals.find(item => (item.approvalId || item.id) === approvalId);
        const request = ChatState.approvalRequestFor(run, approvalId, decision);
        if (!request) return false;
        const token = epochScope.begin();
        approval.replyPending = true;
        emit();
        try {
          const result = await fetchJson('/chat/approval', { method: 'POST', signal: token.signal, body: JSON.stringify(request) });
          if (!epochScope.valid(token)) return false;
          ChatState.acknowledgeApprovalReply(run, result);
          return result;
        } catch (error) {
          if (!epochScope.valid(token)) return false;
          const current = run.pendingApprovals.find(item => (item.approvalId || item.id) === approvalId) || approval;
          current.stale = error.code === 'STALE_APPROVAL' || error.status === 409;
          current.error = current.stale ? '이 승인은 더 이상 유효하지 않습니다. 현재 상태를 다시 확인해 주세요.' : `응답 전달 여부를 확인하지 못했습니다: ${error.message}`;
          return false;
        } finally { epochScope.finish(token); if (epochScope.valid(token)) { approval.replyPending = false; emit(); } }
      },
      async interrupt(threadId = state.codex.activeThreadId) {
        const thread = getCodexThreadById(state.codex, threadId);
        const run = ChatState.runsForThread(protocol, thread).findLast(ChatState.isRunBusy);
        if (!run || run.stopPending || run.stopRequested) return false;
        const token = epochScope.begin();
        run.stopPending = true;
        emit();
        try {
          const result = await fetchJson('/chat/interrupt', { method: 'POST', signal: token.signal, body: JSON.stringify({ conversationId: run.conversationId, runId: run.runId }) });
          if (!epochScope.valid(token)) return false;
          if (result.accepted && result.stopRequested && ChatState.isRunBusy(run)) {
            run.stopRequested = true;
            run.status = 'stopping';
          } else if (!result.accepted) {
            updateThreadById(threadId, current => ({ ...current, sendError: '중지 요청이 수락되지 않았습니다. 상태를 다시 확인해 주세요.' }));
          }
          return result;
        } catch (error) {
          if (!epochScope.valid(token)) return false;
          updateThreadById(threadId, current => ({ ...current, sendError: `중지 여부를 확인하지 못했습니다: ${error.message}` }));
          return false;
        } finally { epochScope.finish(token); if (epochScope.valid(token)) { run.stopPending = false; emit(); } }
      },
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
        if (getCodexThreadDraft(state.codex, threadId) !== value) {
          state.codex.threadDraftRevisions[threadId] = (state.codex.threadDraftRevisions[threadId] || 0) + 1;
        }
        state.codex.threadDrafts = {
          ...(state.codex.threadDrafts || {}),
          [threadId]: value,
        };
        if (threadId === state.codex.activeThreadId) {
          state.codex.draft = value;
        }
        scheduleDeskSessionSave();
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
      addInputSources(threadId, sources) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || thread.preparingInput) return;
        updateThreadById(threadId, thread => ({ ...thread, inputSources: InputContext.addInputSources(thread.inputSources, sources) }));
        state.codex.activeThreadId = threadId;
        state.codex.hudView = 'conversation';
        emit();
        if (!state.hudOpen && state.codex.chatDockMode !== 'canvas') toggleHUD('chat', '채팅');
      },
      removeInputSource(threadId, sourceId) {
        if (getCodexThreadById(state.codex, threadId)?.preparingInput) return;
        updateThreadById(threadId, thread => ({ ...thread, inputSources: InputContext.removeInputSource(thread.inputSources, sourceId) }));
        emit();
      },
      async captureInputs(threadId, sources) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || ChatState.nativeBindingHeld(thread)) return null;
        const token = epochScope.begin();
        try { return await captureThreadInputs(thread, sources, token); }
        finally { epochScope.finish(token); }
      },
      async inspectInput(threadId, reference, options = {}) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || !reference?.snapshotId) return;
        const nonce = state.codex.inputInspectNonce = (state.codex.inputInspectNonce || 0) + 1;
        const stored = await this.readInput(reference, options);
        if (!stored || state.codex.inputInspectNonce !== nonce) return;
        const snapshot = InputContext.storedSnapshotForView(stored, reference);
        openChatInputPanel(threadId, { snapshots: [snapshot] });
        const priorPages = options.pageRanges || [];
        const currentPage = snapshot.range ? { startLine: snapshot.range.startLine, endLine: snapshot.range.endLine } : null;
        const selectedPacketId = options.packetId || snapshot.delivered?.packetId;
        const nav = el('nav', { class: 'egd-codex-input-panel-footer', tabindex: '-1', 'aria-label': '저장된 입력 페이지', data: { testid: 'chat-input-pagination' } },
          el('button', { disabled: priorPages.length ? null : 'true', 'aria-label': '이전 캡처 페이지', data: { testid: 'chat-input-previous' },
            onclick: () => this.inspectInput(threadId, reference, { ...priorPages.at(-1), pageRanges: priorPages.slice(0, -1), packetId: selectedPacketId }) }, '이전'),
          el('span', { 'aria-live': 'polite' }, snapshot.range ? `${snapshot.range.startLine}–${snapshot.range.endLine} / ${snapshot.range.totalLines ?? '?'}행` : '바이너리 캡처'),
          el('button', { disabled: snapshot.nextLine == null ? 'true' : null, 'aria-label': '다음 캡처 페이지', data: { testid: 'chat-input-next' },
            onclick: () => this.inspectInput(threadId, reference, { startLine: snapshot.nextLine, pageRanges: [...priorPages, currentPage], packetId: selectedPacketId }) }, '다음'));
        document.getElementById('egd-codex-input-panel')?.appendChild(nav);
        const packet = el('input', { type: 'text', placeholder: '기록된 packetId', 'aria-label': '과거 전달 packet ID', data: { testid: 'chat-input-packet-id' } });
        packet.value = selectedPacketId || '';
        document.querySelector('#egd-codex-input-panel .egd-codex-input-panel-body')?.appendChild(el('details', { class: 'egd-input-snapshot-metadata' },
          el('summary', {}, '다른 전달 기록 찾기'), packet,
          el('button', { 'aria-label': '지정한 과거 전달본 조회', data: { testid: 'chat-input-packet-open' }, onclick: () => {
            if (packet.value.trim()) void this.inspectInput(threadId, reference, { ...(currentPage || { startLine: 1 }), packetId: packet.value.trim() });
          } }, '전달본 조회')));
        if (options.pageRanges) nav.focus();
      },
      async readInput(reference, options = {}) {
        if (!reference?.sourceId) return null;
        const token = epochScope.begin();
        try {
          const { startLine, endLine } = InputContext.projectionRange({ startLine: options.startLine, endLine: options.endLine });
          const query = `?startLine=${startLine}${options.endLine !== undefined ? `&endLine=${endLine}` : ''}${options.packetId ? `&packetId=${encodeURIComponent(options.packetId)}` : ''}`;
          const stored = await fetchJson(`/context/captures/${encodeURIComponent(reference.sourceId)}${query}`, { signal: token.signal });
          if (!epochScope.valid(token)) return;
          InputContext.storedSnapshotForView(stored, reference);
          if (stored.source.range && stored.source.range.startLine !== startLine) throw new Error('요청한 캡처 페이지 범위가 반환되지 않았습니다.');
          if (options.packetId && stored.delivered?.packetId !== options.packetId) throw new Error('지정한 과거 전달본이 반환되지 않았습니다.');
          return stored;
        } catch (error) { if (epochScope.valid(token)) boardNotice(`당시 입력을 열지 못했습니다: ${error.message}`); }
        finally { epochScope.finish(token); }
      },
      async openInputEvidence(threadId, reference, options = {}) {
        if (!getCodexThreadById(state.codex, threadId)) return null;
        const stored = await this.readInput(reference, reference.presentationRange);
        if (options.isCurrent && !options.isCurrent()) return null;
        if (stored?.source.text === null) { boardNotice('이 고정 원문은 바이너리입니다. 당시 입력 inspector에서 형식·전달 기록을 확인할 수 있습니다.'); return null; }
        return stored ? spawnInputEvidence(reference, stored) : null;
      },
      removeBriefingInput(threadId, sourceId) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || thread.preparingInput) return;
        updateThreadById(threadId, item => ({ ...item, briefingInputs: (item.briefingInputs || []).filter(reference => reference.sourceId !== sourceId) }));
        emit();
      },
      attachBriefingComment(threadId, comment, references) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || thread.preparingInput || ChatState.nativeBindingHeld(thread)) return;
        const current = getCodexThreadDraft(state.codex, threadId);
        this.setDraft(`${current ? `${current}\n\n` : ''}${comment.text}`, threadId);
        updateThreadById(threadId, item => ({ ...item, briefingInputs: [...new Map([...(item.briefingInputs || []),
          ...references.filter(reference => comment.contextSnapshotIds.includes(reference.sourceId))].map(reference => [reference.sourceId, reference])).values()] }));
        state.codex.activeThreadId = threadId;
        state.codex.hudView = 'conversation';
        emit();
        if (!state.hudOpen && state.codex.chatDockMode !== 'canvas') toggleHUD('chat', '채팅');
        boardNotice('단계 의견을 Chat 초안에 넣었습니다. 전송 전에는 새 업무를 시작하지 않습니다.');
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
          profileEnabled: !!profileId,
          agentProfileId: profileId ? normalizedProfileId : null,
          toolMode: profileId ? profile.toolMode : null,
          systemPrompt: profileId ? profile.systemPrompt : null,
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
        if (openConversation) {
          state.codex.hudView = 'conversation';
        }
        state.codex.draft = getCodexThreadDraft(state.codex, threadId);
        const selected = getCodexThreadById(state.codex, threadId);
        if (selected?.conversationId) void refreshConversation(selected, true);
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
        const label = normalizedType === 'group' ? `대화 ${nextNonce}` : `Codex ${nextNonce}`;
        const participants = normalizedType === 'group'
          ? [SELF_MEMBER, 'Codex']
          : [SELF_MEMBER, 'Codex'];
        const thread = createCodexThread(normalizedType, label, '', {
          participants,
          agentProfileId: options.agentProfileId,
          profileEnabled: options.profileEnabled === true,
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
        if (options.openConversation !== false) {
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
        const token = epochScope.begin();
        try {
          const bridgeState = await fetchJson('/v1/state', { signal: token.signal });
          if (!epochScope.valid(token)) return;
          const status = bridgeState?.auth || state.codex.authStatus;
          update({
            provider: bridgeState?.provider || state.codex.provider,
            protocolVersion: Number(bridgeState?.protocolVersion || state.codex.protocolVersion || 0),
            authStatus: status,
            isStartingLogin: Boolean(status.loginInProgress),
            error: null,
          });
        } catch (error) {
          if (!epochScope.valid(token)) return;
          try {
            const status = await fetchJson('/auth/status', { signal: token.signal });
            if (!epochScope.valid(token)) return;
            update({ authStatus: status, isStartingLogin: Boolean(status.loginInProgress), error: null });
          } catch (fallbackError) {
            if (!epochScope.valid(token)) return;
            update({ error: fallbackError.message });
          }
        } finally { epochScope.finish(token); }
      },
      async startLogin() {
        const token = epochScope.begin();
        try {
          update({ error: null });
          const result = await fetchJson('/auth/start', { method: 'POST', signal: token.signal });
          if (!epochScope.valid(token)) return;
          if (!result.started) {
            update({
              isStartingLogin: Boolean(result.loginInProgress),
              error: result.loginInProgress || result.alreadyLoggedIn ? null : result.message
            });
            await this.refreshAuthStatus();
          }
        } catch (error) {
          if (epochScope.valid(token)) update({ error: error.message });
        } finally { epochScope.finish(token); }
      },
      async signOut() {
        const token = epochScope.begin();
        try {
          const status = await fetchJson('/auth/signout', { method: 'POST', signal: token.signal });
          if (!epochScope.valid(token)) return;
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
          if (epochScope.valid(token)) update({ error: error.message });
        } finally { epochScope.finish(token); }
      },
      async sendMessage() {
        const activeThread = getActiveCodexThread(state.codex);
        const draftText = getCodexThreadDraft(state.codex, activeThread?.id || null);
        const content = draftText.trim();
        if (!activeThread || ChatState.nativeBindingHeld(activeThread) || !content || threadBusy(activeThread) || !state.codex.authStatus.isLoggedIn || !state.codex.connected
            || (activeThread.conversationId && !ChatState.canResumeNativeThread(activeThread, state.codex.authStatus))) return;
        const token = epochScope.begin();
        const submittedDraft = ChatState.snapshotChatDraft(activeThread, draftText, state.codex.threadDraftRevisions[activeThread.id] || 0);
        const selectedInputs = submittedDraft.inputSources;
        let submittedWasCleared = false;
        let inputReferences;
        if (!await ensureNativeReadyForSend(activeThread) || !epochScope.valid(token)) { epochScope.finish(token); return; }
        const resumedThread = getCodexThreadById(state.codex, activeThread.id);
        if (!resumedThread || ChatState.clientThreadBinding(resumedThread) !== ChatState.clientThreadBinding(activeThread)
            || resumedThread.conversationId !== activeThread.conversationId || threadBusy(resumedThread)) { epochScope.finish(token); return; }
        updateThreadById(activeThread.id, thread => ({ ...thread, preparingInput: true, sendError: null }));
        emit();
        try {
          inputReferences = [...await captureThreadInputs(activeThread, selectedInputs, token), ...submittedDraft.briefingInputs];
          if (!epochScope.valid(token)) { epochScope.finish(token); return; }
          const current = getCodexThreadById(state.codex, activeThread.id);
          if (!current || ChatState.clientThreadBinding(current) !== ChatState.clientThreadBinding(activeThread)) throw new Error('대화 연결이 바뀌었습니다. 초안을 다시 확인해 주세요.');
        } catch (error) {
          if (epochScope.valid(token)) updateThreadById(activeThread.id, thread => ({ ...thread, sendError: `자료를 준비하지 못해 전송하지 않았습니다: ${error.message}` }));
          epochScope.finish(token);
          return;
        } finally {
          if (epochScope.valid(token)) { updateThreadById(activeThread.id, thread => ({ ...thread, preparingInput: false })); emit(); }
        }
        const requestId = `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        ChatState.registerChatRequest(protocol, { requestId, clientThreadId: ChatState.clientThreadBinding(activeThread), localThreadId: activeThread.id, conversationId: activeThread.conversationId, authorName: activeThread.profileEnabled ? codexThreadAgentProfile(activeThread).name : 'Codex' }, state.codex.authStatus);
        appendMessageToThread(activeThread.id, createCodexMessage('user', content, 'submitting', {
          readBy: [SELF_MEMBER], requestId, inputReferences,
        }), { countUnread: false });
        state.codex.error = null;
        const currentComposer = getCodexThreadById(state.codex, activeThread.id);
        submittedWasCleared = ChatState.chatDraftMatches(currentComposer, getCodexThreadDraft(state.codex, activeThread.id), state.codex.threadDraftRevisions[activeThread.id] || 0, submittedDraft);
        if (submittedWasCleared) {
          updateThreadById(activeThread.id, thread => ({ ...thread, sendError: null, inputSources: [], briefingInputs: [] }));
          state.codex.threadDrafts = { ...state.codex.threadDrafts, [activeThread.id]: '' };
        }
        state.codex.draft = getCodexThreadDraft(state.codex, state.codex.activeThreadId);
        emit();
        try {
          const runtimeConfig = codexThreadRuntimeConfig(activeThread);
          runtimeConfig.contextSnapshotIds = inputReferences.map(reference => reference.snapshotId);
          runtimeConfig.contextCapabilities = ChatState.contextCapabilitiesForRequest(activeThread, state.codex.authStatus, runtimeConfig.contextSnapshotIds);
          const result = await fetchJson('/chat/send', {
            method: 'POST',
            signal: token.signal,
            body: JSON.stringify(ChatState.buildChatRequest(activeThread, content, requestId, runtimeConfig)),
          });
          if (!epochScope.valid(token)) return;
          const run = ChatState.acceptChatRequest(protocol, result, requestId);
          if (run) syncProtocolRun(run);
          else {
            const error = new Error(result.error || '실행 접수 상태를 확인하지 못했습니다.');
            error.status = result.accepted === false ? 400 : 0;
            error.conversationId = result.conversationId || null;
            error.accepted = result.accepted;
            error.resumeRequired = result.resumeRequired;
            throw error;
          }
        } catch (error) {
          if (!epochScope.valid(token)) return;
          const request = protocol.requests[requestId];
          if (error.conversationId) {
            request.conversationId = error.conversationId;
            updateThreadById(activeThread.id, thread => ({ ...thread, conversationId: error.conversationId, ...ChatState.nativeBindingForRun(thread, { conversationId: error.conversationId, accountKey: request.accountKey }) }));
          }
          // An event can prove acceptance before a failed/late HTTP response arrives.
          if (!request.runId) {
            request.status = ChatState.submissionFailureStatus(error);
            const liveRevision = ++state.codex.liveRevision;
            updateThreadById(activeThread.id, thread => ({ ...thread,
              sendError: request.status === 'unconfirmed' ? `접수 여부를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. ${error.message}` : error.message,
              messages: thread.messages.map(message => message.requestId === requestId ? { ...message, status: request.status, liveRevision, localHistory: false } : message),
            }));
            if (request.status === 'failed' && submittedWasCleared
                && ChatState.chatDraftMatches(getCodexThreadById(state.codex, activeThread.id), getCodexThreadDraft(state.codex, activeThread.id), state.codex.threadDraftRevisions[activeThread.id] || 0,
                  { text: '', revision: submittedDraft.revision, inputSources: [], briefingInputs: [] })) {
              state.codex.threadDrafts[activeThread.id] = submittedDraft.text;
              updateThreadById(activeThread.id, thread => ({ ...thread, inputSources: InputContext.addInputSources(thread.inputSources, selectedInputs), briefingInputs: submittedDraft.briefingInputs }));
            }
          }
        } finally { epochScope.finish(token); if (epochScope.valid(token)) emit(); }
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
    const width = Math.min(440, Math.max(360, Math.floor(safe.width / zoom)));
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
      el('div', { class: 'egd-chat-card-title' }, '채팅'),
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

    const routeWheelToCanvas = (ev) => {
      if (ev.ctrlKey || ev.metaKey) return;
      const allowCardScroll = state.activeEntityId === card.id && body.contains(ev.target);
      if (allowCardScroll) return;
      if (typeof state.panCanvasByWheel !== 'function') return;
      ev.preventDefault();
      ev.stopPropagation();
      state.panCanvasByWheel(ev);
    };

    const activateCard = () => {
      if (state.panModifier) return;
      card.style.zIndex = String(++cardZ);
      setActiveEntity(card);
    };
    const focusCard = activateCard;
    const startPanIfNeeded = (ev) => {
      if (!state.panModifier || ev.button !== 0) return false;
      if (typeof state.startCanvasPanDrag !== 'function') return false;
      state.startCanvasPanDrag(ev);
      return true;
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
    card.addEventListener('focusin', () => activateCard());
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
    // 재표시 경로(카드 풀스크린 해제 등)에서도 도킹 위치 재계산 —
    // 이전 오픈에서 남은 inline left가 stale하면 중앙에 도킹되는 잔존 버그 방지
    if (!hidden) syncHudViewportFit();
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

  function syncOntologyPresentationState() {
    document.documentElement.classList.remove('egd-ontology-focus-active', 'egd-ontology-object-focus-active');
    syncViewportAgendaRail();
  }

  function closeCanvasCard(card, cleanup) {
    if (!card) return false;
    if (card._beforeClose && !card._closeApproved) {
      return Promise.resolve().then(() => card._beforeClose()).then(confirmed => {
        if (confirmed !== true) return false;
        card._closeApproved = true;
        return closeCanvasCard(card, cleanup);
      }).catch(error => { boardNotice(`파일 창을 유지했습니다: ${error.message}`); return false; });
    }
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
    syncOntologyPresentationState();
    markAgendaDirty('close-card', card);
    return true;
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

  const DESK_WINDOW_RESIZE_HITS = [
    { cls: 'egd-card-resize-hit-n', edges: { top: true } },
    { cls: 'egd-card-resize-hit-e', edges: { right: true } },
    { cls: 'egd-card-resize-hit-s', edges: { bottom: true } },
    { cls: 'egd-card-resize-hit-w', edges: { left: true } },
    { cls: 'egd-card-resize-hit-nw', edges: { top: true, left: true } },
    { cls: 'egd-card-resize-hit-ne', edges: { top: true, right: true } },
    { cls: 'egd-card-resize-hit-se', edges: { bottom: true, right: true } },
    { cls: 'egd-card-resize-hit-sw', edges: { bottom: true, left: true } },
  ];

  function spawnDeskWindowShell(options = {}) {
    const kind = String(options.kind || 'window');
    const className = ['egd-canvas-card', 'egd-desk-window', options.className]
      .filter(Boolean)
      .join(' ');
    const root = el('div', {
      id: options.id,
      class: className,
      data: {
        deskWindowKind: kind,
        deskWindowInputPolicy: options.inputPolicy || 'document-ui',
      },
      style: options.style || {},
    });
    const cleanupStack = [];
    const resizeListeners = new Set();
    let cleaned = false;
    let closing = false;

    const registerCleanup = (dispose) => {
      if (typeof dispose !== 'function') return () => {};
      if (cleaned) {
        try { dispose(); } catch (error) { console.warn(TAG, 'late Desk Window cleanup failed', error); }
        return () => {};
      }
      cleanupStack.push(dispose);
      return () => {
        const index = cleanupStack.indexOf(dispose);
        if (index >= 0) cleanupStack.splice(index, 1);
      };
    };
    const runCleanup = () => {
      if (cleaned) return;
      cleaned = true;
      for (let index = cleanupStack.length - 1; index >= 0; index -= 1) {
        try { cleanupStack[index](); } catch (error) { console.warn(TAG, 'Desk Window cleanup failed', error); }
      }
      cleanupStack.length = 0;
      resizeListeners.clear();
    };
    const requestClose = () => {
      if (closing || !root.isConnected) return;
      closing = true;
      const result = closeCanvasCard(root);
      if (result?.then) void result.finally(() => { closing = false; });
      else closing = false;
    };

    const closeControl = el('span', {
      class: 'egd-card-dot egd-card-dot-close egd-desk-window-control',
      role: 'button',
      tabindex: '0',
      title: '창 닫기',
      onclick: (ev) => { ev.stopPropagation(); requestClose(); },
    });
    const minimizeControl = el('span', {
      class: 'egd-card-dot egd-card-dot-min egd-desk-window-control egd-desk-window-control-disabled',
      'aria-disabled': 'true',
      title: '창 최소화는 아직 지원되지 않음',
    });
    const maximizeControl = el('span', {
      class: 'egd-card-dot egd-card-dot-max egd-desk-window-control',
      role: 'button',
      tabindex: '0',
      title: '창 최대화',
      onclick: (ev) => { ev.stopPropagation(); toggleCardFullscreen(root); },
    });
    for (const control of [closeControl, maximizeControl]) {
      control.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        control.click();
      });
    }

    const identity = el('div', { class: 'egd-desk-window-identity' });
    const actions = el('div', { class: 'egd-desk-window-actions' });
    const topbar = el('div', { class: 'egd-card-topbar egd-desk-window-titlebar' },
      el('div', { class: 'egd-card-dots-shell' },
        el('div', { class: 'egd-card-dots' }, closeControl, minimizeControl, maximizeControl),
      ),
      identity,
      actions,
    );
    const header = el('div', {
      class: ['egd-card-header', 'egd-desk-window-header', options.headerClassName]
        .filter(Boolean)
        .join(' '),
    }, topbar);
    const toolbar = options.toolbar
      ? el('div', { class: 'egd-card-toolbar egd-desk-window-toolbar' })
      : null;
    const progress = options.progress
      ? el('div', { class: 'egd-card-progress egd-desk-window-progress' })
      : null;
    if (toolbar) header.appendChild(toolbar);
    if (progress) header.appendChild(progress);

    const body = el('div', {
      class: ['egd-card-body', 'egd-desk-window-body', options.bodyClassName]
        .filter(Boolean)
        .join(' '),
    });
    const resizeHits = DESK_WINDOW_RESIZE_HITS.map(({ cls, edges }) => el('div', {
      class: `egd-card-resize-hit ${cls}`,
      data: { edges: JSON.stringify(edges) },
    }));
    root.appendChild(header);
    root.appendChild(body);
    for (const hit of resizeHits) root.appendChild(hit);

    const host = options.host || document.getElementById('egd-canvas-layer') || document.documentElement;
    host.appendChild(root);
    if (options.sourceRef) bindCardSourceRef(root, options.sourceRef);
    markAgendaDirty(options.createDirtyReason || `create-${kind}-window`, root);
    if (options.activate !== false) setActiveEntity(root);

    const startPanIfNeeded = (ev) => {
      if (!state.panModifier || ev.button !== 0) return false;
      if (typeof state.startCanvasPanDrag !== 'function') return false;
      state.startCanvasPanDrag(ev);
      return true;
    };
    const focus = () => focusCanvasCard(root);
    const onRootMouseDown = (ev) => {
      if (startPanIfNeeded(ev)) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      if (!state.panModifier) focus();
    };
    root.addEventListener('mousedown', onRootMouseDown, true);

    let drag = null;
    let resize = null;
    const beginWindowDrag = (ev) => {
      if (ev.button !== 0 || isCardFullscreen(root)) return;
      if (drag || ev.target.closest('.egd-desk-window-toolbar')) return;
      if (ev.target.closest('input, button, .egd-card-dot, [data-no-window-drag]')) return;
      focus();
      drag = {
        x: ev.clientX,
        y: ev.clientY,
        left: root.offsetLeft,
        top: root.offsetTop,
      };
      ev.preventDefault();
    };
    header.addEventListener('mousedown', beginWindowDrag);
    installCardHeaderFullscreenToggle(root, topbar);

    const minWidth = Number.isFinite(options.minWidth) ? options.minWidth : 320;
    const minHeight = Number.isFinite(options.minHeight) ? options.minHeight : 250;
    for (const hit of resizeHits) {
      hit.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0 || isCardFullscreen(root)) return;
        focus();
        resize = {
          edges: JSON.parse(hit.dataset.edges),
          x: ev.clientX,
          y: ev.clientY,
          left: root.offsetLeft,
          top: root.offsetTop,
          width: root.offsetWidth,
          height: root.offsetHeight,
        };
        ev.preventDefault();
        ev.stopPropagation();
      });
    }

    const notifyResize = () => {
      const rect = {
        width: root.offsetWidth,
        height: root.offsetHeight,
        left: root.offsetLeft,
        top: root.offsetTop,
      };
      for (const listener of resizeListeners) {
        try { listener(rect); } catch (error) { console.warn(TAG, 'Desk Window resize listener failed', error); }
      }
    };
    const onMove = (ev) => {
      const zoom = canvasZoom();
      if (drag) {
        root.style.left = (drag.left + (ev.clientX - drag.x) / zoom) + 'px';
        root.style.top = (drag.top + (ev.clientY - drag.y) / zoom) + 'px';
        return;
      }
      if (!resize) return;
      const dx = (ev.clientX - resize.x) / zoom;
      const dy = (ev.clientY - resize.y) / zoom;
      let nextLeft = resize.left;
      let nextTop = resize.top;
      let nextWidth = resize.width;
      let nextHeight = resize.height;
      if (resize.edges.right) nextWidth = Math.max(minWidth, resize.width + dx);
      if (resize.edges.bottom) nextHeight = Math.max(minHeight, resize.height + dy);
      if (resize.edges.left) {
        nextWidth = Math.max(minWidth, resize.width - dx);
        nextLeft = resize.left + (resize.width - nextWidth);
      }
      if (resize.edges.top) {
        nextHeight = Math.max(minHeight, resize.height - dy);
        nextTop = resize.top + (resize.height - nextHeight);
      }
      root.style.left = nextLeft + 'px';
      root.style.top = nextTop + 'px';
      root.style.width = nextWidth + 'px';
      root.style.height = nextHeight + 'px';
      notifyResize();
    };
    const onUp = () => {
      if (drag) markAgendaDirty(options.moveDirtyReason || `move-${kind}-window`, root);
      if (resize) markAgendaDirty(options.resizeDirtyReason || `resize-${kind}-window`, root);
      drag = null;
      resize = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    const resizeObserver = new ResizeObserver(notifyResize);
    resizeObserver.observe(root);
    registerCleanup(() => {
      root.removeEventListener('mousedown', onRootMouseDown, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try { resizeObserver.disconnect(); } catch {}
    });

    const shell = {
      root,
      slots: { header, topbar, identity, actions, toolbar, progress, content: body },
      resizeHits,
      focus,
      requestClose,
      startPanIfNeeded,
      registerCleanup,
      onResize(listener) {
        if (typeof listener !== 'function') return () => {};
        resizeListeners.add(listener);
        queueMicrotask(() => {
          if (!cleaned && resizeListeners.has(listener)) {
            try { listener({
              width: root.offsetWidth,
              height: root.offsetHeight,
              left: root.offsetLeft,
              top: root.offsetTop,
            }); } catch (error) { console.warn(TAG, 'Desk Window initial resize listener failed', error); }
          }
        });
        return () => resizeListeners.delete(listener);
      },
    };
    root._cleanup = runCleanup;
    root._deskWindowShell = shell;
    return shell;
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
  const ONTOLOGY_TIME_PANE_ORDER = ['past', 'present', 'future'];
  const ONTOLOGY_GRAPH_SCHEMA_VERSION = 3;
  const ONTOLOGY_TIME_PANE_LABELS = {
    past: '과거',
    present: '현재',
    future: '미래',
    multiverse: '분기',
  };
  const ONTOLOGY_LAYER_ORDER = ['virtual', 'physical'];
  const ONTOLOGY_CAMERA_ZOOM_MIN = 0.72;
  const ONTOLOGY_CAMERA_ZOOM_MAX = 2.2;
  const ONTOLOGY_CAMERA_ZOOM_STEP = 0.12;
  const ontologyModelCache = new WeakMap();

  function ontologyTitleCase(value) {
    return String(value || '')
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function createOntologyPlaneGeometry(point, extra = {}) {
    const corners = {
      tl: point(0, 0),
      tr: point(1, 0),
      br: point(1, 1),
      bl: point(0, 1),
    };
    const pathFromPoints = (points) => `M ${points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ')} Z`;
    const rectPath = (u, v, w, h) => pathFromPoints([
      point(u, v),
      point(u + w, v),
      point(u + w, v + h),
      point(u, v + h),
    ]);
    return { corners, point, rectPath, ...extra };
  }

  function createOntologyDeckGeometry(bounds) {
    const corner = (name) => ({
      x: Number(bounds.x || 0) + Number(bounds.corners[name]?.x || 0),
      y: Number(bounds.y || 0) + Number(bounds.corners[name]?.y || 0),
    });
    const sourceCorners = {
      tl: corner('tl'),
      tr: corner('tr'),
      br: corner('br'),
      bl: corner('bl'),
    };
    const lerpPoint = (a, b, t) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    });
    const point = (u, v) => {
      const top = lerpPoint(sourceCorners.tl, sourceCorners.tr, u);
      const bottom = lerpPoint(sourceCorners.bl, sourceCorners.br, u);
      return lerpPoint(top, bottom, v);
    };
    return createOntologyPlaneGeometry(point);
  }

  function ontologyUnprojectDeckPoint(geometry, target, initial = { u: 0.5, v: 0.5 }) {
    let u = Number.isFinite(initial.u) ? initial.u : 0.5;
    let v = Number.isFinite(initial.v) ? initial.v : 0.5;
    const epsilon = 0.0005;
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const current = geometry.point(u, v);
      const alongU = geometry.point(u + epsilon, v);
      const alongV = geometry.point(u, v + epsilon);
      const ux = (alongU.x - current.x) / epsilon;
      const uy = (alongU.y - current.y) / epsilon;
      const vx = (alongV.x - current.x) / epsilon;
      const vy = (alongV.y - current.y) / epsilon;
      const determinant = ux * vy - uy * vx;
      if (Math.abs(determinant) < 0.000001) break;
      const errorX = target.x - current.x;
      const errorY = target.y - current.y;
      u += (errorX * vy - errorY * vx) / determinant;
      v += (ux * errorY - uy * errorX) / determinant;
    }
    return { u, v };
  }

  function createOntologyLayerGeometry(geometry, frame) {
    const point = (u, v) => geometry.point(
      frame.u + u * frame.w,
      frame.v + v * frame.h,
    );
    return createOntologyPlaneGeometry(point, { frame });
  }

  function createOntologyCameraGeometry(geometry, camera, focusSpec) {
    const origin = {
      u: focusSpec.u + focusSpec.w / 2,
      v: focusSpec.v + focusSpec.h / 2,
    };
    const originPoint = geometry.point(origin.u, origin.v);
    const cameraCenter = ontologyUnprojectDeckPoint(geometry, {
      x: originPoint.x + (Number(camera.x) || 0),
      y: originPoint.y + (Number(camera.y) || 0),
    }, origin);
    const zoom = Math.max(0.01, Number(camera.zoom) || 1);
    const mapCoordinates = (u, v) => ({
      u: cameraCenter.u + (u - origin.u) * zoom,
      v: cameraCenter.v + (v - origin.v) * zoom,
    });
    const point = (u, v) => {
      const mapped = mapCoordinates(u, v);
      return geometry.point(mapped.u, mapped.v);
    };
    const viewportSpec = {
      u: origin.u + (focusSpec.u - cameraCenter.u) / zoom,
      v: origin.v + (focusSpec.v - cameraCenter.v) / zoom,
      w: focusSpec.w / zoom,
      h: focusSpec.h / zoom,
    };
    return createOntologyPlaneGeometry(point, { cameraCenter, viewportSpec });
  }

  function validateOntologyGraph(graph) {
    if (graph?.schemaVersion !== ONTOLOGY_GRAPH_SCHEMA_VERSION) {
      throw new Error(`Unsupported ontology graph schema: ${graph?.schemaVersion ?? 'missing'}`);
    }
    for (const field of ['nodes', 'snapshots', 'occurrences', 'referenceEdges']) {
      if (!Array.isArray(graph[field])) throw new Error(`Ontology graph field must be an array: ${field}`);
    }
    return graph;
  }

  function getOntologyModel(graph) {
    const cached = ontologyModelCache.get(graph);
    if (cached) return cached;
    const nodesById = new Map((graph?.nodes || []).map((node) => [node.id, node]));
    const snapshots = (graph?.snapshots || []).slice();
    const occurrences = (graph?.occurrences || []).slice();
    const byRef = new Map(occurrences.map((occurrence) => [occurrence.refId, occurrence]));
    const childrenByRef = new Map();
    occurrences.forEach((occurrence) => {
      if (!occurrence.parentRef) return;
      if (!childrenByRef.has(occurrence.parentRef)) childrenByRef.set(occurrence.parentRef, []);
      childrenByRef.get(occurrence.parentRef).push(occurrence);
    });
    childrenByRef.forEach((children) => children.sort((a, b) => (
      (Number(a.order) || 0) - (Number(b.order) || 0) || a.refId.localeCompare(b.refId)
    )));
    const labelFor = (occurrence) => occurrence?.label
      || nodesById.get(occurrence?.conceptId)?.label
      || ontologyTitleCase(occurrence?.conceptId || occurrence?.refId || 'concept');
    const rootsByPhase = new Map();
    snapshots.forEach((snapshot) => {
      const root = byRef.get(snapshot.rootRef);
      if (root && !rootsByPhase.has(snapshot.timeSlice)) rootsByPhase.set(snapshot.timeSlice, root);
    });
    const isPlaneRoot = (occurrence) => {
      if (!occurrence) return false;
      const parent = occurrence.parentRef ? byRef.get(occurrence.parentRef) : null;
      return !parent || parent.timeSlice !== occurrence.timeSlice || parent.snapshotId !== occurrence.snapshotId;
    };
    const planeRootsByCell = new Map();
    occurrences.forEach((occurrence) => {
      if (!isPlaneRoot(occurrence)) return;
      const key = `${occurrence.timeSlice}:${occurrence.layer}`;
      if (!planeRootsByCell.has(key)) planeRootsByCell.set(key, []);
      planeRootsByCell.get(key).push(occurrence);
    });
    planeRootsByCell.forEach((roots) => roots.sort((a, b) => (
      (Number(a.order) || 0) - (Number(b.order) || 0) || a.refId.localeCompare(b.refId)
    )));
    const model = {
      snapshots,
      occurrences,
      byRef,
      childrenByRef,
      rootsByPhase,
      isPlaneRoot,
      planeRootsFor: (phase, layer) => planeRootsByCell.get(`${phase}:${layer}`) || [],
      labelFor,
      referenceEdges: graph?.referenceEdges || [],
    };
    ontologyModelCache.set(graph, model);
    return model;
  }

  function getOntologyCamera(localState) {
    const key = `${localState.activePane || 'present'}:coupled-layers`;
    if (!localState.cameraByCell) localState.cameraByCell = {};
    if (!localState.cameraByCell[key]) localState.cameraByCell[key] = { x: 0, y: 0, zoom: 1 };
    const camera = localState.cameraByCell[key];
    localState.pan = { x: camera.x, y: camera.y };
    localState.zoom = camera.zoom;
    return camera;
  }

  function setOntologyLayer(localState, layer) {
    if (!ONTOLOGY_LAYER_ORDER.includes(layer)) return false;
    localState.activeLayer = layer;
    localState.activeStratum = layer;
    localState.activeDepth = layer;
    return true;
  }

  function adjustOntologyCameraZoom(camera, direction) {
    camera.zoom = Math.max(
      ONTOLOGY_CAMERA_ZOOM_MIN,
      Math.min(ONTOLOGY_CAMERA_ZOOM_MAX, camera.zoom + direction * ONTOLOGY_CAMERA_ZOOM_STEP),
    );
  }

  function resetOntologyCamera(camera) {
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
  }

  function selectOntologyOccurrence(localState, model, refId, options = {}) {
    const occurrence = model.byRef.get(refId);
    if (!occurrence) return false;
    localState.selectedRefId = occurrence.refId;
    localState.selectedId = occurrence.refId;
    localState.selectedConceptId = occurrence.conceptId;
    localState.activePane = occurrence.timeSlice;
    if (options.keepLayer !== true) setOntologyLayer(localState, occurrence.layer);
    return true;
  }

  function activateOntologyPane(localState, model, phase, preferredConceptId = null) {
    if (!ONTOLOGY_TIME_PANE_ORDER.includes(phase)) return false;
    const candidates = model.occurrences.filter((occurrence) => occurrence.timeSlice === phase);
    const target = candidates.find((occurrence) => occurrence.conceptId === preferredConceptId)
      || model.rootsByPhase.get(phase)
      || candidates[0];
    localState.activePane = phase;
    if (target) {
      selectOntologyOccurrence(localState, model, target.refId);
    } else {
      localState.selectedRefId = null;
      localState.selectedId = null;
      localState.selectedConceptId = null;
    }
    return true;
  }

  function getOntologySideItems(model, phase, visibleRefs, selected) {
    const phaseOccurrences = model.occurrences.filter((occurrence) => occurrence.timeSlice === phase);
    const visibleConcepts = new Set(visibleRefs.map((occurrence) => occurrence.conceptId));
    const edgeEndpointRefs = new Set();
    model.referenceEdges.forEach((edge) => {
      if (visibleRefs.some((occurrence) => occurrence.refId === edge.sourceRef)) edgeEndpointRefs.add(edge.targetRef);
      if (visibleRefs.some((occurrence) => occurrence.refId === edge.targetRef)) edgeEndpointRefs.add(edge.sourceRef);
    });
    return phaseOccurrences.filter((occurrence) => (
      model.isPlaneRoot(occurrence)
      || edgeEndpointRefs.has(occurrence.refId)
      || visibleConcepts.has(occurrence.conceptId)
    )).sort((a, b) => {
      const rank = (occurrence) => {
        if (occurrence.conceptId === selected?.conceptId) return 0;
        if (visibleConcepts.has(occurrence.conceptId)) return 1;
        if (edgeEndpointRefs.has(occurrence.refId)) return 2;
        if (model.isPlaneRoot(occurrence)) return 3;
        return 4;
      };
      return rank(a) - rank(b)
        || (Number(a.order) || 0) - (Number(b.order) || 0)
        || a.refId.localeCompare(b.refId);
    });
  }

  function drawOntologyText(parent, geometry, u, v, textValue, attrs = {}) {
    const { anchor = 'middle', ...svgAttrs } = attrs;
    const point = geometry.point(u, v);
    const angle = Math.atan2(
      geometry.corners.tr.y - geometry.corners.tl.y,
      geometry.corners.tr.x - geometry.corners.tl.x,
    ) * 180 / Math.PI;
    const node = svgEl('text', {
      x: point.x,
      y: point.y,
      transform: Math.abs(angle) > 0.1 ? `rotate(${angle.toFixed(2)} ${point.x.toFixed(1)} ${point.y.toFixed(1)})` : null,
      'text-anchor': anchor,
      fill: '#252c33',
      'font-family': 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif',
      'font-size': '12',
      'font-weight': '800',
      ...svgAttrs,
    }, textValue);
    parent.appendChild(node);
    return node;
  }

  function drawOntologyChildPips(parent, geometry, spec, count, layer) {
    const columns = 9;
    const anchorU = spec.u + spec.w - 0.025;
    const anchorV = spec.v + spec.h - 0.025;
    const origin = geometry.point(anchorU, anchorV);
    const alongU = geometry.point(anchorU + 0.01, anchorV);
    const alongV = geometry.point(anchorU, anchorV + 0.01);
    const pixelsPerU = Math.max(1, Math.hypot(alongU.x - origin.x, alongU.y - origin.y) / 0.01);
    const pixelsPerV = Math.max(1, Math.hypot(alongV.x - origin.x, alongV.y - origin.y) / 0.01);
    const pipSizePx = 7;
    const pipGapPx = 4;
    const pipW = Math.min(pipSizePx / pixelsPerU, spec.w / 14);
    const pipH = Math.min(pipSizePx / pixelsPerV, spec.h / 5);
    const gapX = pipW + pipGapPx / pixelsPerU;
    const gapY = pipH + pipGapPx / pixelsPerV;
    for (let index = 0; index < count; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const u = spec.u + spec.w - 0.025 - pipW - column * gapX;
      const v = spec.v + spec.h - 0.025 - pipH - row * gapY;
      parent.appendChild(svgEl('path', {
        class: `egd-ontology-v2-pip egd-ontology-v2-pip-${layer}`,
        d: geometry.rectPath(u, v, pipW, pipH),
        fill: layer === 'virtual' ? 'rgba(103, 67, 166, 0.82)' : 'rgba(35, 76, 106, 0.84)',
        stroke: 'rgba(255, 255, 255, 0.90)',
        'stroke-width': '0.6',
        'data-pip-index': String(index),
      }));
    }
  }

  function drawOntologyOccurrenceBox(parent, model, geometry, spec, occurrence, options = {}) {
    const childCount = model.childrenByRef.get(occurrence.refId)?.length || 0;
    const expandedRoot = !!(options.root && options.expanded);
    const group = svgEl('g', {
      class: `egd-ontology-v2-box${options.root ? ' egd-ontology-v2-box-root' : ''}${expandedRoot ? ' egd-ontology-v2-box-root-expanded' : ''}${options.side ? ' egd-ontology-v2-box-side' : ''}${options.overview ? ' egd-ontology-v2-box-overview' : ''}${options.context ? ' egd-ontology-v2-box-context' : ''}${options.behind ? ' egd-ontology-v2-box-behind' : ''}`,
      data: {
        refId: occurrence.refId,
        conceptId: occurrence.conceptId,
        phase: occurrence.timeSlice,
        layer: occurrence.layer,
        contextRole: options.contextRole || '',
      },
      onclick: options.onclick,
    });
    const boxPath = geometry.rectPath(spec.u, spec.v, spec.w, spec.h);
    const boxFill = options.root ? 'rgba(255, 254, 250, 0.88)' : options.side ? 'rgba(255, 255, 255, 0.88)' : options.overview ? 'rgba(255, 255, 255, 0.92)' : 'rgba(255, 255, 255, 0.95)';
    const boxStroke = occurrence.layer === 'virtual' ? 'rgba(103, 67, 166, 0.68)' : 'rgba(35, 76, 106, 0.70)';
    group.appendChild(svgEl('path', {
      class: `egd-ontology-v2-box-path egd-ontology-v2-box-path-${occurrence.layer}${expandedRoot ? ' egd-ontology-v2-box-fill' : ''}`,
      d: boxPath,
      fill: boxFill,
      stroke: expandedRoot ? 'none' : boxStroke,
      'stroke-width': options.root ? '2.3' : options.side ? '1.2' : '1.7',
    }));
    if (expandedRoot) {
      const labelWidth = Math.min(spec.w * 0.40, Math.max(0.105, model.labelFor(occurrence).length * 0.013));
      const gapStartU = spec.u + 0.035;
      const gapEndU = gapStartU + labelWidth;
      const topLeft = geometry.point(spec.u, spec.v);
      const gapStart = geometry.point(gapStartU, spec.v);
      const gapEnd = geometry.point(gapEndU, spec.v);
      const topRight = geometry.point(spec.u + spec.w, spec.v);
      const bottomRight = geometry.point(spec.u + spec.w, spec.v + spec.h);
      const bottomLeft = geometry.point(spec.u, spec.v + spec.h);
      group.appendChild(svgEl('path', {
        class: `egd-ontology-v2-box-outline egd-ontology-v2-box-outline-${occurrence.layer}`,
        d: `M ${gapEnd.x.toFixed(1)} ${gapEnd.y.toFixed(1)} L ${topRight.x.toFixed(1)} ${topRight.y.toFixed(1)} L ${bottomRight.x.toFixed(1)} ${bottomRight.y.toFixed(1)} L ${bottomLeft.x.toFixed(1)} ${bottomLeft.y.toFixed(1)} L ${topLeft.x.toFixed(1)} ${topLeft.y.toFixed(1)} L ${gapStart.x.toFixed(1)} ${gapStart.y.toFixed(1)}`,
        fill: 'none',
        stroke: boxStroke,
        'stroke-width': '2.3',
      }));
      group.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-legend-gap',
        d: `M ${gapStart.x.toFixed(1)} ${gapStart.y.toFixed(1)} L ${gapEnd.x.toFixed(1)} ${gapEnd.y.toFixed(1)}`,
        fill: 'none',
        stroke: boxFill,
        'stroke-width': '3.2',
      }));
      drawOntologyText(group, geometry, gapStartU + 0.012, spec.v + 0.018, model.labelFor(occurrence), {
        class: 'egd-ontology-v2-label egd-ontology-v2-label-root',
        anchor: 'start',
        'font-size': '14',
        'font-weight': '900',
      });
    } else if (options.root) {
      drawOntologyText(group, geometry, spec.u + spec.w / 2, spec.v + spec.h * 0.52, model.labelFor(occurrence), {
        class: 'egd-ontology-v2-label egd-ontology-v2-label-root egd-ontology-v2-label-root-centered',
        'font-size': '15',
        'font-weight': '900',
      });
    } else {
      drawOntologyText(group, geometry, spec.u + spec.w / 2, spec.v + spec.h * 0.48, model.labelFor(occurrence), {
        class: 'egd-ontology-v2-label',
        'font-size': options.side || options.context || options.overview ? '10' : '12',
      });
    }
    if (childCount && !options.root && !options.side && (!options.context || options.contextRole === 'child')) {
      drawOntologyChildPips(group, geometry, spec, childCount, occurrence.layer);
    }
    parent.appendChild(group);
    return group;
  }

  function renderOntologyMap(stage, graph, localState) {
    const model = getOntologyModel(graph);
    if (!model.snapshots.length) {
      stage.textContent = '';
      stage.appendChild(el('div', { class: 'egd-ontology-empty' }, '표시할 composite snapshot이 없습니다.'));
      return;
    }
    const rerender = () => renderOntologyMap(stage, graph, localState);
    syncOntologyPresentationState();
    if (!ONTOLOGY_TIME_PANE_ORDER.includes(localState.activePane)) localState.activePane = 'present';
    if (!ONTOLOGY_LAYER_ORDER.includes(localState.activeLayer)) setOntologyLayer(localState, 'virtual');
    let selected = model.byRef.get(localState.selectedRefId || localState.selectedId);
    if (!selected || selected.timeSlice !== localState.activePane) {
      selected = model.rootsByPhase.get(localState.activePane) || null;
    }
    const emptyPhase = !selected;
    if (selected) {
      selectOntologyOccurrence(localState, model, selected.refId, { keepLayer: true });
    } else {
      localState.selectedRefId = null;
      localState.selectedId = null;
      localState.selectedConceptId = null;
    }
    setOntologyLayer(
      localState,
      ONTOLOGY_LAYER_ORDER.includes(localState.activeLayer) ? localState.activeLayer : selected?.layer || 'virtual',
    );
    const layerPovShiftV = localState.activeLayer === 'physical' ? -0.170 : 0;
    const camera = getOntologyCamera(localState);
    const directChildren = emptyPhase ? [] : (model.childrenByRef.get(selected.refId) || []);
    const mainChildren = directChildren.filter((occurrence) => occurrence.layer === localState.activeLayer);
    const visibleRefs = selected ? [selected, ...directChildren] : [];
    const visibleRefIds = new Set(visibleRefs.map((occurrence) => occurrence.refId));
    const temporallyCoupledRefIds = new Set();
    model.referenceEdges.forEach((edge) => {
      const source = model.byRef.get(edge.sourceRef);
      const target = model.byRef.get(edge.targetRef);
      if (!source || !target || source.timeSlice === target.timeSlice) return;
      if (visibleRefIds.has(source.refId) && target.timeSlice !== localState.activePane) {
        temporallyCoupledRefIds.add(target.refId);
      }
      if (visibleRefIds.has(target.refId) && source.timeSlice !== localState.activePane) {
        temporallyCoupledRefIds.add(source.refId);
      }
    });
    const card = stage.closest?.('.egd-ontology-card');
    if (card) {
      card.classList.add('egd-ontology-canvas-first', 'egd-ontology-v2');
      card.dataset.activePane = localState.activePane;
      card.dataset.activeLayer = localState.activeLayer;
      card.dataset.layerPovShiftV = layerPovShiftV.toFixed(3);
    }

    const stageRect = stage.getBoundingClientRect?.();
    const height = 760;
    const aspect = stageRect?.height > 100 ? stageRect.width / stageRect.height : 1.65;
    const width = Math.max(1120, Math.min(1580, Math.round(height * aspect)));
    const paneBounds = {};
    const timeShares = localState.activePane === 'past'
      ? [0.18, 0.82, 0.91, 1]
      : localState.activePane === 'future'
        ? [0, 0.09, 0.18, 0.82]
        : [0, 0.18, 0.82, 1];
    const activeTimeIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(localState.activePane);
    const topY = 96;
    // Keep the trailing layer above the Desk Dock instead of letting the
    // projected plane disappear through the card's lower edge.
    const bottomY = height - 72;
    const topLeft = -48;
    const topRight = width + 48;
    const bottomLeft = -170;
    const bottomRight = width + 170;
    const sideTimeTiltY = 72;
    const interpolateX = (left, right, t) => left + (right - left) * t;
    const boundaryTiltY = (boundaryIndex) => {
      if (boundaryIndex < activeTimeIndex) {
        return sideTimeTiltY * (activeTimeIndex - boundaryIndex) / Math.max(1, activeTimeIndex);
      }
      if (boundaryIndex > activeTimeIndex + 1) {
        return sideTimeTiltY * (boundaryIndex - activeTimeIndex - 1)
          / Math.max(1, ONTOLOGY_TIME_PANE_ORDER.length - activeTimeIndex - 1);
      }
      return 0;
    };
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase, index) => {
      const leftTiltY = boundaryTiltY(index);
      const rightTiltY = boundaryTiltY(index + 1);
      paneBounds[phase] = {
        x: 0,
        y: 0,
        w: width,
        h: height,
        corners: {
          tl: {
            x: interpolateX(topLeft, topRight, timeShares[index]),
            y: topY - leftTiltY,
          },
          tr: {
            x: interpolateX(topLeft, topRight, timeShares[index + 1]),
            y: topY - rightTiltY,
          },
          br: {
            x: interpolateX(bottomLeft, bottomRight, timeShares[index + 1]),
            y: bottomY - rightTiltY,
          },
          bl: {
            x: interpolateX(bottomLeft, bottomRight, timeShares[index]),
            y: bottomY - leftTiltY,
          },
        },
      };
    });
    const geometries = new Map(Object.entries(paneBounds).map(([phase, bounds]) => [
      phase,
      createOntologyDeckGeometry(bounds),
    ]));
    // Virtual and physical keep a stable world-space order. Selecting physical
    // lowers the POV by one depth step; it never swaps the two plane frames.
    const virtualLayerFrame = { u: 0, v: 0.055 + layerPovShiftV, w: 1, h: 0.620 };
    const physicalLayerFrame = { u: 0, v: 0.225 + layerPovShiftV, w: 1, h: 0.620 };
    const layerFrameSpecs = {
      virtual: virtualLayerFrame,
      physical: physicalLayerFrame,
    };
    const planeSpec = { u: 0, v: 0, w: 1, h: 1 };
    const layerSpecs = {
      virtual: { ...planeSpec },
      physical: { ...planeSpec },
    };
    const sideLayerSpecs = layerSpecs;
    const layerGeometries = new Map();
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      ONTOLOGY_LAYER_ORDER.forEach((layer) => {
        layerGeometries.set(
          `${phase}:${layer}`,
          createOntologyLayerGeometry(geometries.get(phase), layerFrameSpecs[layer]),
        );
      });
    });
    const layerGeometryFor = (phase, layer) => layerGeometries.get(`${phase}:${layer}`);
    const layerRenderOrder = ONTOLOGY_LAYER_ORDER
      .filter((layer) => layer !== localState.activeLayer)
      .concat(localState.activeLayer);

    stage.textContent = '';
    const svg = svgEl('svg', {
      class: 'egd-ontology-svg egd-ontology-v2-svg',
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': '시간 및 가상 물리 층을 탐색하는 온톨로지 복합 렌즈',
    });
    const cameraGroup = svgEl('g', {
      class: 'egd-ontology-v2-camera',
      data: { cameraSpace: 'plane' },
    });
    const surfaceGroup = svgEl('g', { class: 'egd-ontology-v2-surfaces' });
    const edgeGroup = svgEl('g', { class: 'egd-ontology-v2-reference-edges' });
    const depthEdgeGroup = svgEl('g', { class: 'egd-ontology-v2-reference-edges egd-ontology-v2-depth-edges' });
    const coupledBehindNodeGroup = svgEl('g', { class: 'egd-ontology-v2-nodes egd-ontology-v2-coupled-behind-nodes' });
    const frontLayerVeilGroup = svgEl('g', { class: 'egd-ontology-v2-front-layer-veil' });
    const activeNodeGroup = svgEl('g', { class: 'egd-ontology-v2-nodes egd-ontology-v2-active-nodes' });
    const fixedNodeGroup = svgEl('g', { class: 'egd-ontology-v2-side-nodes' });
    const cameraOverlayGroup = svgEl('g', { class: 'egd-ontology-v2-camera-overlays' });
    const overlayGroup = svgEl('g', { class: 'egd-ontology-v2-overlays' });
    const layerControlGroup = svgEl('g', { class: 'egd-ontology-v2-layer-controls' });
    const placements = new Map();
    const sideInventories = new Map();

    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      const geometry = geometries.get(phase);
      const active = phase === localState.activePane;
      const pane = svgEl('g', {
        class: `egd-ontology-time-coordinate egd-ontology-time-coordinate-${phase}${active ? ' egd-ontology-time-coordinate-active' : ''}`,
        data: { phase },
      });
      const activateLayerAtPhase = (layer, ev) => {
        ev?.preventDefault?.();
        ev?.stopPropagation?.();
        if (phase !== localState.activePane) activateOntologyPane(localState, model, phase, selected?.conceptId || null);
        setOntologyLayer(localState, layer);
        const related = model.occurrences.find((occurrence) => (
          occurrence.timeSlice === phase && occurrence.layer === layer && occurrence.conceptId === selected?.conceptId
        )) || model.occurrences.find((occurrence) => occurrence.timeSlice === phase && occurrence.layer === layer);
        if (related) selectOntologyOccurrence(localState, model, related.refId, { keepLayer: true });
        rerender();
      };
      pane.appendChild(svgEl('path', {
        class: `egd-ontology-pane-hit egd-ontology-v2-time-axis-hit egd-ontology-v2-pane-hit-${phase}`,
        d: geometry.rectPath(0.22, 0.0, 0.56, 0.085),
        fill: 'transparent',
        stroke: 'transparent',
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          activateOntologyPane(localState, model, phase, selected?.conceptId || null);
          rerender();
        },
      }));
      drawOntologyText(pane, geometry, 0.50, active ? 0.035 : 0.08, ONTOLOGY_TIME_PANE_LABELS[phase], {
        class: 'egd-ontology-v2-time-coordinate-label',
        fill: active ? 'rgba(39, 48, 56, 0.82)' : 'rgba(59, 66, 73, 0.58)',
        'font-size': active ? '15' : '13',
        'font-weight': '900',
      });
      const strutGroup = svgEl('g', {
        class: `egd-ontology-v2-layer-struts${active ? ' egd-ontology-v2-layer-struts-active' : ''}`,
        data: { phase },
      });
      [0.075, 0.925].forEach((u) => {
        const from = layerGeometryFor(phase, localState.activeLayer).point(u, 0.060);
        const trailingLayer = localState.activeLayer === 'virtual' ? 'physical' : 'virtual';
        const to = layerGeometryFor(phase, trailingLayer).point(u, 0.060);
        strutGroup.appendChild(svgEl('path', {
          class: 'egd-ontology-v2-layer-strut',
          d: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
          fill: 'none',
          stroke: active ? 'rgba(45, 90, 123, 0.34)' : 'rgba(45, 90, 123, 0.22)',
          'stroke-width': active ? '1.35' : '0.95',
          'stroke-dasharray': '5 5',
          data: { phase, anchorU: u },
        }));
      });
      pane.appendChild(strutGroup);
      if (active) {
        layerRenderOrder.forEach((layer) => {
          const spec = layerSpecs[layer];
          const layerGeometry = layerGeometryFor(phase, layer);
          const layerActive = localState.activeLayer === layer;
          pane.appendChild(svgEl('path', {
            class: `egd-ontology-v2-layer-shadow egd-ontology-v2-layer-shadow-${layer}${layerActive ? ' egd-ontology-v2-layer-shadow-active' : ''}`,
            d: layerGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
            transform: 'translate(0 12)',
            fill: layer === 'virtual' ? 'rgba(73, 52, 110, 0.045)' : 'rgba(27, 58, 78, 0.055)',
            stroke: 'none',
            data: { phase, layer },
          }));
          pane.appendChild(svgEl('path', {
            class: `egd-ontology-v2-layer-pane egd-ontology-v2-layer-surface egd-ontology-v2-layer-surface-${layer}${layerActive ? ' egd-ontology-v2-layer-surface-active' : ' egd-ontology-v2-layer-surface-behind'}`,
            d: layerGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
            fill: layer === 'virtual' ? 'rgba(126, 87, 194, 0.078)' : 'rgba(45, 90, 123, 0.085)',
            stroke: layer === 'virtual'
              ? (layerActive ? 'rgba(103, 67, 166, 0.64)' : 'rgba(126, 87, 194, 0.38)')
              : (layerActive ? 'rgba(35, 76, 106, 0.66)' : 'rgba(45, 90, 123, 0.40)'),
            'stroke-width': layerActive ? '2.1' : '1.15',
            data: { phase, layer, planeRole: layerActive ? 'main' : 'trailing' },
            onclick: (ev) => {
              if (localState.suppressNextSurfaceClick) {
                localState.suppressNextSurfaceClick = false;
                return;
              }
              activateLayerAtPhase(layer, ev);
            },
          }));
        });
        // Keep both layer selectors above the overlapping surfaces. Otherwise
        // the front surface steals clicks from the visible trailing label.
        layerRenderOrder.forEach((layer) => {
          const spec = layerSpecs[layer];
          const layerGeometry = layerGeometryFor(phase, layer);
          const layerActive = localState.activeLayer === layer;
          const activateLayerLabel = (ev) => activateLayerAtPhase(layer, ev);
          const labelControl = svgEl('g', {
            class: `egd-ontology-v2-layer-label-control egd-ontology-v2-layer-label-control-${layer}`,
            data: { phase, layer },
            role: 'button',
            tabindex: '0',
            'aria-label': `${layer === 'virtual' ? '가상' : '물리'} 층으로 이동`,
            onclick: activateLayerLabel,
            onkeydown: (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') activateLayerLabel(ev);
            },
          });
          labelControl.appendChild(svgEl('path', {
            class: 'egd-ontology-v2-layer-label-hit',
            d: layerGeometry.rectPath(spec.u + 0.012, spec.v + 0.012, 0.13, 0.11),
            fill: 'transparent',
            stroke: 'none',
          }));
          drawOntologyText(labelControl, layerGeometry, spec.u + 0.025, spec.v + 0.055, layer === 'virtual' ? '가상' : '물리', {
            class: `egd-ontology-v2-layer-label egd-ontology-v2-layer-label-${layer}`,
            anchor: 'start',
            fill: layer === 'virtual'
              ? (layerActive ? 'rgba(103, 67, 166, 0.88)' : 'rgba(103, 67, 166, 0.48)')
              : (layerActive ? 'rgba(35, 76, 106, 0.90)' : 'rgba(35, 76, 106, 0.52)'),
            'font-size': '11',
            'font-weight': '900',
          });
          layerControlGroup.appendChild(labelControl);
          if (!layerActive) {
            const switchV = layer === 'physical' ? 0.86 : 0.02;
            layerControlGroup.appendChild(svgEl('path', {
              class: `egd-ontology-v2-layer-switch-hit egd-ontology-v2-layer-switch-hit-${layer}`,
              d: layerGeometry.rectPath(spec.u + 0.08, spec.v + switchV, 0.84, 0.10),
              fill: 'rgba(255, 255, 255, 0.001)',
              stroke: 'none',
              data: { phase, layer },
              role: 'button',
              tabindex: '0',
              'aria-label': `${layer === 'virtual' ? '가상' : '물리'} 층으로 이동`,
              onclick: activateLayerLabel,
              onkeydown: (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') activateLayerLabel(ev);
              },
            }));
          }
        });
      } else {
        layerRenderOrder.forEach((layer) => {
          const spec = sideLayerSpecs[layer];
          const layerGeometry = layerGeometryFor(phase, layer);
          const layerActive = localState.activeLayer === layer;
          pane.appendChild(svgEl('path', {
            class: `egd-ontology-v2-layer-shadow egd-ontology-v2-side-layer-shadow egd-ontology-v2-layer-shadow-${layer}`,
            d: layerGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
            transform: 'translate(0 8)',
            fill: layer === 'virtual' ? 'rgba(73, 52, 110, 0.030)' : 'rgba(27, 58, 78, 0.036)',
            stroke: 'none',
            data: { phase, layer },
          }));
          pane.appendChild(svgEl('path', {
            class: `egd-ontology-v2-layer-pane egd-ontology-v2-side-layer egd-ontology-v2-side-layer-${layer}${layerActive ? ' egd-ontology-v2-side-layer-front' : ' egd-ontology-v2-side-layer-behind'}`,
            d: layerGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
            fill: layer === 'virtual' ? 'rgba(126, 87, 194, 0.025)' : 'rgba(45, 90, 123, 0.030)',
            stroke: layer === 'virtual' ? 'rgba(126, 87, 194, 0.26)' : 'rgba(45, 90, 123, 0.28)',
            'stroke-width': layerActive ? '1.25' : '0.95',
            data: { phase, layer, planeRole: layerActive ? 'main' : 'trailing' },
            onclick: (ev) => activateLayerAtPhase(layer, ev),
          }));
          drawOntologyText(pane, layerGeometry, spec.u + 0.06, spec.v + 0.085, layer === 'virtual' ? '가상' : '물리', {
            class: `egd-ontology-v2-side-layer-label egd-ontology-v2-layer-label-${layer}`,
            anchor: 'start',
            fill: layer === 'virtual' ? 'rgba(103, 67, 166, 0.58)' : 'rgba(35, 76, 106, 0.62)',
            'font-size': '8.5',
            'font-weight': '900',
          });
        });
      }
      surfaceGroup.appendChild(pane);
    });

    const activeGeometry = layerGeometryFor(localState.activePane, localState.activeLayer);
    const mainSpec = layerSpecs[localState.activeLayer];
    const activeCameraGeometry = createOntologyCameraGeometry(activeGeometry, camera, mainSpec);
    const cameraGeometriesByCell = new Map();
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      ONTOLOGY_LAYER_ORDER.forEach((layer) => {
        cameraGeometriesByCell.set(
          `${phase}:${layer}`,
          createOntologyCameraGeometry(layerGeometryFor(phase, layer), camera, layerSpecs[layer]),
        );
      });
    });
    const activeLayerCameraGeometries = new Map(ONTOLOGY_LAYER_ORDER.map((layer) => [
      layer,
      cameraGeometriesByCell.get(`${localState.activePane}:${layer}`),
    ]));
    const cameraClipId = `egd-ontology-v2-camera-clip-${String(card?.id || 'card').replace(/[^a-z0-9_-]/gi, '-')}`;
    const defs = svgEl('defs');
    const cameraClip = svgEl('clipPath', { id: cameraClipId });
    ONTOLOGY_LAYER_ORDER.forEach((layer) => {
      const geometry = layerGeometryFor(localState.activePane, layer);
      const spec = layerSpecs[layer];
      cameraClip.appendChild(svgEl('path', { d: geometry.rectPath(spec.u, spec.v, spec.w, spec.h) }));
    });
    defs.appendChild(cameraClip);
    const layerClipIds = new Map();
    const layerClipBaseId = `egd-ontology-v2-layer-clip-${String(card?.id || 'card').replace(/[^a-z0-9_-]/gi, '-')}`;
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      ONTOLOGY_LAYER_ORDER.forEach((layer) => {
        const clipId = `${layerClipBaseId}-${phase}-${layer}`;
        const clip = svgEl('clipPath', { id: clipId });
        clip.appendChild(svgEl('path', {
          d: layerGeometryFor(phase, layer).rectPath(
            layerSpecs[layer].u,
            layerSpecs[layer].v,
            layerSpecs[layer].w,
            layerSpecs[layer].h,
          ),
        }));
        defs.appendChild(clip);
        layerClipIds.set(`${phase}:${layer}`, clipId);
      });
    });
    svg.appendChild(defs);
    cameraGroup.setAttribute('clip-path', `url(#${cameraClipId})`);
    depthEdgeGroup.setAttribute('clip-path', `url(#${cameraClipId})`);
    const trailingCameraLayer = localState.activeLayer === 'virtual' ? 'physical' : 'virtual';
    const activeNodeClipId = layerClipIds.get(`${localState.activePane}:${localState.activeLayer}`);
    const trailingNodeClipId = layerClipIds.get(`${localState.activePane}:${trailingCameraLayer}`);
    activeNodeGroup.setAttribute('clip-path', `url(#${activeNodeClipId})`);
    activeNodeGroup.dataset.clipLayer = localState.activeLayer;
    coupledBehindNodeGroup.setAttribute('clip-path', `url(#${trailingNodeClipId})`);
    coupledBehindNodeGroup.dataset.clipLayer = trailingCameraLayer;
    cameraOverlayGroup.setAttribute('clip-path', `url(#${activeNodeClipId})`);
    cameraOverlayGroup.dataset.clipLayer = localState.activeLayer;
    frontLayerVeilGroup.appendChild(svgEl('path', {
      class: `egd-ontology-v2-layer-occlusion egd-ontology-v2-layer-occlusion-${localState.activeLayer}`,
      d: activeGeometry.rectPath(mainSpec.u, mainSpec.v, mainSpec.w, mainSpec.h),
      fill: localState.activeLayer === 'virtual'
        ? 'rgba(248, 246, 252, 0.48)'
        : 'rgba(244, 248, 250, 0.48)',
      data: { phase: localState.activePane, layer: localState.activeLayer },
    }));
    const rootExpanded = mainChildren.length > 0;
    const rootWidth = rootExpanded ? Math.min(0.56, mainSpec.w - 0.18) : Math.min(0.34, mainSpec.w - 0.22);
    const rootHeight = rootExpanded ? Math.min(0.30, mainSpec.h - 0.13) : Math.min(0.16, mainSpec.h - 0.20);
    const rootSpec = selected ? {
      u: mainSpec.u + (mainSpec.w - rootWidth) / 2,
      v: mainSpec.v + (rootExpanded ? 0.18 : 0.23),
      w: rootWidth,
      h: rootHeight,
    } : null;
    if (selected && rootSpec) {
      placements.set(selected.refId, { occurrence: selected, geometry: activeCameraGeometry, spec: rootSpec, kind: 'root', camera: true });
    }
    const parent = selected?.parentRef ? model.byRef.get(selected.parentRef) : null;
    const crossLayerContextRefIds = new Set([
      ...(parent && parent.layer !== localState.activeLayer ? [parent.refId] : []),
      ...directChildren.filter((child) => child.layer !== localState.activeLayer).map((child) => child.refId),
    ]);
    if (parent) {
      const parentLabelWidth = Math.max(0.14, Math.min(0.23, model.labelFor(parent).length * 0.016));
      const tabSpec = { u: rootSpec.u + 0.025, v: rootSpec.v - 0.078, w: parentLabelWidth, h: 0.052 };
      const tab = svgEl('g', {
        class: 'egd-ontology-v2-breadcrumb',
        data: { refId: parent.refId },
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, parent.refId);
          rerender();
        },
      });
      tab.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-breadcrumb-path',
        d: activeCameraGeometry.rectPath(tabSpec.u, tabSpec.v, tabSpec.w, tabSpec.h),
        fill: 'rgba(248, 244, 236, 0.98)',
        stroke: 'rgba(116, 104, 91, 0.44)',
        'stroke-width': '1.4',
      }));
      drawOntologyText(tab, activeCameraGeometry, tabSpec.u + 0.025, tabSpec.v + tabSpec.h * 0.64, `← ${model.labelFor(parent)}`, {
        class: 'egd-ontology-v2-breadcrumb-label', anchor: 'start', fill: 'rgba(47, 55, 63, 0.82)', 'font-size': '10', 'font-weight': '850',
      });
      cameraOverlayGroup.appendChild(tab);
    }

    if (emptyPhase) {
      const marker = activeCameraGeometry.point(0.38, 0.34);
      const markerTail = activeCameraGeometry.point(0.415, 0.34);
      const emptyState = svgEl('g', {
        class: 'egd-ontology-v2-empty-state',
        data: { phase: localState.activePane, layer: localState.activeLayer },
        role: 'status',
        'aria-label': `${ONTOLOGY_TIME_PANE_LABELS[localState.activePane]} 시점에는 snapshot이 없습니다`,
      });
      emptyState.appendChild(svgEl('circle', {
        class: 'egd-ontology-v2-empty-state-mark',
        cx: marker.x,
        cy: marker.y,
        r: 4,
        fill: localState.activeLayer === 'virtual' ? 'rgba(103, 67, 166, 0.56)' : 'rgba(35, 76, 106, 0.58)',
      }));
      emptyState.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-empty-state-line',
        d: `M ${marker.x.toFixed(1)} ${marker.y.toFixed(1)} L ${markerTail.x.toFixed(1)} ${markerTail.y.toFixed(1)}`,
        fill: 'none',
        stroke: localState.activeLayer === 'virtual' ? 'rgba(103, 67, 166, 0.34)' : 'rgba(35, 76, 106, 0.36)',
        'stroke-width': '1.4',
      }));
      drawOntologyText(emptyState, activeCameraGeometry, 0.43, 0.343, '이 시점에는 snapshot이 없습니다', {
        class: 'egd-ontology-v2-empty-state-title',
        anchor: 'start',
        fill: 'rgba(47, 55, 63, 0.68)',
        'font-size': '12',
        'font-weight': '850',
      });
      drawOntologyText(emptyState, activeCameraGeometry, 0.43, 0.386, '상단 시간축에서 다른 시점을 선택할 수 있습니다', {
        class: 'egd-ontology-v2-empty-state-help',
        anchor: 'start',
        fill: 'rgba(76, 83, 90, 0.46)',
        'font-size': '9.5',
        'font-weight': '700',
      });
      cameraOverlayGroup.appendChild(emptyState);
    }

    const childSpecs = [];
    if (mainChildren.length) {
      const columns = mainChildren.length === 1 ? 1 : Math.min(3, mainChildren.length);
      const rows = Math.ceil(mainChildren.length / columns);
      const areaU = rootSpec.u + 0.05;
      const areaV = rootSpec.v + 0.09;
      const areaW = rootSpec.w - 0.10;
      const areaH = rootSpec.h - 0.13;
      const gapU = 0.025;
      const gapV = 0.025;
      const cellW = Math.min(mainChildren.length === 1 ? areaW * 0.54 : areaW, (areaW - gapU * (columns - 1)) / columns);
      const cellH = Math.min(0.10, (areaH - gapV * (rows - 1)) / rows);
      mainChildren.forEach((child, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const usedW = columns * cellW + (columns - 1) * gapU;
        const spec = {
          u: areaU + (areaW - usedW) / 2 + column * (cellW + gapU),
          v: areaV + Math.max(0, (areaH - (rows * cellH + (rows - 1) * gapV)) / 2) + row * (cellH + gapV),
          w: cellW,
          h: cellH,
        };
        childSpecs.push({ occurrence: child, spec });
        placements.set(child.refId, { occurrence: child, geometry: activeCameraGeometry, spec, kind: 'child', camera: true });
      });
    }

    const overviewSpecs = [];
    ONTOLOGY_TIME_PANE_ORDER.forEach((phase) => {
      const active = phase === localState.activePane;
      const items = active
        ? ONTOLOGY_LAYER_ORDER.flatMap((layer) => model.planeRootsFor(phase, layer))
        : getOntologySideItems(model, phase, visibleRefs, selected);
      if (!active) sideInventories.set(phase, items);
      const layerIndexes = { virtual: 0, physical: 0 };
      const visibleItems = items.slice(0, active ? 12 : 5).filter((occurrence) => (
        !active || (occurrence.refId !== selected?.refId && !crossLayerContextRefIds.has(occurrence.refId))
      ));
      const layerCounts = {
        virtual: visibleItems.filter((occurrence) => occurrence.layer !== 'physical').length,
        physical: visibleItems.filter((occurrence) => occurrence.layer === 'physical').length,
      };
      visibleItems.forEach((occurrence) => {
        const layer = occurrence.layer === 'physical' ? 'physical' : 'virtual';
        const layerSpec = sideLayerSpecs[layer];
        const geometry = layerGeometryFor(phase, layer);
        const layerIndex = layerIndexes[layer]++;
        const count = Math.max(1, layerCounts[layer]);
        let spec;
        let placementGeometry = geometry;
        let cameraBound = false;
        if (active) {
          const focusOccupiesLayer = !!selected && selected.layer === layer;
          const columns = focusOccupiesLayer ? 1 : Math.min(3, count);
          const rows = Math.ceil(count / columns);
          const areaU = focusOccupiesLayer ? 0.66 : 0.13;
          const areaW = focusOccupiesLayer ? 0.25 : 0.74;
          const gapU = 0.035;
          const gapV = 0.035;
          const cellW = Math.min(0.24, (areaW - gapU * (columns - 1)) / columns);
          const cellH = Math.min(0.14, layerSpec.h * 0.26);
          const usedW = columns * cellW + gapU * (columns - 1);
          const usedH = rows * cellH + gapV * (rows - 1);
          const column = layerIndex % columns;
          const row = Math.floor(layerIndex / columns);
          spec = {
            u: areaU + (areaW - usedW) / 2 + column * (cellW + gapU),
            v: layerSpec.v + Math.max(0.06, (layerSpec.h - usedH) / 2) + row * (cellH + gapV),
            w: cellW,
            h: cellH,
          };
          placementGeometry = activeLayerCameraGeometries.get(layer);
          cameraBound = true;
        } else {
          const sideSafeArea = phase === 'past'
            ? { u: 0.50, w: 0.46 }
            : phase === 'future'
              ? { u: 0.04, w: 0.46 }
              : { u: 0.12, w: 0.76 };
          const topPadding = Math.min(0.11, layerSpec.h * 0.24);
          const availableHeight = Math.max(0.10, layerSpec.h - topPadding - 0.08);
          const cellH = Math.min(0.12, availableHeight / count * 0.78);
          const step = availableHeight / count;
          spec = {
            u: sideSafeArea.u,
            v: layerSpec.v + topPadding + layerIndex * step,
            w: sideSafeArea.w,
            h: cellH,
          };
          if (temporallyCoupledRefIds.has(occurrence.refId)) {
            placementGeometry = cameraGeometriesByCell.get(`${phase}:${layer}`);
            cameraBound = true;
          }
        }
        overviewSpecs.push({
          occurrence,
          geometry: placementGeometry,
          spec,
          phase,
          active,
          cameraBound,
          behind: active && layer !== localState.activeLayer,
        });
        placements.set(occurrence.refId, {
          occurrence,
          geometry: placementGeometry,
          spec,
          kind: active ? 'overview' : 'side',
          camera: cameraBound,
        });
      });
    });

    const centerOf = (placement) => {
      return placement.geometry.point(
        placement.spec.u + placement.spec.w / 2,
        placement.spec.v + placement.spec.h / 2,
      );
    };
    const anchorOf = (placement, anchor = 'center') => {
      const { spec, geometry } = placement;
      if (anchor === 'left') return geometry.point(spec.u, spec.v + spec.h / 2);
      if (anchor === 'right') return geometry.point(spec.u + spec.w, spec.v + spec.h / 2);
      if (anchor === 'top') return geometry.point(spec.u + spec.w / 2, spec.v);
      if (anchor === 'bottom') return geometry.point(spec.u + spec.w / 2, spec.v + spec.h);
      return centerOf(placement);
    };
    const planeUForScreenX = (geometry, v, screenX) => {
      const left = geometry.point(0, v);
      const right = geometry.point(1, v);
      const span = right.x - left.x;
      if (Math.abs(span) < 0.001) return 0.5;
      return Math.max(0, Math.min(1, (screenX - left.x) / span));
    };
    const timeBoundarySegmentFor = (sourcePhase, targetPhase, layer) => {
      const sourceIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(sourcePhase);
      const targetIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(targetPhase);
      if (sourceIndex < 0 || targetIndex < 0 || Math.abs(sourceIndex - targetIndex) !== 1) return null;
      const leftPhase = ONTOLOGY_TIME_PANE_ORDER[Math.min(sourceIndex, targetIndex)];
      const rightPhase = ONTOLOGY_TIME_PANE_ORDER[Math.max(sourceIndex, targetIndex)];
      const boundaryGeometry = layerGeometryFor(leftPhase, layer);
      if (!boundaryGeometry) return null;
      return {
        key: `${leftPhase}|${rightPhase}|${layer}`,
        top: boundaryGeometry.corners.tr,
        bottom: boundaryGeometry.corners.br,
      };
    };
    const pointOnTimeBoundaryAtY = (boundary, screenY) => {
      const spanY = boundary.bottom.y - boundary.top.y;
      const t = Math.abs(spanY) < 0.001
        ? 0.5
        : Math.max(0, Math.min(1, (screenY - boundary.top.y) / spanY));
      return {
        x: boundary.top.x + (boundary.bottom.x - boundary.top.x) * t,
        y: boundary.top.y + spanY * t,
      };
    };
    const routeViaTimeBoundary = (start, end, sourcePhase, targetPhase, layer) => {
      const boundary = timeBoundarySegmentFor(sourcePhase, targetPhase, layer);
      if (!boundary) return null;
      const entry = pointOnTimeBoundaryAtY(boundary, start.y);
      const exit = pointOnTimeBoundaryAtY(boundary, end.y);
      return {
        boundary,
        entry,
        exit,
        d: `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${entry.x.toFixed(1)} ${entry.y.toFixed(1)} L ${exit.x.toFixed(1)} ${exit.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
      };
    };
    const edgeKeys = new Set();
    const drawEdge = (sourceRef, targetRef, relation) => {
      const source = placements.get(sourceRef);
      const target = placements.get(targetRef);
      if (!source || !target) return;
      const key = `${sourceRef}|${relation}|${targetRef}`;
      if (edgeKeys.has(key)) return;
      edgeKeys.add(key);
      const sourceOccurrence = source.occurrence;
      const targetOccurrence = target.occurrence;
      const temporal = sourceOccurrence.timeSlice !== targetOccurrence.timeSlice;
      const crossLayer = sourceOccurrence.layer !== targetOccurrence.layer;
      let kind = 'reference';
      let sourceAnchor = 'right';
      let targetAnchor = 'left';
      let start;
      let end;
      let d;
      let temporalBoundaryRoute = null;
      let forward = true;
      if (temporal) {
        kind = 'temporal';
        const sourceIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(sourceOccurrence.timeSlice);
        const targetIndex = ONTOLOGY_TIME_PANE_ORDER.indexOf(targetOccurrence.timeSlice);
        forward = targetIndex >= sourceIndex;
        sourceAnchor = forward ? 'right' : 'left';
        targetAnchor = forward ? 'left' : 'right';
        start = anchorOf(source, sourceAnchor);
        end = anchorOf(target, targetAnchor);
        const boundaryLayer = sourceOccurrence.layer === targetOccurrence.layer
          ? sourceOccurrence.layer
          : localState.activeLayer;
        temporalBoundaryRoute = routeViaTimeBoundary(
          start,
          end,
          sourceOccurrence.timeSlice,
          targetOccurrence.timeSlice,
          boundaryLayer,
        );
        if (temporalBoundaryRoute) {
          d = temporalBoundaryRoute.d;
        } else {
          const busX = (start.x + end.x) / 2;
          d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${busX.toFixed(1)} ${start.y.toFixed(1)} L ${busX.toFixed(1)} ${end.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
        }
      } else if (crossLayer) {
        kind = 'layer';
        const depthCoordinates = source.depthCoordinates || target.depthCoordinates;
        sourceAnchor = 'depth';
        targetAnchor = 'depth';
        const sourceDepthCoordinate = depthCoordinates?.[sourceRef];
        const targetDepthCoordinate = depthCoordinates?.[targetRef];
        start = sourceDepthCoordinate
          ? source.geometry.point(sourceDepthCoordinate.u, sourceDepthCoordinate.v)
          : centerOf(source);
        end = targetDepthCoordinate
          ? target.geometry.point(targetDepthCoordinate.u, targetDepthCoordinate.v)
          : centerOf(target);
        const sharedX = sourceOccurrence.layer === localState.activeLayer
          ? start.x
          : targetOccurrence.layer === localState.activeLayer
            ? end.x
            : (start.x + end.x) / 2;
        start = { x: sharedX, y: start.y };
        end = { x: sharedX, y: end.y };
        d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
      } else {
        const sourceCenter = centerOf(source);
        const targetCenter = centerOf(target);
        forward = targetCenter.x >= sourceCenter.x;
        sourceAnchor = forward ? 'right' : 'left';
        targetAnchor = forward ? 'left' : 'right';
        start = anchorOf(source, sourceAnchor);
        end = anchorOf(target, targetAnchor);
        const busX = (start.x + end.x) / 2;
        d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} L ${busX.toFixed(1)} ${start.y.toFixed(1)} L ${busX.toFixed(1)} ${end.y.toFixed(1)} L ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
      }
      const edgeStroke = kind === 'temporal'
        ? 'rgba(111, 90, 154, 0.46)'
        : kind === 'layer'
          ? 'rgba(35, 76, 106, 0.48)'
          : 'rgba(82, 89, 98, 0.26)';
      let temporalPaneClipId = null;
      if (kind === 'temporal') {
        temporalPaneClipId = `${layerClipBaseId}-temporal-${edgeKeys.size}`;
        const temporalPaneClip = svgEl('clipPath', { id: temporalPaneClipId });
        [sourceOccurrence, targetOccurrence].forEach((occurrence) => {
          const clipGeometry = layerGeometryFor(occurrence.timeSlice, occurrence.layer);
          const clipSpec = layerSpecs[occurrence.layer];
          temporalPaneClip.appendChild(svgEl('path', {
            d: clipGeometry.rectPath(clipSpec.u, clipSpec.v, clipSpec.w, clipSpec.h),
          }));
        });
        defs.appendChild(temporalPaneClip);
      }
      const targetEdgeGroup = kind === 'layer' ? depthEdgeGroup : edgeGroup;
      targetEdgeGroup.appendChild(svgEl('path', {
        class: `egd-ontology-v2-edge egd-ontology-v2-edge-${kind}`,
        d,
        'clip-path': temporalPaneClipId ? `url(#${temporalPaneClipId})` : null,
        fill: 'none',
        stroke: edgeStroke,
        'stroke-width': kind === 'temporal' ? '1.55' : kind === 'layer' ? '1.7' : '1.1',
        'stroke-dasharray': kind === 'layer' ? '6 5' : null,
        data: {
          sourceRef,
          targetRef,
          sourceAnchor,
          targetAnchor,
          relation,
          temporalBoundaryKey: temporalBoundaryRoute?.boundary.key || '',
          temporalBoundaryAligned: temporalBoundaryRoute ? 'true' : 'false',
          paneClipped: temporalPaneClipId ? 'true' : 'false',
          depthDx: kind === 'layer' ? (end.x - start.x).toFixed(2) : '',
          depthDy: kind === 'layer' ? (end.y - start.y).toFixed(2) : '',
        },
      }));
      if (kind !== 'layer') {
        edgeGroup.appendChild(svgEl('polygon', {
          class: 'egd-ontology-v2-edge-arrow',
          points: `${end.x},${end.y} ${end.x - (forward ? 6 : -6)},${end.y - 3} ${end.x - (forward ? 6 : -6)},${end.y + 3}`,
          'clip-path': temporalPaneClipId ? `url(#${temporalPaneClipId})` : null,
          fill: edgeStroke,
        }));
      }
    };
    model.referenceEdges.forEach((edge) => {
      const source = model.byRef.get(edge.sourceRef);
      const target = model.byRef.get(edge.targetRef);
      const nestedOnOnePlane = source && target
        && source.timeSlice === target.timeSlice
        && source.layer === target.layer
        && (source.parentRef === target.refId || target.parentRef === source.refId);
      if (!nestedOnOnePlane) drawEdge(edge.sourceRef, edge.targetRef, edge.relation);
    });

    const contextualRefs = [];
    if (parent && parent.layer !== localState.activeLayer) contextualRefs.push({ occurrence: parent, role: 'parent' });
    directChildren.filter((child) => child.layer !== localState.activeLayer).forEach((child) => contextualRefs.push({ occurrence: child, role: 'child' }));
    const visibleContextualRefs = contextualRefs.slice(0, 5);
    visibleContextualRefs.forEach(({ occurrence, role }, index) => {
      if (placements.has(occurrence.refId)) return;
      const contextSpec = layerSpecs[occurrence.layer];
      if (!contextSpec) return;
      const mainPlacement = placements.get(selected?.refId);
      if (!mainPlacement) return;
      const w = Math.min(0.16, mainPlacement.spec.w * 0.38);
      const h = Math.min(0.16, Math.max(0.13, mainPlacement.spec.h * 0.58));
      const slot = (index + 1) / (visibleContextualRefs.length + 1);
      const contextIsBelow = occurrence.layer === 'physical';
      const contextCenterV = mainPlacement.spec.v + mainPlacement.spec.h * 0.58 + (contextIsBelow ? 0.025 : -0.025);
      const trailingAnchorV = contextCenterV + (contextIsBelow ? -h / 2 : h / 2);
      const activeDepthCoordinate = {
        u: mainPlacement.spec.u + mainPlacement.spec.w * slot,
        v: contextIsBelow ? mainPlacement.spec.v + mainPlacement.spec.h : mainPlacement.spec.v,
      };
      const activeDepthPoint = mainPlacement.geometry.point(activeDepthCoordinate.u, activeDepthCoordinate.v);
      const contextGeometry = activeLayerCameraGeometries.get(occurrence.layer);
      const trailingAnchorU = Math.max(
        w / 2,
        Math.min(1 - w / 2, planeUForScreenX(contextGeometry, trailingAnchorV, activeDepthPoint.x)),
      );
      const spec = {
        u: trailingAnchorU - w / 2,
        v: contextCenterV - h / 2,
        w,
        h,
      };
      const trailingDepthCoordinate = {
        u: spec.u + spec.w / 2,
        v: trailingAnchorV,
      };
      drawOntologyOccurrenceBox(coupledBehindNodeGroup, model, contextGeometry, spec, occurrence, {
        context: true,
        contextRole: role,
        behind: true,
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, occurrence.refId);
          rerender();
        },
      });
      const contextPlacement = {
        occurrence,
        geometry: contextGeometry,
        spec,
        camera: true,
        kind: 'context',
        depthCoordinates: {
          [selected.refId]: activeDepthCoordinate,
          [occurrence.refId]: trailingDepthCoordinate,
        },
      };
      placements.set(occurrence.refId, contextPlacement);
      if (selected) {
        const explicitEdge = model.referenceEdges.find((edge) => (
          (edge.sourceRef === selected.refId && edge.targetRef === occurrence.refId)
          || (edge.sourceRef === occurrence.refId && edge.targetRef === selected.refId)
        ));
        const sourceRef = explicitEdge?.sourceRef || (role === 'parent' ? occurrence.refId : selected.refId);
        const targetRef = explicitEdge?.targetRef || (role === 'parent' ? selected.refId : occurrence.refId);
        drawEdge(sourceRef, targetRef, explicitEdge?.relation || occurrence.relation || 'contains');
      }
    });

    ONTOLOGY_TIME_PANE_ORDER.filter((phase) => phase !== localState.activePane).forEach((phase) => {
      const items = sideInventories.get(phase) || [];
      if (items.length <= 5) return;
      const fromPlacement = placements.get(selected?.refId);
      if (!fromPlacement) return;
      const forward = ONTOLOGY_TIME_PANE_ORDER.indexOf(phase) > ONTOLOGY_TIME_PANE_ORDER.indexOf(localState.activePane);
      const from = anchorOf(fromPlacement, forward ? 'right' : 'left');
      const sideGeometry = layerGeometryFor(phase, localState.activeLayer);
      const to = sideGeometry.point(phase === 'past' ? 0.96 : 0.04, 0.52);
      const boundaryRoute = routeViaTimeBoundary(
        from,
        to,
        localState.activePane,
        phase,
        localState.activeLayer,
      );
      const busX = (from.x + to.x) / 2;
      const d = boundaryRoute?.d
        || `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} L ${busX.toFixed(1)} ${from.y.toFixed(1)} L ${busX.toFixed(1)} ${to.y.toFixed(1)} L ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
      edgeGroup.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-edge egd-ontology-v2-edge-bundle', d,
        fill: 'none', stroke: 'rgba(111, 90, 154, 0.38)', 'stroke-width': '1.7',
        data: {
          temporalBoundaryKey: boundaryRoute?.boundary.key || '',
          temporalBoundaryAligned: boundaryRoute ? 'true' : 'false',
        },
      }));
      const labelPoint = boundaryRoute
        ? {
          x: (boundaryRoute.entry.x + boundaryRoute.exit.x) / 2,
          y: (boundaryRoute.entry.y + boundaryRoute.exit.y) / 2 - 8,
        }
        : { x: busX, y: (from.y + to.y) / 2 - 8 };
      edgeGroup.appendChild(svgEl('rect', {
        class: 'egd-ontology-v2-bundle-label-bg', x: labelPoint.x - 18, y: labelPoint.y - 13, width: 36, height: 22, rx: 7,
        fill: 'rgba(255, 255, 255, 0.94)', stroke: 'rgba(111, 90, 154, 0.46)', 'stroke-width': '1',
      }));
      edgeGroup.appendChild(svgEl('text', {
        class: 'egd-ontology-v2-bundle-label', x: labelPoint.x, y: labelPoint.y + 3, 'text-anchor': 'middle',
        fill: 'rgba(89, 69, 132, 0.94)', 'font-size': '10', 'font-weight': '900',
      }, `+${items.length - 5}`));
    });

    if (selected && rootSpec) drawOntologyOccurrenceBox(activeNodeGroup, model, activeCameraGeometry, rootSpec, selected, {
      root: true,
      expanded: mainChildren.length > 0,
    });
    childSpecs.forEach(({ occurrence, spec }) => {
      drawOntologyOccurrenceBox(activeNodeGroup, model, activeCameraGeometry, spec, occurrence, {
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, occurrence.refId);
          rerender();
        },
      });
    });
    overviewSpecs.forEach(({ occurrence, geometry, spec, phase, active, cameraBound, behind }) => {
      const targetGroup = active
        ? (behind ? coupledBehindNodeGroup : activeNodeGroup)
        : fixedNodeGroup;
      const renderedBox = drawOntologyOccurrenceBox(targetGroup, model, geometry, spec, occurrence, {
        side: !active,
        overview: active,
        behind: behind || (!active && occurrence.layer !== localState.activeLayer),
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!active) activateOntologyPane(localState, model, phase, occurrence.conceptId);
          selectOntologyOccurrence(localState, model, occurrence.refId);
          rerender();
        },
      });
      if (!active) {
        const clipId = layerClipIds.get(`${phase}:${occurrence.layer}`);
        if (clipId) renderedBox.setAttribute('clip-path', `url(#${clipId})`);
        renderedBox.dataset.clipLayer = occurrence.layer;
        if (cameraBound) renderedBox.dataset.cameraCoupled = 'temporal';
      }
    });

    const arrowY = 62;
    const paneCenters = ONTOLOGY_TIME_PANE_ORDER.map((phase) => {
      const geometry = geometries.get(phase);
      return { phase, point: geometry.point(0.5, 0) };
    }).sort((a, b) => a.point.x - b.point.x);
    for (let index = 0; index < paneCenters.length - 1; index += 1) {
      const from = paneCenters[index].point;
      const to = paneCenters[index + 1].point;
      overlayGroup.appendChild(svgEl('path', {
        class: 'egd-ontology-v2-time-axis-arrow',
        d: `M ${from.x + 24} ${arrowY} L ${to.x - 24} ${arrowY}`,
        fill: 'none', stroke: 'rgba(111, 90, 154, 0.30)', 'stroke-width': '1.5', 'stroke-dasharray': '7 6',
      }));
      overlayGroup.appendChild(svgEl('polygon', {
        class: 'egd-ontology-v2-time-axis-arrow-head',
        points: `${to.x - 24},${arrowY} ${to.x - 34},${arrowY - 5} ${to.x - 34},${arrowY + 5}`,
        fill: 'rgba(111, 90, 154, 0.66)',
      }));
    }

    cameraGroup.appendChild(coupledBehindNodeGroup);
    cameraGroup.appendChild(frontLayerVeilGroup);
    cameraGroup.appendChild(activeNodeGroup);
    cameraGroup.appendChild(cameraOverlayGroup);
    svg.appendChild(surfaceGroup);
    svg.appendChild(edgeGroup);
    svg.appendChild(cameraGroup);
    svg.appendChild(depthEdgeGroup);
    svg.appendChild(fixedNodeGroup);
    svg.appendChild(overlayGroup);
    // Interaction controls stay above visual occlusion and shading layers.
    svg.appendChild(layerControlGroup);
    stage.appendChild(svg);
    stage.appendChild(el('div', {
      class: 'egd-ontology-stage-hint',
      'aria-hidden': 'true',
    }, '드래그 이동  ·  휠 스크롤  ·  ⌘/Ctrl + 휠 확대'));

    const minimap = el('div', {
      class: 'egd-ontology-minimap egd-ontology-v2-minimap',
      data: {
        activePane: localState.activePane,
        activeStratum: localState.activeLayer,
        zoom: camera.zoom.toFixed(2),
      },
      role: 'navigation',
      'aria-label': `${ONTOLOGY_TIME_PANE_LABELS[localState.activePane]} pane 개념 분포 미니맵`,
    });
    const miniCorners = ONTOLOGY_LAYER_ORDER.flatMap((layer) => (
      Object.values(layerGeometryFor(localState.activePane, layer).corners)
    ));
    const miniMinX = Math.min(...miniCorners.map((point) => point.x));
    const miniMaxX = Math.max(...miniCorners.map((point) => point.x));
    const miniMinY = Math.min(...miniCorners.map((point) => point.y));
    const miniMaxY = Math.max(...miniCorners.map((point) => point.y));
    const miniPadX = Math.max(8, (miniMaxX - miniMinX) * 0.018);
    const miniPadY = Math.max(6, (miniMaxY - miniMinY) * 0.025);
    const miniViewWidth = miniMaxX - miniMinX + miniPadX * 2;
    const miniViewHeight = miniMaxY - miniMinY + miniPadY * 2;
    const miniSvg = svgEl('svg', {
      class: 'egd-ontology-minimap-map',
      viewBox: `${(miniMinX - miniPadX).toFixed(1)} ${(miniMinY - miniPadY).toFixed(1)} ${(miniMaxX - miniMinX + miniPadX * 2).toFixed(1)} ${(miniMaxY - miniMinY + miniPadY * 2).toFixed(1)}`,
      preserveAspectRatio: 'none',
      data: { scope: 'active-pane', phase: localState.activePane },
    });
    layerRenderOrder.forEach((layer) => {
      const miniGeometry = layerGeometryFor(localState.activePane, layer);
      const spec = layerSpecs[layer];
      const activateMiniRegion = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setOntologyLayer(localState, layer);
        rerender();
      };
      miniSvg.appendChild(svgEl('path', {
        class: `egd-ontology-minimap-layer-pane egd-ontology-minimap-time-active${layer === localState.activeLayer ? ' egd-ontology-minimap-layer-pane-active' : ''}`,
        d: miniGeometry.rectPath(spec.u, spec.v, spec.w, spec.h),
        fill: layer === 'virtual' ? '#7E57C2' : '#2D5A7B',
        data: { phase: localState.activePane, layer },
        tabindex: '0',
        role: 'button',
        'aria-label': `${ONTOLOGY_TIME_PANE_LABELS[localState.activePane]} ${layer === 'virtual' ? '가상' : '물리'} 층으로 이동`,
        onclick: activateMiniRegion,
        onkeydown: (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') activateMiniRegion(ev);
        },
      }));
    });
    const minimapRefs = new Set();
    placements.forEach((placement, refId) => {
      if (placement.occurrence.timeSlice !== localState.activePane) return;
      if (minimapRefs.has(refId)) return;
      minimapRefs.add(refId);
      const occurrence = placement.occurrence;
      const geometry = layerGeometryFor(occurrence.timeSlice, occurrence.layer);
      const point = geometry.point(
        placement.spec.u + placement.spec.w / 2,
        placement.spec.v + placement.spec.h / 2,
      );
      const isSelected = refId === selected?.refId;
      const markerSize = isSelected ? 5 : 3.5;
      miniSvg.appendChild(svgEl('ellipse', {
        class: `egd-ontology-minimap-node${isSelected ? ' egd-ontology-minimap-node-selected' : ''}`,
        cx: point.x,
        cy: point.y,
        rx: markerSize * miniViewWidth / 168,
        ry: markerSize * miniViewHeight / 110,
        fill: occurrence.layer === 'virtual' ? '#6F469F' : '#244F6C',
        stroke: 'rgba(255, 255, 255, 0.94)',
        'stroke-width': isSelected ? '4' : '2.5',
        data: { refId, phase: occurrence.timeSlice, layer: occurrence.layer },
        role: 'button',
        tabindex: '0',
        'aria-label': `${model.labelFor(occurrence)} 개념으로 이동`,
        onclick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, refId);
          rerender();
        },
        onkeydown: (ev) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return;
          ev.preventDefault();
          ev.stopPropagation();
          selectOntologyOccurrence(localState, model, refId);
          rerender();
        },
      }));
    });
    miniSvg.appendChild(svgEl('path', {
      class: 'egd-ontology-minimap-viewport-halo',
      d: activeGeometry.rectPath(
        activeCameraGeometry.viewportSpec.u,
        activeCameraGeometry.viewportSpec.v,
        activeCameraGeometry.viewportSpec.w,
        activeCameraGeometry.viewportSpec.h,
      ),
      fill: 'none', stroke: 'rgba(255, 255, 255, 0.92)', 'stroke-width': '4.2',
    }));
    miniSvg.appendChild(svgEl('path', {
      class: 'egd-ontology-minimap-viewport',
      d: activeGeometry.rectPath(
        activeCameraGeometry.viewportSpec.u,
        activeCameraGeometry.viewportSpec.v,
        activeCameraGeometry.viewportSpec.w,
        activeCameraGeometry.viewportSpec.h,
      ),
      fill: 'none',
      stroke: localState.activeLayer === 'virtual' ? 'rgba(103, 67, 166, 0.96)' : 'rgba(35, 76, 106, 0.96)',
      'stroke-width': '2.2',
      'stroke-dasharray': '5 3',
    }));
    const minimapSummaryId = `${String(card?.id || 'ontology')}-minimap-summary`;
    minimap.setAttribute('aria-describedby', minimapSummaryId);
    minimap.appendChild(miniSvg);
    minimap.appendChild(el('div', {
      id: minimapSummaryId,
      class: 'egd-ontology-minimap-context',
    },
      el('span', { class: 'egd-ontology-minimap-context-title' },
        selected ? `${model.labelFor(selected)} 주변` : '선택된 개념 없음'),
      el('span', { class: 'egd-ontology-minimap-context-coordinate' },
        `${ONTOLOGY_TIME_PANE_LABELS[localState.activePane]} · ${localState.activeLayer === 'virtual' ? '가상' : '물리'}`,
      ),
    ));
    minimap.appendChild(el('div', {
      class: 'egd-ontology-minimap-legend',
      'aria-hidden': 'true',
    },
      el('span', { class: 'egd-ontology-minimap-legend-item' },
        el('i', { class: 'egd-ontology-minimap-legend-swatch egd-ontology-minimap-legend-swatch-virtual' }), '가상'),
      el('span', { class: 'egd-ontology-minimap-legend-item' },
        el('i', { class: 'egd-ontology-minimap-legend-swatch egd-ontology-minimap-legend-swatch-physical' }), '물리'),
      el('span', { class: 'egd-ontology-minimap-legend-item' },
        el('i', { class: 'egd-ontology-minimap-legend-swatch egd-ontology-minimap-legend-swatch-selected' }), '선택'),
      el('span', { class: 'egd-ontology-minimap-legend-item' },
        el('i', { class: 'egd-ontology-minimap-legend-swatch egd-ontology-minimap-legend-swatch-viewport' }), '화면'),
    ));
    stage.appendChild(minimap);
    const tools = el('div', { class: 'egd-ontology-stage-mini-tools' },
      el('button', { class: 'egd-ontology-stage-mini-tool egd-ontology-stage-mini-tool-zoom-in', title: '확대', onclick: (ev) => {
        ev.stopPropagation(); adjustOntologyCameraZoom(camera, 1); rerender();
      } }, '+'),
      el('button', { class: 'egd-ontology-stage-mini-tool egd-ontology-stage-mini-tool-reset', title: '맞춤', onclick: (ev) => {
        ev.stopPropagation(); resetOntologyCamera(camera); rerender();
      } }, '⌂'),
      el('button', { class: 'egd-ontology-stage-mini-tool egd-ontology-stage-mini-tool-zoom-out', title: '축소', onclick: (ev) => {
        ev.stopPropagation(); adjustOntologyCameraZoom(camera, -1); rerender();
      } }, '−'),
    );
    stage.appendChild(tools);
    stage.appendChild(el('div', { class: 'egd-ontology-stage-zoom-label' }, `${Math.round(camera.zoom * 100)}%`));
  }

  async function loadOntologyGraph() {
    const response = await fetch(ONTOLOGY_GRAPH_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Ontology graph load failed: ${response.status}`);
    return validateOntologyGraph(await response.json());
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
    const windowMargin = 12;
    const safe = safeViewportRect({ avoidHud: false, margin: windowMargin });
    const initialWidth = Math.min(1760, Math.max(900, safe.width));
    const initialHeight = Math.min(900, Math.max(560, safe.height));
    const offset = ((cardSeq - 1) % 6) * 24;
    const placement = clampClientCardRect(
      initialWidth,
      initialHeight,
      safe.left + safe.width / 2 + offset,
      safe.top + safe.height / 2 + offset,
      { avoidHud: false, margin: windowMargin },
    );
    const topLeft = viewportToCanvasPoint(placement.left, placement.top);
    const initialTop = Math.round(topLeft.y);
    const deskWindow = spawnDeskWindowShell({
      id,
      kind: 'ontology',
      className: 'egd-ontology-card',
      headerClassName: 'egd-ontology-header',
      bodyClassName: 'egd-ontology-body',
      inputPolicy: 'adapter-owned',
      sourceRef,
      minWidth: 680,
      minHeight: 440,
      createDirtyReason: 'create-ontology-card',
      moveDirtyReason: 'move-ontology-card',
      resizeDirtyReason: 'resize-ontology-card',
      style: {
        top: initialTop + 'px',
        left: Math.round(topLeft.x) + 'px',
        width: initialWidth + 'px',
        height: initialHeight + 'px',
        zIndex: String(++cardZ),
      },
    });
    const card = deskWindow.root;
    deskWindow.slots.identity.classList.add('egd-ontology-titlebar-identity');
    deskWindow.slots.identity.append(
      el('div', { class: 'egd-ontology-title' }, '온톨로지'),
      el('div', { class: 'egd-ontology-header-lens' }, '과거 · 현재 · 미래  /  가상 · 물리'),
    );

    const initialSelectedRefId = initialState.selectedRefId || initialState.selectedId || 'present.server';
    const initialPane = ONTOLOGY_TIME_PANE_ORDER.includes(initialState.activePane) ? initialState.activePane : 'present';
    const initialLayer = ONTOLOGY_LAYER_ORDER.includes(initialState.activeLayer || initialState.activeStratum)
      ? (initialState.activeLayer || initialState.activeStratum)
      : 'virtual';
    const localState = {
      mode: 'composite',
      selectedId: initialSelectedRefId,
      selectedRefId: initialSelectedRefId,
      selectedConceptId: initialState.selectedConceptId || 'server',
      focusTarget: 'object',
      activePane: initialPane,
      activeLayer: initialLayer,
      activeStratum: initialLayer,
      activeDepth: initialLayer,
      pan: initialState.pan || { x: 0, y: 0 },
      zoom: Number.isFinite(initialState.zoom) ? initialState.zoom : 1,
      cameraByCell: initialState.cameraByCell || {},
    };
    card._ontologyState = localState;

    let stage;
    card._ontologyRender = () => {
      if (stage && card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
    };
    card._ontologyApplyWheelDelta = (deltaX = 0, deltaY = 0, modifiers = {}) => {
      const camera = getOntologyCamera(localState);
      if (modifiers.ctrlKey || modifiers.metaKey) {
        adjustOntologyCameraZoom(camera, deltaY < 0 ? 1 : -1);
      } else {
        camera.x -= deltaX;
        camera.y -= deltaY;
      }
      if (stage && card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
      return {
        activePane: localState.activePane,
        activeLayer: localState.activeLayer,
        activeDepth: localState.activeLayer,
        activeStratum: localState.activeLayer,
        pan: { x: camera.x, y: camera.y },
        zoom: camera.zoom,
      };
    };
    card._ontologyPanBy = (deltaX = 0, deltaY = 0) => {
      const camera = getOntologyCamera(localState);
      camera.x += deltaX;
      camera.y += deltaY;
      card._ontologyRender();
      return { x: camera.x, y: camera.y };
    };
    stage = el('div', {
      class: 'egd-ontology-stage',
      tabindex: '0',
      'aria-label': 'EG-Desk ontology interaction canvas',
    },
      el('div', { class: 'egd-ontology-loading' }, '온톨로지 그래프를 불러오는 중...'),
    );
    const body = deskWindow.slots.content;
    body.appendChild(stage);
    deskWindow.onResize(() => {
      if (card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
    });

    let viewDrag = null;
    const beginViewPan = (ev) => {
      if (ev.button !== 0 || ev.target.closest('.egd-ontology-v2-breadcrumb, .egd-ontology-v2-layer-label-control, .egd-ontology-v2-layer-switch-hit, .egd-ontology-minimap, .egd-ontology-stage-mini-tools, .egd-ontology-stage-zoom-label')) return;
      const conceptBox = ev.target.closest('.egd-ontology-v2-box');
      if (conceptBox && !conceptBox.classList.contains('egd-ontology-v2-box-root')) return;
      const paneHit = ev.target.closest('.egd-ontology-v2-pane-hit');
      if (paneHit && paneHit.dataset.phase !== localState.activePane) return;
      if (viewDrag) return;
      focusCanvasCard(card);
      try { stage.focus({ preventScroll: true }); } catch { stage.focus(); }
      const camera = getOntologyCamera(localState);
      viewDrag = { x: ev.clientX, y: ev.clientY, panX: camera.x, panY: camera.y, moved: false, pointerId: ev.pointerId ?? null };
      if (ev.pointerId != null) {
        try { stage.setPointerCapture(ev.pointerId); } catch {}
      }
      stage.classList.add('egd-ontology-stage-panning');
      ev.preventDefault();
    };
    stage.addEventListener('pointerdown', beginViewPan, { capture: true });
    stage.addEventListener('mousedown', beginViewPan, { capture: true });
    stage.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.target.closest('.egd-ontology-minimap, .egd-ontology-stage-mini-tools, .egd-ontology-stage-zoom-label')) return;
      card._ontologyApplyWheelDelta(ev.deltaX, ev.deltaY, { ctrlKey: ev.ctrlKey, metaKey: ev.metaKey });
    }, { capture: true, passive: false });
    body.addEventListener('wheel', (ev) => {
      if (!stage.contains(ev.target)) ev.stopPropagation();
    }, { capture: true, passive: false });
    stage.addEventListener('keydown', (ev) => {
      let handled = true;
      const camera = getOntologyCamera(localState);
      if (ev.key === 'ArrowLeft') {
        camera.x += 36;
      } else if (ev.key === 'ArrowRight') {
        camera.x -= 36;
      } else if (ev.key === 'ArrowUp') {
        camera.y += 36;
      } else if (ev.key === 'ArrowDown') {
        camera.y -= 36;
      } else if (ev.key === '0') {
        resetOntologyCamera(camera);
      } else {
        handled = false;
      }
      if (!handled) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
    });

    const onMove = (ev) => {
      if (viewDrag) {
        const distance = Math.hypot(ev.clientX - viewDrag.x, ev.clientY - viewDrag.y);
        if (distance > 3) viewDrag.moved = true;
        const camera = getOntologyCamera(localState);
        camera.x = viewDrag.panX + (ev.clientX - viewDrag.x);
        camera.y = viewDrag.panY + (ev.clientY - viewDrag.y);
        if (card._ontologyGraph) renderOntologyMap(stage, card._ontologyGraph, localState);
        stage.classList.add('egd-ontology-stage-panning');
      }
    };
    const onUp = () => {
      if (viewDrag?.moved) {
        localState.suppressNextSurfaceClick = true;
        setTimeout(() => { localState.suppressNextSurfaceClick = false; }, 0);
      }
      viewDrag = null;
      stage.classList.remove('egd-ontology-stage-panning');
    };
    stage.addEventListener('mousemove', onMove, { capture: true });
    stage.addEventListener('mouseup', onUp, { capture: true });
    stage.addEventListener('pointermove', onMove, { capture: true });
    stage.addEventListener('pointerup', onUp, { capture: true });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    deskWindow.registerCleanup(() => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointerdown', beginViewPan, { capture: true });
      stage.removeEventListener('mousedown', beginViewPan, { capture: true });
      stage.removeEventListener('mousemove', onMove, { capture: true });
      stage.removeEventListener('mouseup', onUp, { capture: true });
      stage.removeEventListener('pointermove', onMove, { capture: true });
      stage.removeEventListener('pointerup', onUp, { capture: true });
    });

    loadOntologyGraph()
      .then((graph) => {
        card._ontologyGraph = graph;
        renderOntologyMap(stage, graph, localState);
      })
      .catch((error) => {
        stage.textContent = '';
        stage.appendChild(el('div', { class: 'egd-ontology-error' }, `온톨로지 그래프 로드 실패: ${error.message || String(error)}`));
      });

    return card;
  }

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

  function spawnFileCard(options = {}) {
    if (options.openMode !== 'new' && !options.restore) {
      const existing = document.querySelector('.egd-file-card');
      if (existing) { focusCanvasCard(existing); return existing; }
    }
    const shell = spawnDeskWindowShell({ id: `egd-file-card-${++cardSeq}`, kind: 'file', className: 'egd-file-card',
      activate: !options.restore, sourceRef: { kind: 'file-surface', id: `file-view-${chatBindingNonce()}`, scope: 'local-files' },
      style: { left: '180px', top: '140px', width: '960px', height: '650px' } });
    const card = shell.root;
    card.dataset.testid = 'file-card';
    card.setAttribute('aria-label', '파일 작업 창');
    const title = el('strong', { class: 'egd-file-card-title' }, '파일');
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
    let restoring = !!options.record;
    let preserveRestoreRecord = false;
    let rootNeedsReconnect = false;
    card._fileRecord = cloneJson(options.record || FileCardState.fileCardRecord(null));
    const publish = snapshot => {
      if (!card.isConnected || restoring) return;
      const failedOriginal = preserveRestoreRecord && (!snapshot.fileId || (snapshot.fileId === options.record?.fileId && options.record?.draftId && !snapshot.draftId));
      if (!failedOriginal) {
        card._fileRecord = FileCardState.fileCardRecord(rootHandle, snapshot);
        preserveRestoreRecord = false;
      }
      badge.textContent = failedOriginal ? '복구 확인 필요' : rootNeedsReconnect || snapshot.sourceConnection === 'reconnect-required' ? '보관 사본 · 원본 재연결 필요' : snapshot.dirty ? '작업사본 · 미저장' : '파일';
      title.textContent = rootHandle?.name || '파일';
      attachButton.disabled = !snapshot.fileId || !snapshot.draftId;
      markAgendaDirty('file-view-state', card);
    };
    const ready = (async () => {
      try {
        const fileModule = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskFileView.sys.mjs');
        const service = fileModule.createEGDeskFileServiceCallbacks({ request: requestLocalFilePacket });
        const pickers = fileModule.createEGDeskNativeFilePickers({ service, pickDirectory: pickNativeFileDirectory, pickSaveFile: pickNativeFileSaveFile });
        view = fileModule.createEGDeskFileView({ document, service,
          chooseRoot: async () => {
            const selected = await pickers.chooseRoot();
            if (selected) { rootHandle = selected; rootNeedsReconnect = false; notice.hidden = true; }
            return selected;
          },
          chooseSaveAs: options => pickers.chooseSaveAs(options),
          onState: publish,
        });
        card._fileView = view;
        view.element.inert = !!options.record;
        view.element.setAttribute('aria-busy', String(!!options.record));
        mount.appendChild(view.element);
        view.element.dataset.testid = 'file-view';
        for (const [selector, testid] of Object.entries({
          '.egdesk-file-connect': 'file-connect-root', '.egdesk-file-tree': 'file-tree', '.egdesk-file-search-input': 'file-search',
          '.egdesk-file-editor': 'file-editor', '.egdesk-file-review-button': 'file-review',
          '.egdesk-file-save-button': 'file-save-copy', '.egdesk-file-save-as-button': 'file-save-as', '.egdesk-file-reconnect-button': 'file-reconnect-source',
        })) view.element.querySelector(selector)?.setAttribute('data-testid', testid);
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
          const scroller = view.element.querySelector('.egdesk-file-editor-label:not([hidden]) .egdesk-file-editor, .egdesk-file-viewer:not([hidden])');
          if (scroller) scroller.scrollTop = options.record.scrollTop || 0;
          card.dataset.restored = 'true';
        }
        restoring = false;
        publish(view.snapshot());
      } catch (error) {
        restoring = false;
        notice.hidden = false;
        notice.textContent = `파일 화면을 준비하지 못했습니다: ${error.message}`;
        badge.textContent = '연결 확인 필요';
      } finally { if (view) { view.element.inert = false; view.element.setAttribute('aria-busy', 'false'); } }
    })();
    const closeGate = FileCardState.createFileCloseGate({
      dispose: async () => { await ready; return view ? view.close() : true; },
      onState: status => {
        card.dataset.closeState = status.status;
        if (status.status !== 'closed') { notice.hidden = false; notice.textContent = status.message; }
      },
    });
    card._beforeClose = () => closeGate.requestClose();
    card._fileReady = ready;
    return card;
  }

  function spawnSettingsCard(options = {}) {
    const sourceRef = singletonSourceRef('settings', { kind: 'settings-card' });
    const existing = options.openMode === 'new' ? null : focusOpenSourceCard(sourceRef);
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
    const initialWidth = options.firstUse ? window.innerWidth : 720;
    const initialHeight = options.firstUse ? window.innerHeight : cardHeightForWidth(initialWidth);
    const offset = ((cardSeq - 1) % 6) * 24;
    const center = viewportToCanvasPoint(
      window.innerWidth / 2 + offset,
      window.innerHeight / 2 + offset,
    );
    const deskWindow = spawnDeskWindowShell({
      id,
      kind: 'browser',
      className: 'egd-browser-card',
      inputPolicy: 'native-content',
      sourceRef,
      toolbar: true,
      progress: true,
      minWidth: 320,
      minHeight: 250,
      createDirtyReason: 'create-browser-card',
      moveDirtyReason: 'move-browser-card',
      resizeDirtyReason: 'resize-browser-card',
      style: {
        top: (options.firstUse ? 0 : Math.round(center.y - initialHeight / 2)) + 'px',
        left: (options.firstUse ? 0 : Math.round(center.x - initialWidth / 2)) + 'px',
        width: initialWidth + 'px',
        height: initialHeight + 'px',
        zIndex: String(++cardZ),
      },
    });
    const card = deskWindow.root;

    const urlInput = el('input', {
      type: 'text',
      class: 'egd-card-url',
      'aria-label': '주소 또는 검색어',
      data: { testid: options.firstUse ? 'first-use-address' : 'browser-address' },
      value: normalizedUrl,
    });
    if (options.fixedLogicalHeight) card._fixedLogicalHeight = options.fixedLogicalHeight;
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

    const header = deskWindow.slots.header;
    deskWindow.slots.identity.classList.add('egd-card-page-meta');
    deskWindow.slots.identity.append(pageTitle, pageStatus);
    deskWindow.slots.toolbar.append(
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
    );
    if (options.firstUse) {
      card.classList.add('egd-first-use-browser');
      card.dataset.testid = 'first-use-root';
      card.setAttribute('aria-label', 'EG-Desk 시작');
      card.setAttribute('role', 'region');
      urlInput.id = 'egd-first-use-address';
      deskWindow.slots.toolbar.appendChild(el('button', {
        id: 'egd-desk-entry', 'aria-label': 'Desk 시작', data: { testid: 'desk-entry' },
        onclick: () => enterLocalDesk(),
      }, 'Desk 시작'));
    }

    // ---- Body → wrap (logical 1440×900) → XUL browser ----
    const wrap = el('div', { class: 'egd-card-wrap' });
    wrap.style.width = CARD_LOGICAL_W + 'px';
    wrap.style.height = CARD_LOGICAL_H + 'px';

    const bodyCapture = el('div', { class: 'egd-card-body-capture' });
    const body = deskWindow.slots.content;
    body.append(wrap, bodyCapture);

    try {
      xulBrowser = document.createXULElement('browser');
      xulBrowser.setAttribute('type', 'content');
      xulBrowser.setAttribute('remote', 'true');
      xulBrowser.setAttribute('maychangeremoteness', 'true');
      xulBrowser.setAttribute('disableglobalhistory', 'true');
      xulBrowser.setAttribute('flex', '1');
      ensureBrowserAgentActor();
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
      if (!ensureBrowserAgentActor()) throw new Error('Browser actor registration failed');
      const context = xulBrowser?.browsingContext;
      const windowGlobal = context?.currentWindowGlobal;
      if (!windowGlobal?.getActor) throw new Error('Browser document is not ready for capture');
      // Do not swallow remote-type/import errors or fall back to another page.
      const actor = windowGlobal.getActor(BROWSER_AGENT_ACTOR_NAME);
      if (!actor?.sendQuery) throw new Error('Browser agent JSActor unavailable');
      const result = await actor.sendQuery(method, payload);
      if (method === 'captureInput' && (!card.isConnected || xulBrowser.browsingContext !== context
          || context.currentWindowGlobal !== windowGlobal)) throw new Error('Browser changed during capture; attach the current page again');
      return result;
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
        item('복제', '현재 URL을 새 Desk Window로 열기', duplicateBrowser),
        item('URL 복사', browserState.uri, () => copyTextToClipboard(browserState.uri)),
        item('Chat에 첨부', '현재 페이지를 다음 Chat의 자료로 선택', () => {
          const source = chatInputSourceForView(card);
          if (source) state.codexBridge.addInputSources(state.codex.activeThreadId, [source]);
        }),
        item('홈', browserState.homeUrl, () => navigateBrowser(browserState.homeUrl)),
        item(browserState.loading ? '중지' : '새로고침', browserState.loading ? '로드 중지' : '현재 페이지 새로고침', () => (browserState.loading ? stopBrowser() : reloadBrowser())),
        item(isCardFullscreen(card) ? '창 복귀' : '최대화', 'Desk Window 최대화 전환', () => toggleCardFullscreen(card)),
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
      captureInput: async (options = {}) => {
        const doc = readBrowserDocument();
        return doc ? InputContext.captureDocumentText(doc, options) : browserAgentActorRequest('captureInput', { options });
      },
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
      if (deskWindow.startPanIfNeeded(ev)) return;
      deskWindow.focus();
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
    bodyCapture.addEventListener('wheel', routeWheelToCanvas, { passive: false });
    for (const target of [card, header, body, wrap, xulBrowser]) {
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
      const logicalHeight = card._fixedLogicalHeight || Math.max(1, Math.round(bh / scale));
      if (options.firstUse && !card._fixedLogicalHeight) card._fixedLogicalHeight = logicalHeight;
      wrap.style.left = Math.max(0, Math.round((bw - safeBw) / 2)) + 'px';
      wrap.style.height = logicalHeight + 'px';
      wrap.style.transform = `scale(${scale})`;
    };
    deskWindow.onResize(updateFitScale);

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
    };

    console.warn(TAG, 'browser Desk Window spawned', id, normalizedUrl);
    card._xulBrowser = xulBrowser;
    card._wrap = wrap;
    deskWindow.registerCleanup(cleanupCard);
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
    // ---- Keyboard focus handoff ----
    // chrome 문서에서는 iframe 요소 자체가 chrome activeElement가 되어야
    // 키 이벤트가 서브문서(xterm)로 라우팅된다. xterm의 in-frame focus만으로는
    // 프레임 경계를 못 넘으므로 부모 쪽에서 명시적으로 핸드오프한다.
    const focusTerminal = () => {
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
      if (ev.data?.type === 'terminal-ready') focusTerminal();
      if (['terminal-ready', 'terminal-exit-confirmed'].includes(ev.data?.type)
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
          contentWin.terminalAPI.kill();
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
      return !!target.closest('#egd-hud, #egd-codex-activity-panel, #egd-codex-input-panel, #egd-answer-briefing');
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
    state.resetWheelSession = resetWheelSession;
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
      if (ev.button === 1) {   // 휠클릭(중버튼) 드래그 = 팬 (Miro/Figma 관습)
        beginCanvasPan(ev);
        return;
      }
      if (ev.button !== 0) return;
      if (ev.metaKey) {        // Cmd+드래그 = 팬 (Cmd+휠 팬과 일관된 modifier)
        beginCanvasPan(ev);
        return;
      }
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
      if (state.surface.mode === 'browser') return;
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
    // (팬 modifier로 Space는 쓰지 않는다 — 터미널/브라우저 카드 안의
    //  스페이스 입력과 충돌. Cmd+드래그가 팬 제스처)
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

  function readSurfacePref(key) {
    try {
      const raw = servicesRef().prefs.getStringPref(key, '');
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      // Corrupt existing data is evidence of a returning user, never a fresh-profile signal.
      return { unreadable: true };
    }
  }

  function writeSurfacePref(key, value) {
    try { servicesRef().prefs.setStringPref(key, JSON.stringify(value)); return true; }
    catch (error) { console.warn(TAG, 'surface state write failed', key, error); return false; }
  }

  let deskRecoveryStore = null;
  function recoveryStore() {
    if (!deskRecoveryStore) deskRecoveryStore = RecoveryState.createDeskRecoveryStore({
      read: key => servicesRef().prefs.prefHasUserValue(key) ? servicesRef().prefs.getStringPref(key) : null,
      write: (key, value) => servicesRef().prefs.setStringPref(key, value),
      listKeys: prefix => servicesRef().prefs.getChildList(prefix),
    });
    return deskRecoveryStore;
  }

  function rawDeskRecord() {
    return servicesRef().prefs.prefHasUserValue(DESK_SESSION_PREF) ? servicesRef().prefs.getStringPref(DESK_SESSION_PREF) : null;
  }

  function prepareLegacyChatBackup(deskSession, raw) {
    const records = ChatState.extractLegacyChatRecords(deskSession);
    if (!records.length || typeof raw !== 'string') return records;
    state.codex.legacyChatBackupRequired = true;
    const existing = recoveryStore().get(deskSession.chat?.localHistoryBackupKey);
    try {
      const backup = existing || recoveryStore().preserve(raw, 'local-chat-history-before-import');
      state.codex.legacyChatBackupKey = backup.key;
      state.codex.localHistoryError = null;
    } catch (error) {
      state.codex.localHistoryError = '기존 채팅 기록의 백업을 확인하지 못했습니다. 원본 저장값은 유지됩니다.';
      console.warn(TAG, 'legacy chat backup failed', error);
    }
    return records;
  }

  function renderDeskRecoveryNotice(force = false) {
    const records = recoveryStore().list();
    const opener = document.getElementById('egd-recovery-open');
    if (opener) opener.hidden = records.length === 0;
    document.getElementById('egd-desk-recovery')?.remove();
    if (!force && (!state.surface.recoveryBackupKey && !state.surface.recoveryProtected || state.surface.recoveryAcknowledged)) return;
    const key = state.surface.recoveryBackupKey || records[0]?.key || null;
    const panel = el('section', { id: 'egd-desk-recovery', role: 'region', 'aria-label': 'Desk 복구 기록', data: { testid: 'desk-recovery', backupKey: key || '' } },
      el('strong', {}, '이전 Desk 복구 기록'),
      el('p', {}, state.surface.recoveryProtected
        ? '원본을 별도로 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요.'
        : '이전 기록 원본을 별도로 보존했습니다. 지금 열어 둔 작업은 자동으로 저장됩니다.'),
      state.surface.recoveryReason ? el('p', {}, state.surface.recoveryReason) : null,
      el('button', { 'aria-label': '이전 기록 복구 다시 시도', data: { testid: 'recovery-retry' }, onclick: () => retryDeskRecovery(key) }, '이전 기록 다시 시도'),
      el('button', { 'aria-label': '원본을 보존하고 현재 작업 계속', data: { testid: 'recovery-continue' }, onclick: continueDeskRecovery }, '현재 작업 계속'));
    document.documentElement.appendChild(panel);
  }

  function retryDeskRecovery(key = state.surface.recoveryBackupKey) {
    const raw = key ? recoveryStore().get(key)?.raw : rawDeskRecord();
    if (raw == null) { boardNotice('복구 기록을 찾지 못했습니다. 현재 작업은 유지됩니다.'); return false; }
    const previousActiveId = state.activeEntityId;
    state.surface.restoring = true;
    let result;
    try { result = recoveryStore().recover(raw, snapshot => restoreDeskSession(snapshot, { merge: true })); }
    finally { state.surface.restoring = false; }
    state.surface.recoveryProtected = result.recoveryProtected;
    state.surface.recoveryBackupKey = key || result.backupKey;
    state.surface.recoveryReason = result.restored ? '기존 작업을 유지하고 추가 가능한 화면을 복구했습니다.' : result.reason;
    state.surface.recoveryAcknowledged = false;
    if (previousActiveId) setActiveEntity(document.getElementById(previousActiveId));
    persistDeskSession();
    renderDeskRecoveryNotice(true);
    return result.restored;
  }

  function continueDeskRecovery() {
    if (state.surface.recoveryProtected) {
      try {
        const record = recoveryStore().preserve(rawDeskRecord(), state.surface.recoveryReason);
        state.surface.recoveryBackupKey = record.key;
        state.surface.recoveryProtected = false;
      } catch (error) { state.surface.recoveryReason = error.message; renderDeskRecoveryNotice(true); return false; }
    }
    state.surface.recoveryAcknowledged = true;
    const saved = persistDeskSession();
    if (saved) document.getElementById('egd-desk-recovery')?.remove();
    else { state.surface.recoveryAcknowledged = false; boardNotice('현재 작업을 저장하지 못했습니다. 다시 시도해 주세요.'); }
    return saved;
  }

  let deskSaveTimer = null;
  function persistDeskSession() {
    if (!SurfaceState.canPersistDeskSession(state.surface) || !document.getElementById('egd-canvas-layer')
        || (state.codex.legacyChatBackupRequired && !state.codex.legacyChatBackupKey)) return false;
    return writeSurfacePref(DESK_SESSION_PREF, serializeDeskSnapshot());
  }

  function scheduleDeskSessionSave() {
    if (!SurfaceState.canPersistDeskSession(state.surface)) return;
    if (deskSaveTimer) window.clearTimeout(deskSaveTimer);
    deskSaveTimer = window.setTimeout(() => { deskSaveTimer = null; persistDeskSession(); }, 300);
  }

  function setSurfaceMode(mode) {
    state.surface.mode = mode;
    document.documentElement.dataset.egdSurfaceMode = mode;
    document.getElementById('egd-canvas-viewport')?.setAttribute('data-presentation', mode === 'browser' ? 'hidden' : 'visible');
    if (!state.surface.recoveryProtected) writeSurfacePref(SURFACE_LIFECYCLE_PREF, { version: 1, mode, browserCardId: state.surface.browserCardId });
  }

  function enterLocalDesk() {
    const card = document.getElementById(state.surface.browserCardId);
    if (!card || !card._xulBrowser) return false;
    // Do not reparent, reload, recreate or resize the Browser target during this transition.
    setSurfaceMode('desk');
    card.dataset.testid = 'browser-card';
    card.querySelector('#egd-desk-entry')?.setAttribute('hidden', 'true');
    const camera = SurfaceState.fitSurfaceCamera(persistentEntityGeometry(card), safeViewportRect({ margin: 20 }));
    state.setCanvasViewportTarget?.(camera, { immediate: true });
    setActiveEntity(card);
    persistDeskSession();
    return true;
  }

  function restoreSurfaceEntry(lifecycle, deskSession, legacyStore) {
    state.surface.restoring = true;
    try {
      const recovery = recoveryStore().recover(rawDeskRecord(), restoreDeskSession);
      state.surface.recoveryProtected = recovery.recoveryProtected;
      state.surface.recoveryBackupKey = recovery.backupKey || deskSession?.surface?.recoveryBackupKey || null;
      state.surface.recoveryAcknowledged = recovery.backupKey ? false : !!deskSession?.surface?.recoveryAcknowledged;
      state.surface.recoveryReason = recovery.reason;
      const mode = recovery.protected ? 'desk' : SurfaceState.initialSurfaceMode({ lifecycle, deskSession, legacyStore });
      state.surface.browserCardId = deskSession?.surface?.browserCardId || lifecycle?.browserCardId || null;
      if (mode === 'browser') {
        let card = document.getElementById(state.surface.browserCardId);
        if (!card) card = spawnBrowserCard('chrome://userchrome/content/egdesk-start.html', { firstUse: true });
        // A restored first-use Browser retains its identity and fixed logical viewport.
        if (!card.querySelector('#egd-desk-entry')) {
          card.classList.add('egd-first-use-browser');
          card.dataset.testid = 'first-use-root';
          card.setAttribute('aria-label', 'EG-Desk 시작');
          const input = card.querySelector('.egd-card-url');
          input.id = 'egd-first-use-address';
          input.dataset.testid = 'first-use-address';
          card.querySelector('.egd-card-toolbar').appendChild(el('button', {
            id: 'egd-desk-entry', 'aria-label': 'Desk 시작', data: { testid: 'desk-entry' }, onclick: enterLocalDesk,
          }, 'Desk 시작'));
        }
        state.surface.browserCardId = card.id;
        setActiveEntity(card);
        window.setTimeout(() => {
          if (state.surface.mode !== 'browser') return;
          const input = card.querySelector('.egd-card-url');
          if (input.value === 'chrome://userchrome/content/egdesk-start.html') input.value = '';
          input.placeholder = '주소 또는 검색어 입력';
          input.focus();
        }, 0);
      }
      setSurfaceMode(mode);
      if (mode === 'desk') {
        const card = document.getElementById(state.surface.browserCardId);
        if (card) card.dataset.testid = 'browser-card';
      }
      renderDeskRecoveryNotice();
    } finally { state.surface.restoring = false; }
    // A single current Desk snapshot; Saved Board revisions are never updated by this path.
    const observer = new MutationObserver(scheduleDeskSessionSave);
    observer.observe(document.getElementById('egd-canvas-layer'), { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    window.addEventListener('unload', persistDeskSession, { once: true });
    persistDeskSession();
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
      const lifecycle = readSurfacePref(SURFACE_LIFECYCLE_PREF);
      const deskSession = readSurfacePref(DESK_SESSION_PREF);
      const legacyChatRecords = prepareLegacyChatBackup(deskSession, rawDeskRecord());
      const legacyStore = readSurfacePref(AGENDA_STORAGE_PREF);
      loadAgendaStoreMeta();
      paintSurface();
      hideFirefoxChrome();
      const host = document.documentElement;
      const canvasViewport = el('div', { id: 'egd-canvas-viewport' });
      const canvasLayer = el('div', { id: 'egd-canvas-layer' });
      canvasViewport.appendChild(canvasLayer);
      host.appendChild(canvasViewport);
      installCanvasPanZoom(canvasViewport, canvasLayer);
      installNativeGestureHelperBridge();
      state.codexBridge = installCodexBridge(legacyChatRecords);
      window.__egdesk = {
        state,
        codexBridge: state.codexBridge,
        cardRuntime: {
          focusCard: focusCanvasCard,
          closeCard: closeCanvasCard,
          openBrowserCard: spawnBrowserCard,
          openUrl: openUrlInBrowserCard,
          openSettingsCard: spawnSettingsCard,
          openFileCard: spawnFileCard,
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
        boards: {
          open: (boardId, options = {}) => switchAgenda(boardId, options),
          close: (projectionId, options = {}) => closeCurrentAgenda({ ...options, projectionId }),
          save: (projectionId) => saveCurrentAgendaState({ projectionId }),
          projections: () => cloneJson(state.boards),
        },
        surface: {
          enterDesk: enterLocalDesk,
          snapshot: () => ({ ...state.surface, browser: browserCardState(state.surface.browserCardId) }),
          lifecyclePref: SURFACE_LIFECYCLE_PREF,
        },
        deskSession: {
          serialize: serializeDeskSnapshot, restore: restoreDeskSession,
          persist: persistDeskSession, storagePref: DESK_SESSION_PREF,
          retryRecovery: retryDeskRecovery, continueRecovery: continueDeskRecovery,
          recoveryRecords: () => recoveryStore().list().map(({ key, savedAt, reason }) => ({ key, savedAt, reason })),
        },
      };
      host.appendChild(buildDeskRail());
      installRailSearchShortcut();
      host.appendChild(buildDock());
      host.appendChild(buildPresetBag());
      host.appendChild(buildHUD());
      restoreSurfaceEntry(lifecycle, deskSession, legacyStore);
      state.codex.localHistoryBootReady = true;
      if (state.codex.legacyChatBackupRequired && !state.codex.legacyChatBackupKey) boardNotice(state.codex.localHistoryError);
      void state.codexBridge.loadLocalHistory(legacyChatRecords);
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
