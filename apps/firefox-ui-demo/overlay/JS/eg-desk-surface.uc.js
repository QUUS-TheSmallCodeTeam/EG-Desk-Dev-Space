// ==UserScript==
// @name           EG-Desk Surface (4-Edge Framework)
// @description    Firefox chrome 을 EG-Desk Surface 로 재구성. Top Desk Rail + Bottom Dock
//                 + Left Preset Bag + Right Contextual HUD. Approved warm desktop style.
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
  const BrowserAgentReceipts = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskBrowserAgentRuntimeParent.sys.mjs');
  const BROWSER_AGENT_ACTOR_NAME = 'EGDeskBrowserAgentRuntime';
  const BROWSER_AGENT_HISTORY_LIMIT = 100;
  const EGDESK_START_URI = 'chrome://userchrome/content/egdesk-start.html';
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
          // and webCOOP+COEP family. Parent authorization resolves only a
          // chrome-registered Browser Card and its live UI lease.
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
    { id: 'chat',     label: '채팅',    icon: 'chat' },
    { id: 'shelf',    label: '파일',    icon: 'file' },
    { id: 'ontology', label: '온톨로지', icon: 'ontology' },
    { id: 'browser',  label: '브라우저', icon: 'browser' },
    { id: 'ide',      label: 'IDE',     icon: 'ide' },
    { id: 'terminal', label: '터미널',  icon: 'terminal' },
    { id: 'settings', label: '설정',   icon: 'settings' },
    { id: 'create',   label: '추가',    icon: 'plus' },
  ];
  const DOCK_CENTER = [
    { id: 'pencil',    label: '펜',     icon: 'pencil' },
    { id: 'hand',      label: '손',     icon: 'move' },
    { id: 'square',    label: '사각형', icon: 'square' },
    { id: 'ellipse',   label: '원',     icon: 'ellipse' },
    { id: 'line',      label: '선',     icon: 'line' },
    { id: 'arrow',     label: '화살표', icon: 'arrow' },
    { id: 'label',     label: '글자',   icon: 'text' },
    { id: 'highlight', label: '강조',   icon: 'highlight' },
    { id: 'select',    label: '선택',   icon: 'pointer', active: true },
  ];
  const DOCK_RIGHT = [
    { id: 'trash',    label: '휴지통', icon: 'trash' },
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
      label: 'Board',
      longLabel: 'Board Thread',
      createTitle: '새 Board Thread',
      emptyPreview: '아직 Board 메시지가 없습니다',
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
        'Preserve the high-level objective and Board context while decomposing work into scoped coding tasks.',
        'Decide whether work belongs in Agent DM, a Board Thread, a specialized agent, or a concrete implementation pass.',
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

  function codexThreadKindMeta(type) {
    return type === 'group' ? THREAD_KIND_META.group : THREAD_KIND_META.dm;
  }

  // Agent Profiles saved in the local profile store (GET /profiles). Until it
  // answers, or when the bridge has no profile store, the built-in
  // definitions above keep the previous systemPrompt path working.
  let codexProfileCatalog = { status: 'idle', profiles: [] };

  function codexServerAgentProfile(entry) {
    const legacy = Object.hasOwn(CODEX_AGENT_PROFILES, entry.id) ? CODEX_AGENT_PROFILES[entry.id] : null;
    return {
      id: entry.id, label: legacy?.label || entry.name, name: entry.name, category: legacy?.category || 'agent',
      summary: entry.role || legacy?.summary || '', capabilities: legacy?.capabilities || [],
      systemPrompt: legacy?.systemPrompt || null, toolMode: legacy?.toolMode || null,
      avatar: entry.avatar, role: entry.role, lifecycle: entry.lifecycle, origin: entry.origin,
      revision: ChatState.profileRunnable(entry) ? entry.activeRevision : null, server: true,
    };
  }

  function codexAgentProfile(profileId) {
    const placeholder = (name, server) => ({
      id: profileId, label: 'Agent', name, category: 'agent', summary: '', capabilities: [], systemPrompt: null, toolMode: null,
      avatar: null, role: '', lifecycle: server ? 'missing' : 'unknown', origin: 'user', revision: null, server,
    });
    if (codexProfileCatalog.status === 'ready' && ChatState.isProfileId(profileId)) {
      const entry = codexProfileCatalog.profiles.find((profile) => profile.id === profileId);
      // A missing or stopped Agent stays itself: the bridge refuses the send
      // rather than the room silently answering as another Agent.
      return entry ? codexServerAgentProfile(entry) : placeholder('찾을 수 없는 Agent', true);
    }
    if (Object.hasOwn(CODEX_AGENT_PROFILES, profileId)) return CODEX_AGENT_PROFILES[profileId];
    if (ChatState.isProfileId(profileId)) return placeholder('Agent', false);
    return CODEX_AGENT_PROFILES[DEFAULT_CODEX_AGENT_PROFILE_ID];
  }

  // Agent avatar: the saved emoji/initial on one of the six approved palette tones.
  function codexProfileAvatar(avatar, name, className = '') {
    const view = ChatState.profileAvatarView(avatar, name);
    return el('span', { class: `egd-profile-avatar egd-profile-avatar-tone-${view.tone}${className ? ` ${className}` : ''}`, 'aria-hidden': 'true' }, view.text);
  }

  // Chat author face: a saved emoji/initial on its palette tone, else the
  // name's first letter on the plain chat avatar colour.
  function codexMessageAvatarFace(avatar, name) {
    const view = ChatState.profileAvatarView(avatar, name);
    return { text: view.saved ? view.text : String(name || '?').slice(0, 1), toneClass: view.saved ? ` egd-profile-avatar-tone-${view.tone}` : '' };
  }

  // CHAT-07: the small profile peek an Agent answer's face or name opens
  // (view from ChatState.agentPeekView). Esc closes it; onClose returns focus.
  function codexAgentPeekPanel(view, { left = 12, top = 12, onClose, onOpenSettings, onOpenActivity } = {}) {
    const face = codexMessageAvatarFace(view.avatar, view.name);
    const row = (label, value, testid) => el('div', { class: 'egd-codex-agent-peek-row', data: { testid } }, el('dt', {}, label), el('dd', {}, value));
    const expertise = view.expertise.length > 3 ? `${view.expertise.slice(0, 3).join(' · ')} 외 ${view.expertise.length - 3}개`
      : view.expertise.length ? view.expertise.join(' · ') : view.expertiseEmpty;
    const panel = el('div', {
      class: 'egd-codex-agent-peek', role: 'dialog', 'aria-label': `${view.name} 프로필`, 'aria-busy': view.loading ? 'true' : null,
      data: { testid: 'chat-agent-peek', profileId: view.profileId || '' },
      style: { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` },
      onclick: (ev) => ev.stopPropagation(),
    },
    el('div', { class: 'egd-codex-agent-peek-head' },
      el('span', { class: `egd-codex-message-avatar egd-codex-agent-peek-avatar${face.toneClass}`, 'aria-hidden': 'true' }, face.text),
      el('div', { class: 'egd-codex-agent-peek-identity' },
        el('div', { class: 'egd-codex-agent-peek-name' }, view.name),
        el('div', { class: 'egd-codex-agent-peek-role' }, view.role))),
    el('dl', { class: 'egd-codex-agent-peek-list' },
      row('말투', view.tone, 'chat-agent-peek-tone'),
      row('맡길 일', expertise, 'chat-agent-peek-expertise'),
      row('모델', view.model, 'chat-agent-peek-model'),
      row('쓸 수 있는 도구', view.tools, 'chat-agent-peek-tools'),
      row('이 대화 Board', view.board, 'chat-agent-peek-board')),
    view.note ? el('p', { class: 'egd-codex-agent-peek-note' }, view.note) : null,
    el('div', { class: 'egd-codex-agent-peek-actions' },
      el('button', { class: 'egd-codex-chip', type: 'button', data: { testid: 'chat-agent-peek-settings', focusKey: 'agent-peek-settings' },
        onclick: () => onOpenSettings?.() }, 'Agent 설정 열기'),
      el('button', { class: 'egd-codex-chip egd-codex-chip-subtle', type: 'button', data: { testid: 'chat-agent-peek-activity', focusKey: 'agent-peek-activity' },
        onclick: () => onOpenActivity?.() }, '활동 기록 보기')));
    panel.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      onClose?.();
    });
    return panel;
  }

  // AGENT-05: '[···] Agent 작업 중' beside the Agent's face at the end of the
  // conversation (view from ChatState.agentWorkingView). Pressing it opens the
  // activity record; it never shows thought text.
  function codexAgentWorkingRow(working, { runId = '', name = 'Codex', avatar = null, onOpen } = {}) {
    const face = codexMessageAvatarFace(avatar, name);
    return el('div', { class: 'egd-codex-working-row', data: { testid: 'chat-agent-working', runId, state: working.state } },
      el('span', { class: `egd-codex-message-avatar${face.toneClass}`, 'aria-hidden': 'true' }, face.text),
      el('button', {
        class: 'egd-codex-working-bubble', type: 'button', title: '활동 기록 열기',
        'aria-label': `${name} · ${working.text} · 활동 기록 열기`,
        data: { testid: 'chat-agent-working-open', focusKey: `agent-working-${runId}` },
        onclick: (ev) => { ev.stopPropagation(); onOpen?.(); },
      },
      el('span', { class: 'egd-codex-typing-dots', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
      el('span', { class: 'egd-codex-working-text' }, working.text)));
  }

  // ChatGPT usage in the resource-monitor ring shape. Nothing reported shows a
  // grey '확인 안 됨', never an invented 0%; the reset time is in the title.
  function codexUsageRing(auth, className = '') {
    const view = ChatState.usageRingView(auth);
    if (!view) return null;
    return el('span', {
      class: `egd-usage-meter egd-usage-${view.level}${view.stale ? ' egd-usage-stale' : ''}${className ? ` ${className}` : ''}`,
      role: 'img', 'aria-label': view.label, title: view.title, data: { testid: 'chat-usage-ring', level: view.level },
    }, el('span', {
      class: 'egd-usage-ring', 'aria-hidden': 'true',
      style: view.percent === null ? null : `--egd-usage-fill: ${view.percent}%`,
    }), el('span', { class: 'egd-usage-text', 'aria-hidden': 'true' }, view.text));
  }

  function codexAgentProfileChoices() {
    return codexProfileCatalog.status === 'ready'
      ? codexProfileCatalog.profiles.filter(ChatState.profileRunnable).map(codexServerAgentProfile)
      : CODEX_AGENT_PROFILE_DEFS;
  }

  function normalizeCodexAgentProfileId(profileId, fallbackProfileId = DEFAULT_CODEX_AGENT_PROFILE_ID) {
    // Saved Agents keep their ID even before the catalog has loaded.
    if (Object.hasOwn(CODEX_AGENT_PROFILES, profileId) || ChatState.isProfileId(profileId)) return profileId;
    if (Object.hasOwn(CODEX_AGENT_PROFILES, fallbackProfileId) || ChatState.isProfileId(fallbackProfileId)) return fallbackProfileId;
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
      // The room's engine pick and per-turn model/effort; the send path resolves an unset engine.
      ...(thread?.engineId ? { engineId: thread.engineId } : {}),
      ...(thread?.model ? { model: thread.model } : {}),
      ...(thread?.effort ? { effort: thread.effort } : {}),
      // Stored Agents run from their saved revision; the bridge composes the instructions.
      ...(profile.server === true ? { profileId: profile.id, ...(Number.isSafeInteger(profile.revision) ? { profileRevision: profile.revision } : {}) } : {}),
    };
  }

  function codexThreadKindLabel(type) {
    return codexThreadKindMeta(type).label;
  }

  function codexThreadLongLabel(type) {
    return codexThreadKindMeta(type).longLabel;
  }

  // The key names the badge style; the label is the word shown. A one-time or
  // branched room (CHAT-09) says so before its connection state.
  function codexThreadSessionKey(thread) {
    const kind = ChatState.chatSessionKind(thread);
    if (kind) return kind;
    if (ChatState.nativeBindingHeld(thread)) return 'local';
    return thread?.conversationId ? 'resumed' : 'fresh';
  }

  function codexThreadSessionLabel(thread) {
    return { stateless: '일회성', forked: '분기됨', local: '로컬 기록', resumed: '이어진 대화', fresh: '새 대화' }[codexThreadSessionKey(thread)];
  }

  // Room list and header badge. A branched room's badge opens the room it came from.
  function buildCodexSessionBadge(thread, codexBridge) {
    const className = `egd-codex-session-badge egd-codex-session-badge-${codexThreadSessionKey(thread)}`;
    const label = codexThreadSessionLabel(thread);
    const data = { testid: 'chat-session-badge', session: codexThreadSessionKey(thread) };
    if (data.session !== 'forked') return el('span', { class: className, data }, label);
    return el('button', {
      class: `${className} egd-codex-session-badge-link`, type: 'button', data,
      title: '원본 대화 열기', 'aria-label': `${label} · 원본 대화 열기`,
      onclick: (ev) => { ev.stopPropagation(); codexBridge.openForkSource(thread.id); },
    }, label);
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
      return `Board Thread · 멤버 ${count}명`;
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
    surface: { mode: 'desk', browserCardId: null, initialBrowserFocus: false, restoring: false },
    boards: { projections: {}, activeProjectionId: null },
    activeTool: 'select',
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
      // Bridge reconnect state for the connection notice: failed reconnects in a
      // row, the last raw transport error (shown only under '자세히'), and the
      // /v1/state `bridge` build fields when the bridge reports them.
      bridgeFailures: 0,
      bridgeError: null,
      bridgeBuild: null,
      showBridgeDetails: false,
      showDiagnostics: false,
      chatProtocol: ChatState.createChatProtocolState(),
      // /v1/state engines[] and engineConfiguration (null on older bridges);
      // a new room starts on the engine last used anywhere in the app (D4).
      engines: null,
      engineConfiguration: null,
      recentEngineId: ChatState.DEFAULT_CHAT_ENGINE_ID,
      engineMenu: null,
      // CHAT-07: the open profile peek { threadId, messageId, left, top, returnFocusKey }.
      agentPeek: null,
      // /v1/state capabilities.chat ('stateless', 'fork') and inheritedMcp;
      // null until a bridge reports them (older bridges never do).
      chatCapabilities: null,
      inheritedMcp: null,
      messageMenu: null,
      localHistoryStatus: 'idle',
      localHistoryError: null,
      localHistoryBootReady: false,
      legacyChatBackupKey: null,
      legacyChatBackupRequired: false,
      activityThreadId: null,
      // CHAT-06 Await: task graphs seen on this screen (never saved), whether
      // the list is open, and the one '계속' being confirmed or sent; the one
      // approval decision and the resume on their way; the plans Agents proposed.
      taskBoard: ChatState.createTaskBoard(),
      taskBoardOpen: false,
      taskContinue: null,
      taskApproval: null,
      taskResume: null,
      planProposals: ChatState.createPlanProposals(),
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
    // A plan step resumed in place reads as its system line, not as 대표님's words.
    const resumed = ChatState.awaitResumeMessageView(lastMessage);
    if (resumed) return resumed.line.slice(0, 70);
    const prefix = lastMessage.role === 'user' ? '나: ' : '';
    return `${prefix}${lastMessage.content}`.slice(0, 70);
  }

  // What a screen reader says for a room row: its name, unread count and last line.
  function codexThreadRowLabel(thread) {
    const unread = thread.unreadCount > 0 ? `안 읽은 메시지 ${thread.unreadCount}개` : null;
    return [thread.title, unread, stripMarkdown(codexThreadPreview(thread))].filter(Boolean).join(' · ');
  }

  // A room row is a div that holds its own menu button, so it takes the button
  // role and its keys here. Keys aimed at that menu button stay with it.
  function bindChatRoomRowKeys(row, activate) {
    row.addEventListener('keydown', (ev) => {
      if (ev.target !== row || ev.isComposing || ev.altKey || ev.ctrlKey || ev.metaKey) return;
      if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
      ev.preventDefault();
      activate();
    });
  }

  // Chat rebuilds its DOM on every change. Like the activity panel, a control
  // with a focus key gets keyboard focus and caret back after the rebuild.
  function chatFocusSnapshot(root, active) {
    const key = active && root?.contains(active) ? active.dataset?.focusKey : null;
    if (!key) return null;
    return { key, start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      end: active.selectionEnd, direction: active.selectionDirection || 'none' };
  }

  function restoreChatFocus(root, snapshot) {
    if (!root || !snapshot) return false;
    const target = [...root.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === snapshot.key);
    if (!target || target.disabled) return false;
    target.focus({ preventScroll: true });
    if (snapshot.start !== null) try { target.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction); } catch {}
    return true;
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

  // `opener` is the Chat card whose artifact was pressed; a new Browser keeps
  // it in sight when the camera follows (revealPlacedCanvasCard).
  function openChatFileReference(reference, options = {}) {
    const path = reference?.target?.path;
    if (reference?.type !== 'file' || typeof path !== 'string' || !path.startsWith('/')) return false;
    const file = railSearchNsFileFromPath(path);
    try {
      if (!file?.exists?.()) throw new Error('missing');
    } catch { boardNotice('참조된 파일을 열 수 없습니다. 경로와 접근 권한을 확인해 주세요.'); return false; }
    const card = spawnBrowserCard(railSearchPathToFileUrl(path), { openMode: 'focus-existing', opener: options.opener || null });
    focusCanvasCard(card);
    return card;
  }

  function openCodexResultLink(link, options = {}) {
    if (!ChatState.usableArtifact(link)) return false;
    return openChatFileReference(link, options);
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
      onclick: ev => {
        ev.preventDefault(); ev.stopPropagation();
        openCodexResultLink(artifact, { opener: ev.currentTarget?.closest?.('.egd-chat-card') || null });
      },
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
    if (run.status === 'interrupted') return '중지됨';
    if (run.status === 'completed') return '완료';
    const stopping = run.stopPending || run.stopRequested || run.status === 'stopping';
    // RUNTIME_LOST is reduced to failed, but does not prove native termination.
    if (run.error?.code === 'RUNTIME_LOST') return '연결 끊김 · 실행 상태 확인 필요';
    if (run.status === 'unavailable') return '실행 상태 확인 필요';
    if (run.status === 'failed') return '실행 실패';
    if (ChatState.isRunBusy(run)) {
      if (run.stopUnconfirmed || (stopping && !state.codex.connected)) return '중지 확인 필요';
      if (!state.codex.connected) return '연결 끊김 · 실행 상태 확인 필요';
      if (stopping) return '중지 요청 중';
    }
    if (run.pendingApprovals?.length) return '승인 대기';
    if (ChatState.pendingUserInputCount(run)) return '답변 대기';
    return '응답 중';
  }

  function codexActivityButtonLabel(run) {
    const approvals = run?.pendingApprovals?.length || 0;
    const questions = ChatState.pendingUserInputCount(run);
    const blocked = ChatState.subAgentSummary(run).blocked;
    return ['활동 기록', approvals ? `승인 ${approvals}건` : '', questions ? `질문 ${questions}건` : '', blocked ? `막힘 ${blocked}건` : ''].filter(Boolean).join(' · ');
  }

  function openCodexActivityPanel(threadId) {
    state.codex.activityThreadId = threadId;
    renderCodexActivityPanel();
  }

  // A file condition names its folder as the File card that connected it does.
  function connectedFolderName(rootId) {
    for (const card of document.querySelectorAll('.egd-file-card')) {
      const root = card._fileRecord?.root;
      if (root?.rootId === rootId && root.name) return root.name;
    }
    return null;
  }

  // CHAT-06 Await: one quiet line under the run state, '진행 N건 · 대기 M건',
  // opens the task list in place: each task's name and state, then what it waits
  // for in order, with a check and the time once met. An outside condition offers
  // '계속', confirmed before anything is sent. Nothing shows while no graph is here.
  function renderChatTaskBoard(codex, actions, folderName) {
    const view = ChatState.taskBoardView(codex.taskBoard, { folderName, continuing: codex.taskContinue,
      approving: codex.taskApproval, resuming: codex.taskResume });
    if (!view.visible) return null;
    const open = codex.taskBoardOpen === true;
    const summary = el('button', {
      class: 'egd-task-board-summary', 'aria-expanded': String(open), 'aria-controls': open ? 'egd-task-board-list' : null,
      title: open ? '작업 목록 접기' : '작업 목록 열기',
      data: { testid: 'chat-task-summary', focusKey: 'chat-task-summary' },
      onclick: () => actions.toggleTaskBoard(),
    }, el('span', { class: 'egd-task-board-summary-text' }, view.summary), deskIcon('chevron', 'egd-task-board-chevron'));
    // A bridge restart holds started work until 대표님 says to go on; reconnecting never does.
    const resuming = view.held?.phase === 'sending';
    const hold = view.held ? el('div', { class: 'egd-task-hold', role: 'group', 'aria-label': '멈춘 작업', data: { testid: 'chat-task-hold' } },
      el('span', { class: 'egd-task-hold-text' }, view.held.text),
      el('button', {
        class: 'egd-task-hold-resume', 'aria-disabled': resuming ? 'true' : null,
        data: { testid: 'chat-task-resume', focusKey: 'chat-task-resume' },
        onclick: () => { if (!resuming) actions.resumeHeldTasks(); },
      }, resuming ? '이어 가는 중…' : '이어서 진행'),
      view.held.error ? el('p', { class: 'egd-task-error', role: 'alert', data: { testid: 'chat-task-resume-error' } }, view.held.error) : null) : null;
    const board = (...children) => el('div', { class: 'egd-task-board', role: 'group', 'aria-label': '작업 목록',
      data: { testid: 'chat-task-board', open: String(open) } }, hold, summary, ...children);
    if (!open) return board();
    const conditionRow = (group, task, condition) => {
      // The confirm buttons share the '계속' focus key, so the keyboard stays on the same condition.
      const key = `chat-task-gate:${group.graphId}:${task.taskId}:${condition.gateId}`;
      const sending = condition.phase === 'sending';
      const confirming = condition.continuable && (condition.phase === 'confirm' || sending);
      // An approval the task asked for: 대표님 decides here, nothing approves by itself.
      const deciding = condition.approvalPhase === 'sending';
      const decisionButton = (decision, label, busyLabel) => el('button', {
        class: decision === 'approved' ? 'egd-task-approve' : 'egd-task-reject', 'aria-disabled': deciding ? 'true' : null,
        'aria-label': `${task.name} ${label}`, data: { testid: decision === 'approved' ? 'chat-task-approve' : 'chat-task-reject', focusKey: `${key}:${decision}` },
        onclick: () => { if (!deciding) actions.decideTaskApproval(group.graphId, task.taskId, decision); },
      }, deciding && condition.approvalDecision === decision ? busyLabel : label);
      return el('li', { class: 'egd-task-condition', data: { testid: 'chat-task-condition', state: condition.state } },
        condition.state === 'satisfied' ? deskIcon('check', 'egd-task-condition-mark') : el('span', { class: 'egd-task-condition-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'egd-task-condition-text' }, condition.text),
        condition.time ? el('span', { class: 'egd-task-condition-time' }, condition.time) : null,
        condition.continuable && !confirming ? el('button', {
          class: 'egd-task-continue', 'aria-label': `${condition.text}, 기다리지 않고 계속`,
          data: { testid: 'chat-task-continue', focusKey: key },
          onclick: () => actions.askTaskContinue(group.graphId, task.taskId, condition.gateId),
        }, '계속') : null,
        confirming ? el('div', { class: 'egd-task-confirm', role: 'group', 'aria-label': '계속 확인', data: { testid: 'chat-task-confirm' } },
          el('span', {}, '조건을 기다리지 않고 진행합니다.'),
          el('button', {
            class: 'egd-task-confirm-go', 'aria-disabled': sending ? 'true' : null, data: { testid: 'chat-task-confirm-go', focusKey: key },
            onclick: () => { if (!sending) actions.continueTaskGate(group.graphId, task.taskId, condition.gateId); },
          }, sending ? '진행 중…' : '진행'),
          sending ? null : el('button', {
            class: 'egd-task-confirm-cancel', data: { testid: 'chat-task-confirm-cancel', focusKey: key },
            onclick: () => actions.cancelTaskContinue(),
          }, '취소')) : null,
        condition.approvable ? el('div', { class: 'egd-task-approval', role: 'group', 'aria-label': `${task.name} 승인 여부`, data: { testid: 'chat-task-approval' } },
          decisionButton('approved', '승인', '승인하는 중…'), decisionButton('rejected', '거절', '거절하는 중…')) : null,
        condition.error ? el('p', { class: 'egd-task-error', role: 'alert', data: { testid: 'chat-task-error' } }, condition.error) : null);
    };
    return board(el('div', { id: 'egd-task-board-list', class: 'egd-task-board-list', data: { testid: 'chat-task-list' } },
      ...view.groups.map(group => el('section', { class: 'egd-task-group', 'aria-label': group.title || '작업' },
        group.title ? el('p', { class: 'egd-task-group-title' }, group.title) : null,
        ...group.tasks.map(task => el('article', { class: 'egd-task-row', data: { testid: 'chat-task-row', status: task.status || 'unknown' } },
          el('div', { class: 'egd-task-row-head' },
            el('strong', { class: 'egd-task-name' }, task.name),
            el('span', { class: 'egd-task-status' }, task.statusText)),
          task.conditions.length ? el('ul', { class: 'egd-task-conditions', 'aria-label': `${task.name} 대기 조건` },
            ...task.conditions.map(condition => conditionRow(group, task, condition))) : null))))));
  }

  // CHAT-06 Await: an Agent's plan waits under the answer that proposed it. Its
  // steps read in order with what each waits for, and each step's instructions
  // open in place. '승인하고 시작' asks once before anything runs; '거절' sends
  // at once. Once decided the card says so, and the task list carries the work.
  function renderChatPlanCard(entry, actions, folderName) {
    const view = ChatState.planProposalView(entry, { folderName });
    if (!view) return null;
    const key = part => `chat-plan:${view.planId}:${part}`;
    const decision = view.decision;
    const confirming = view.decidable && decision?.action === 'approve' && (decision.phase === 'confirm' || view.sending);
    const stepRow = step => el('li', { class: 'egd-plan-step', data: { testid: 'chat-plan-step' } },
      el('div', { class: 'egd-plan-step-head' },
        el('span', { class: 'egd-plan-step-number', 'aria-hidden': 'true' }, String(step.number)),
        el('strong', { class: 'egd-plan-step-title' }, step.title),
        el('button', {
          class: 'egd-plan-step-toggle', 'aria-expanded': String(step.open), 'aria-label': `${step.number}단계 ${step.title} 지침 ${step.open ? '접기' : '보기'}`,
          data: { testid: 'chat-plan-step-toggle', focusKey: key(`step:${step.taskId}`) },
          onclick: () => actions.togglePlanStep(view.planId, step.taskId),
        }, step.open ? '지침 접기' : '지침 보기')),
      step.after ? el('p', { class: 'egd-plan-step-meta' }, step.after) : null,
      ...step.waits.map(wait => el('p', { class: 'egd-plan-step-meta egd-plan-step-wait' }, wait)),
      step.where ? el('p', { class: 'egd-plan-step-meta' }, step.where) : null,
      step.instructions ? el('div', { class: 'egd-plan-step-instructions', data: { testid: 'chat-plan-instructions', state: step.instructions.state } },
        el('p', {}, step.instructions.text),
        step.instructions.state === 'error' ? el('button', {
          class: 'egd-plan-step-toggle', data: { testid: 'chat-plan-instructions-retry', focusKey: key(`retry:${step.taskId}`) },
          onclick: () => actions.retryPlanDetail(view.planId),
        }, '다시 불러오기') : null) : null);
    const decide = view.decidable && !confirming ? el('div', { class: 'egd-plan-actions', data: { testid: 'chat-plan-actions' } },
      el('button', {
        class: 'egd-plan-approve', 'aria-disabled': view.sending ? 'true' : null, data: { testid: 'chat-plan-approve', focusKey: key('approve') },
        onclick: () => { if (!view.sending) actions.askPlanApprove(view.planId); },
      }, '승인하고 시작'),
      el('button', {
        class: 'egd-plan-reject', 'aria-disabled': view.sending ? 'true' : null, data: { testid: 'chat-plan-reject', focusKey: key('reject') },
        onclick: () => { if (!view.sending) actions.decidePlan(view.planId, 'reject'); },
      }, view.sending && decision?.action === 'reject' ? '거절하는 중…' : '거절')) : null;
    // The confirm buttons share the first button's focus key, so the keyboard stays put.
    const confirm = confirming ? el('div', { class: 'egd-plan-confirm', role: 'group', 'aria-label': '계획 승인 확인', data: { testid: 'chat-plan-confirm' } },
      el('span', {}, '승인하면 단계가 조건대로 저절로 진행됩니다.'),
      el('button', {
        class: 'egd-plan-confirm-go', 'aria-disabled': view.sending ? 'true' : null, data: { testid: 'chat-plan-confirm-go', focusKey: key('approve') },
        onclick: () => { if (!view.sending) actions.decidePlan(view.planId, 'approve'); },
      }, view.sending ? '승인하는 중…' : '승인'),
      view.sending ? null : el('button', {
        class: 'egd-plan-confirm-cancel', data: { testid: 'chat-plan-confirm-cancel', focusKey: key('approve') },
        onclick: () => actions.cancelPlanDecision(view.planId),
      }, '취소')) : null;
    return el('section', { class: 'egd-plan-card', role: 'group', 'aria-label': `계획 제안 · ${view.title}`,
      data: { testid: 'chat-plan-card', status: view.status } },
    el('div', { class: 'egd-plan-card-head' },
      el('span', { class: 'egd-plan-card-eyebrow' }, '계획 제안'),
      el('span', { class: 'egd-plan-card-status', data: { testid: 'chat-plan-status' } }, view.statusText)),
    el('strong', { class: 'egd-plan-card-title' }, view.title),
    view.steps.length ? el('ol', { class: 'egd-plan-steps', 'aria-label': `${view.title} 단계` }, ...view.steps.map(stepRow)) : null,
    view.note ? el('p', { class: 'egd-plan-card-note' }, view.note) : null,
    decide, confirm,
    decision?.phase === 'error' && decision.error ? el('p', { class: 'egd-plan-error', role: 'alert', data: { testid: 'chat-plan-error' } }, decision.error) : null,
    view.showTaskList ? el('button', {
      class: 'egd-plan-open-list', data: { testid: 'chat-plan-open-list', focusKey: key('list') },
      onclick: () => actions.openTaskBoard(),
    }, '작업 목록 보기') : null);
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
      let browserToolIdentity = null;
      try {
        const binding = view._browserControls?.toolBinding?.();
        if (binding) browserToolIdentity = {
          cardEpoch: binding.cardEpoch, userContextId: binding.userContextId,
          engineAccountKey: binding.engineAccountKey, authorityEpoch: binding.authorityEpoch,
        };
      } catch {}
      return { ...base, kind: 'browser', browserToolPermission: 'observe', browserToolIdentity,
        sourceRef: { ...base.sourceRef, uri: browser.uri,
          profileId: view._sourceRef?.profileId || state.sourceRefs.defaultProfileId,
          accountId: view._sourceRef?.accountId || '' } };
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
        const existingPermission = thread.inputSources?.find(item => item.kind === 'browser' &&
          item.sourceRef?.viewId === source.sourceRef.viewId)?.browserToolPermission;
        const input = el('input', { type: 'checkbox', 'aria-label': `첨부 선택: ${source.label}`, data: { testid: 'chat-attach-source', viewId: source.sourceRef.viewId } });
        input.checked = checked;
        if (checked) picked.set(source.id, source);
        input.addEventListener('change', () => input.checked ? picked.set(source.id, source) : picked.delete(source.id));
        body.appendChild(el('label', { class: 'egd-input-source-choice' }, input,
          el('span', {}, source.label,
            existingPermission === 'interact' ? el('small', {}, '이번 Chat 조작 허용 중') : null,
            el('small', {}, InputContext.inputSourceLocation(source)))));
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
        const additions = [];
        for (const source of picked.values()) {
          if (source.kind !== 'browser') { additions.push(source); continue; }
          const existing = getCodexThreadById(state.codex, threadId)?.inputSources?.find(item =>
            item.kind === 'browser' && item.sourceRef?.viewId === source.sourceRef.viewId);
          if (existing) state.codexBridge.removeInputSource(threadId, existing.id);
          const selectedSource = registerBrowserToolSelection(threadId, source, 'observe');
          additions.push(selectedSource || { ...source, selectedByUser: true, browserToolPermission: 'observe' });
        }
        state.codexBridge.addInputSources(threadId, additions); close();
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
          } }, `${source.label}${source.kind === 'browser' && source.browserToolPermission === 'interact' ? ' · 이번 Chat 조작 허용' : ''} · 미전송`),
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
    state.setCanvasViewportTarget?.(camera);
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
    const placement = resolveCanvasCardPlacement('input-evidence');
    const shell = spawnDeskWindowShell({ id: `egd-input-evidence-${++cardSeq}`, kind: 'input-evidence', className: 'egd-input-evidence-card',
      sourceRef: { kind: 'context-snapshot', id: reference.sourceId, scope: 'immutable-input' },
      style: { left: `${placement.x}px`, top: `${placement.y}px`, width: `${placement.width}px`, height: `${placement.height}px` } });
    if (!options.restore) revealPlacedCanvasCard(shell.root, placement);
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

  // Agent question drafts live only in this closure: never state.codex, thread
  // drafts, Desk storage, DOM attributes or logs (secret answers included).
  const userInputDrafts = new Map();
  let activityPanelComposing = false;
  let activityPanelDeferred = false;
  const userInputDraftKey = (run, userInputId) => `${run.conversationId}/${run.runId}/${userInputId}`;

  function pruneUserInputDrafts() {
    if (!userInputDrafts.size) return;
    const live = new Set();
    for (const run of Object.values(state.codex.chatProtocol.runs)) {
      for (const input of run.pendingUserInputs || []) {
        if (input.status === 'pending' && !input.stale) live.add(userInputDraftKey(run, input.userInputId));
      }
    }
    for (const key of [...userInputDrafts.keys()]) if (!live.has(key)) userInputDrafts.delete(key);
  }

  // Agent question card. Controls mirror `draft`; values are set as properties,
  // so a secret answer never becomes a value/data/aria attribute.
  function codexUserInputBlock(run, input, draft, actions) {
    const userInputId = input.userInputId;
    const sent = input.status === 'replySent';
    const locked = sent || input.status !== 'pending' || !!input.replyPending || !!input.stale
      || run.localHistory === true || !ChatState.isRunBusy(run);
    const answers = (input.questions || []).map(question => {
      const saved = Array.isArray(draft) ? draft.find(entry => entry?.questionId === question.questionId) : null;
      return { questionId: question.questionId, choice: saved?.choice ?? null, text: typeof saved?.text === 'string' ? saved.text : '' };
    });
    const focusKey = (index, part) => `${userInputId}\n${index}\n${part}`;
    const otherFields = [];
    const submit = el('button', { type: 'button', 'aria-label': 'Agent 질문에 답변 보내기',
      data: { testid: 'chat-user-input-submit', focusKey: focusKey(-1, 'submit') },
      onclick: () => { if (!locked && ChatState.userInputRequestFor(run, userInputId, answers)) actions.submit(answers); } }, '답변 보내기');
    const sync = () => {
      for (const { field, answer } of otherFields) field.disabled = locked || answer.choice !== 'other';
      submit.disabled = locked || !ChatState.userInputRequestFor(run, userInputId, answers);
    };
    const changed = () => { if (locked) return; actions.draft(answers); sync(); };
    const textField = (question, answer, testid, part, label) => {
      const field = el('input', { type: question.isSecret ? 'password' : 'text', 'aria-label': label,
        autocomplete: question.isSecret ? 'off' : null, spellcheck: question.isSecret ? 'false' : null,
        maxlength: '4000', data: { testid, focusKey: focusKey(answers.indexOf(answer), part) },
        oninput: ev => { answer.text = ev.target.value; changed(); },
        onkeydown: ev => {
          if (ev.key !== 'Enter' || !(ev.metaKey || ev.ctrlKey) || ev.shiftKey || ev.altKey) return;
          if (ev.isComposing || ev.keyCode === 229) return;
          ev.preventDefault();
          if (!submit.disabled) actions.submit(answers);
        } });
      field.value = answer.text;
      field.disabled = locked;
      return field;
    };
    const block = el('section', { class: 'egd-codex-user-input', 'aria-label': 'Agent 질문',
      data: { testid: 'chat-user-input', userInputId, runId: run.runId, status: input.status } },
    el('strong', {}, sent ? '답변 전달됨 · 작업 상태 확인 중' : 'Agent 질문'),
    input.isBlocking && !sent ? el('p', { class: 'egd-codex-user-input-blocking' }, '답변할 때까지 작업이 멈춰 있습니다.') : null);
    (input.questions || []).forEach((question, index) => {
      const answer = answers[index];
      const set = el('fieldset', { class: 'egd-codex-user-input-question', data: { questionId: question.questionId } },
        el('legend', {}, question.header || `질문 ${index + 1}`),
        el('p', {}, question.question));
      if (sent && question.isSecret) {
        set.appendChild(el('p', { class: 'egd-codex-user-input-note' }, '비공개 답변 전달됨'));
      } else if (question.options) {
        const radio = (value, part, text, description) => {
          const control = el('input', { type: 'radio', name: `egd-user-input:${userInputId}:${index}`,
            data: { testid: 'chat-user-input-option', questionId: question.questionId, optionIndex: String(value), focusKey: focusKey(index, part) },
            onchange: ev => { if (ev.target.checked) { answer.choice = value; changed(); } } });
          control.checked = answer.choice === value;
          control.disabled = locked;
          return el('label', { class: 'egd-input-source-choice' }, control,
            el('span', {}, text, description ? el('small', {}, description) : null));
        };
        question.options.forEach((option, optionIndex) => set.appendChild(radio(optionIndex, `option-${optionIndex}`, option.label, option.description)));
        if (question.allowsOther) {
          set.appendChild(radio('other', 'other-choice', '기타(직접 입력)', null));
          const field = textField(question, answer, 'chat-user-input-other', 'other', '기타 답변 직접 입력');
          otherFields.push({ field, answer });
          set.appendChild(field);
        }
      } else {
        set.appendChild(textField(question, answer, 'chat-user-input-text', 'text', question.isSecret ? '비공개 답변 입력' : '답변 입력'));
      }
      block.appendChild(set);
    });
    const skip = el('button', { type: 'button', 'aria-label': 'Agent 질문 건너뛰기',
      data: { testid: 'chat-user-input-skip', focusKey: focusKey(-1, 'skip') },
      onclick: () => { if (!locked) actions.skip(); } }, '건너뛰기');
    skip.disabled = locked;
    sync();
    block.appendChild(el('div', { class: 'egd-codex-user-input-actions' }, submit, skip));
    if (input.error) block.appendChild(el('p', { class: 'egd-codex-user-input-error' }, input.error));
    return block;
  }

  // Sub-agent rows stay quietly inside the activity record: no alert role and
  // no new panel; the delegated prompt is only the helper's short preview.
  function codexSubAgentSection(run) {
    const summary = ChatState.subAgentSummary(run);
    if (!summary.total) return null;
    return el('section', { class: 'egd-codex-subagents', 'aria-label': '하위 Agent', data: { testid: 'chat-subagents', runId: run.runId } },
      el('strong', {}, `하위 Agent · ${summary.total}${summary.blocked ? ` · 막힘 ${summary.blocked}` : ''}`),
      el('ul', {}, ...summary.rows.map(({ row, display }) => el('li', {
        class: 'egd-codex-subagent-row', data: { testid: 'chat-subagent', agentThreadId: row.threadId, status: display.status },
      }, el('span', { class: `egd-codex-subagent-dot egd-codex-subagent-dot-${display.status}`, 'aria-hidden': 'true' }),
      el('span', { class: 'egd-codex-subagent-name' }, display.name),
      el('span', { class: 'egd-codex-subagent-status' }, display.stateLabel),
      row.taskPreview ? el('small', { class: 'egd-codex-subagent-task' }, row.taskPreview) : null,
      display.blockedLabel ? el('p', { class: 'egd-codex-subagent-blocked' }, display.blockedLabel) : null,
      row.message ? el('p', { class: 'egd-codex-subagent-message' }, row.message) : null))));
  }

  function renderCodexActivityPanel() {
    pruneUserInputDrafts();
    const thread = getCodexThreadById(state.codex, state.codex.activityThreadId);
    let panel = document.getElementById('egd-codex-activity-panel');
    if (!thread) { activityPanelComposing = false; activityPanelDeferred = false; panel?.remove(); return; }
    // An SSE re-render must not cut IME composition in an Agent answer.
    if (activityPanelComposing && panel?.contains(document.activeElement)) { activityPanelDeferred = true; return; }
    activityPanelComposing = false;
    activityPanelDeferred = false;
    if (!panel) {
      panel = el('section', { id: 'egd-codex-activity-panel', role: 'region', 'aria-label': '활동 기록', data: { testid: 'chat-activity-panel' } });
      panel.addEventListener('mousedown', ev => ev.stopPropagation());
      panel.addEventListener('compositionstart', () => { activityPanelComposing = true; });
      panel.addEventListener('compositionend', () => {
        activityPanelComposing = false;
        if (!activityPanelDeferred) return;
        activityPanelDeferred = false;
        queueMicrotask(renderCodexActivityPanel);
      });
      document.documentElement.appendChild(panel);
    }
    panel.dataset.threadId = thread.id;
    const oldBody = panel.querySelector('.egd-codex-activity-body');
    const scrollTop = oldBody?.scrollTop || 0;
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const focusState = focused?.dataset?.focusKey ? { key: focused.dataset.focusKey,
      start: typeof focused.selectionStart === 'number' ? focused.selectionStart : null,
      end: focused.selectionEnd, direction: focused.selectionDirection || 'none' } : null;
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
      // AGENT-04: the ceiling this run was started under, named under its head.
      const ceilingLine = ChatState.toolCeilingRunLine(run);
      if (ceilingLine) rows.push(el('p', { class: 'egd-codex-run-ceiling', data: { testid: 'chat-run-tool-ceiling', runId: run.runId } }, ceilingLine));
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
      const subAgents = codexSubAgentSection(run);
      if (subAgents) rows.push(subAgents);
      for (const activity of run.activities || []) {
        // Agent-to-agent records are shown only as the sub-agent rows above.
        if (activity.kind === 'collabAgentToolCall' || activity.kind === 'subAgentActivity') continue;
        // AGENT-04: a refusal or notice from the Agent's tool ceiling, in words.
        const ceiling = ChatState.toolCeilingActivityView(activity);
        const row = el('article', { class: `egd-codex-activity-row${ceiling ? ' egd-codex-activity-row-ceiling' : ''}`,
          data: { activityId: activity.id, status: activity.status, ...(ceiling ? { kind: 'toolCeiling' } : {}) } },
          el('strong', {}, activity.title || (ceiling ? '도구 제한' : activity.kind) || '활동'),
          el('span', {}, ceiling ? ceiling.statusLabel : ({ inProgress: '진행 중', completed: '완료', failed: '실패', declined: '거절됨' })[activity.status] || activity.status || ''),
          typeof activity.detail === 'string' ? el('pre', {}, activity.detail) : null);
        if (ceiling) {
          if (ceiling.command) row.appendChild(el('pre', {}, ceiling.command));
          for (const note of ceiling.notes) row.appendChild(el('p', { class: 'egd-codex-activity-note', data: { testid: 'chat-ceiling-note' } }, note));
        } else if (activity.detail && typeof activity.detail === 'object') {
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
      for (const input of run.pendingUserInputs || []) {
        const draftKey = userInputDraftKey(run, input.userInputId);
        const reply = action => draft => state.codexBridge.replyUserInput({ userInputId: input.userInputId,
          conversationId: run.conversationId, runId: run.runId, action, draft });
        rows.push(codexUserInputBlock(run, input, userInputDrafts.get(draftKey), {
          draft: answers => { if (input.status === 'pending' && !input.stale) userInputDrafts.set(draftKey, answers.map(entry => ({ ...entry }))); },
          submit: reply('submit'), skip: () => reply('skip')(),
        }));
      }
      if (run.error) rows.push(el('p', { class: 'egd-codex-error' }, ChatState.runErrorNotice(run.error, state.codex.authStatus?.usage).text));
    }
    if (!rows.length) rows.push(el('p', {}, '기록된 활동이 없습니다.'));
    const body = el('div', { class: 'egd-codex-activity-body' }, ...rows);
    panel.replaceChildren(el('header', {}, el('strong', {}, '활동 기록'), el('button', {
      'aria-label': '활동 상태 다시 확인', onclick: () => state.codexBridge.refreshConversation(thread.id),
    }, '새로고침'), el('button', {
      'aria-label': '활동 기록 닫기', onclick: () => {
        state.codex.activityThreadId = null; activityPanelComposing = false; activityPanelDeferred = false; panel.remove();
      },
    }, '닫기')), body);
    body.scrollTop = scrollTop;
    // Restore focus/caret to the same Agent answer control after replacement.
    const restored = focusState && [...body.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusState.key);
    if (restored && !restored.disabled) {
      restored.focus({ preventScroll: true });
      if (focusState.start !== null) try { restored.setSelectionRange(focusState.start, focusState.end, focusState.direction); } catch {}
    }
  }

  const ZOOM_MIN = 0.01;
  const ZOOM_MAX = 4;
  const WHEEL_PAN_SPEED = 1.15;
  const WHEEL_ZOOM_SPEED = 0.0044;
  const PAN_SMOOTHING = 0.24;
  const ZOOM_SMOOTHING = 0.22;
  const WHEEL_SESSION_IDLE_MS = 140;
  const AGENDA_STORAGE_PREF = 'egdesk.agendaState.v1';
  const SURFACE_LIFECYCLE_PREF = 'egdesk.surfaceLifecycle.v1';
  const DESK_SESSION_PREF = 'egdesk.deskSession.v1';
  const ONTOLOGY_GRAPH_URL = 'chrome://userchrome/content/ontology/graph.json';

  // The system 'reduce motion' setting, read at each camera move so a change
  // applies without a restart.
  function prefersReducedMotion() {
    try { return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; } catch { return false; }
  }

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

  // Local, original 24-unit outline geometry shared by Desk chrome, live
  // windows, and semantic projections. No remote icon font or copied asset.
  const DESK_ICON_SHAPES = {
    chat: [['path', { d: 'M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 3v-3H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z' }]],
    file: [['path', { d: 'M6 2.5h8l4 4v15H6a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Z' }], ['path', { d: 'M14 2.5v4h4M8 11h8M8 15h8' }]],
    folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }]],
    ontology: [['circle', { cx: '12', cy: '4', r: '2' }], ['circle', { cx: '5', cy: '18', r: '2' }], ['circle', { cx: '19', cy: '18', r: '2' }], ['path', { d: 'm11 6-5 10m7-10 5 10M7 18h10' }]],
    browser: [['circle', { cx: '12', cy: '12', r: '9' }], ['path', { d: 'M3 12h18M12 3c-2.7 2.5-4 5.5-4 9s1.3 6.5 4 9c2.7-2.5 4-5.5 4-9s-1.3-6.5-4-9Z' }]],
    ide: [['path', { d: 'm8 6-5 6 5 6m8-12 5 6-5 6m-3-13-2 14' }]],
    terminal: [['path', { d: 'm4 6 6 6-6 6m9 0h7' }]],
    settings: [['circle', { cx: '12', cy: '12', r: '3.3' }], ['path', { d: 'M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1m0-14.2L17 7M7 17l-2.1 2.1' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    pencil: [['path', { d: 'm4 17 12-12 3 3-12 12-4 1 1-4Zm10-10 3 3' }]],
    move: [['path', { d: 'M12 2v20M2 12h20m-13-7 3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3' }]],
    square: [['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }]],
    ellipse: [['circle', { cx: '12', cy: '12', r: '8' }]],
    line: [['path', { d: 'M5 19 19 5' }]],
    arrow: [['path', { d: 'M5 19 19 5m-8 0h8v8' }]],
    text: [['path', { d: 'M5 6V4h14v2M12 4v16m-3 0h6' }]],
    highlight: [['rect', { x: '3', y: '7', width: '18', height: '10', rx: '1.5' }], ['path', { d: 'm7 17 6-10m-1 10 6-10' }]],
    board: [['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }], ['path', { d: 'M9 4v16' }]],
    pointer: [['path', { d: 'M4 3v17l5-5 3.3 6 2.4-1.3-3.3-6L19 12 4 3Z' }]],
    trash: [['path', { d: 'M4 6h16M9 6V4h6v2m-9 0 1 15h10l1-15M10 10v7m4-7v7' }]],
    desk: [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['path', { d: 'M12 3v18M3 12h18' }]],
    users: [['circle', { cx: '9', cy: '8', r: '3' }], ['path', { d: 'M3.5 20v-2a5.5 5.5 0 0 1 11 0v2M16 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3.5 5' }]],
    search: [['circle', { cx: '10.5', cy: '10.5', r: '6.5' }], ['path', { d: 'm15.5 15.5 5 5' }]],
    back: [['path', { d: 'm11 5-7 7 7 7M4 12h16' }]],
    forward: [['path', { d: 'm13 5 7 7-7 7M20 12H4' }]],
    reload: [['path', { d: 'M20 9a8 8 0 1 0 0 6m0-10v4h-4' }]],
    stop: [['rect', { x: '5', y: '5', width: '14', height: '14', rx: '1.5' }]],
    home: [['path', { d: 'm3 11 9-8 9 8M5 10v11h14V10m-10 11v-7h6v7' }]],
    duplicate: [['rect', { x: '8', y: '8', width: '12', height: '12', rx: '1' }], ['path', { d: 'M16 8V4H4v12h4' }]],
    menu: [['circle', { cx: '5', cy: '12', r: '1' }], ['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '19', cy: '12', r: '1' }]],
    grip: [['circle', { cx: '8', cy: '6', r: '1' }], ['circle', { cx: '16', cy: '6', r: '1' }], ['circle', { cx: '8', cy: '12', r: '1' }], ['circle', { cx: '16', cy: '12', r: '1' }], ['circle', { cx: '8', cy: '18', r: '1' }], ['circle', { cx: '16', cy: '18', r: '1' }]],
    lock: [['rect', { x: '5', y: '10', width: '14', height: '11', rx: '2' }], ['path', { d: 'M8 10V7a4 4 0 0 1 8 0v3' }]],
    close: [['path', { d: 'M5 5 19 19M19 5 5 19' }]],
    minimize: [['path', { d: 'M5 12h14' }]],
    fit: [['path', { d: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5' }]],
    chevron: [['path', { d: 'm6 9 6 6 6-6' }]],
    alert: [['path', { d: 'M12 3 2.8 20h18.4L12 3Zm0 6v5m0 3v.2' }]],
    recovery: [['path', { d: 'M4 7v5h5m-5 0a8 8 0 1 1 2 6' }]],
    minimap: [['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }], ['path', { d: 'M7 8h6v5H7zM15 15h3' }]],
    check: [['path', { d: 'm4 12 5 5L20 6' }]],
    account: [['circle', { cx: '12', cy: '8', r: '3' }], ['path', { d: 'M5.5 20a6.5 6.5 0 0 1 13 0' }]],
  };

  function deskIcon(name, className = 'egd-ui-icon') {
    const icon = svgEl('svg', {
      class: className, viewBox: '0 0 24 24', width: '18', height: '18',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true', focusable: 'false',
    });
    for (const [tag, props] of DESK_ICON_SHAPES[name] || DESK_ICON_SHAPES.square) {
      icon.appendChild(svgEl(tag, props));
    }
    return icon;
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
    if (String(url || '') === EGDESK_START_URI) return 'EG-Desk';
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

  function browserVisibleAddress(url) {
    return String(url || '') === EGDESK_START_URI ? '' : String(url || '');
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
    if (label === 'Secure') return deskIcon('lock');
    if (label === 'Not secure') return deskIcon('alert');
    if (label === 'Local') return deskIcon('file');
    return deskIcon('browser');
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
      title: fallback.title || snapshot?.agenda?.title || meta.title || 'Board',
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
        firstUseBrowser: false,
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
    const type = shape.dataset.shapeType || 'rect';
    // A label that was never committed has nothing to keep.
    if (type === 'label' && !shape._labelText) return null;
    const geometry = persistentEntityGeometry(shape);
    return {
      id: shape.id,
      type,
      geometry,
      sourceRef: cleanSourceRef(shape._sourceRef),
      runtimeState: SurfaceState.canvasShapeRuntime(type, {
        transform: shape.style.transform || '',
        x1: shape.dataset.x1, y1: shape.dataset.y1, x2: shape.dataset.x2, y2: shape.dataset.y2,
        points: shape._pathPoints, text: shape._labelText,
      }),
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
      surface: { mode: state.surface.mode, browserCardId: state.surface.browserCardId,
        initialBrowserFocus: !!state.surface.initialBrowserFocus,
        recoveryBackupKey: state.surface.recoveryBackupKey || null, recoveryAcknowledged: !!state.surface.recoveryAcknowledged },
      boardProjections: cloneJson(state.boards),
      chat: {
        threads: cloneJson(state.codex.threads.map(({ localRuns, localHistoryCoverage, ...thread }) => ({
          ...thread, messages: (thread.messages || []).map(({ liveRevision, localHistory, localSeq, ...message }) => message),
        }))),
        activeThreadId: state.codex.activeThreadId,
        codexAccountKey: state.codex.codexAccountKey || null,
        unobservedPreviousRun: !!state.codex.chatProtocol.unobservedPreviousRun,
        threadDrafts: { ...state.codex.threadDrafts }, hudView: state.codex.hudView,
        recentEngineId: state.codex.recentEngineId || null,
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

  // Most recently activated Board projections, newest first (this session only).
  const recentBoardProjectionIds = [];

  function selectBoardProjection(projectionId) {
    const projection = state.boards.projections[projectionId];
    if (!projection) return false;
    state.boards.activeProjectionId = projection.id;
    state.agenda.activeAgendaId = projection.boardId;
    state.agenda.activeTitle = projection.title;
    state.agenda.dirty = !!projection.dirty;
    state.agenda.hasSavedState = !!coerceAgendaStore().agendas[projection.boardId];
    const previous = recentBoardProjectionIds.indexOf(projection.id);
    if (previous >= 0) recentBoardProjectionIds.splice(previous, 1);
    recentBoardProjectionIds.unshift(projection.id);
    recentBoardProjectionIds.length = Math.min(recentBoardProjectionIds.length, 8);
    syncViewportAgendaRail();
    return true;
  }

  function syncBoardRegionMarks(region, projection) {
    const active = projection.id === state.boards.activeProjectionId;
    const dirty = !!projection.dirty;
    if (region.dataset.active !== String(active)) region.dataset.active = String(active);
    if (region.dataset.dirty !== String(dirty)) region.dataset.dirty = String(dirty);
    const current = region.querySelector('.egd-board-region-current');
    if (current && current.hidden === active) current.hidden = !active;
    const unsaved = region.querySelector('.egd-board-region-unsaved');
    if (unsaved && unsaved.hidden === dirty) unsaved.hidden = !dirty;
  }

  function syncAllBoardRegionMarks() {
    for (const projection of Object.values(state.boards.projections)) {
      const region = document.getElementById(projection.id);
      if (region) syncBoardRegionMarks(region, projection);
    }
  }

  function refreshBoardRegion(projection) {
    let region = document.getElementById(projection.id);
    if (!region) {
      region = el('section', {
        id: projection.id, class: 'egd-board-region',
        data: { boardId: projection.boardId, projectionId: projection.id, testid: 'board-projection' },
      }, el('div', { class: 'egd-board-region-head' },
        el('button', { type: 'button', class: 'egd-board-region-title', data: { testid: 'board-select', projectionId: projection.id },
          onclick: () => selectBoardProjection(projection.id) },
        deskIcon('board'), el('span', { class: 'egd-board-region-name' })),
        el('span', { class: 'egd-board-region-current', hidden: true }, '현재 Board'),
        el('span', { class: 'egd-board-region-unsaved', hidden: true }, '저장 안 됨'),
        el('button', { type: 'button', class: 'egd-board-region-menu-button', title: 'Board 작업',
          'aria-haspopup': 'menu', 'aria-expanded': 'false', data: { testid: 'board-menu', projectionId: projection.id },
          onclick: (ev) => {
            ev.stopPropagation();
            toggleBoardRegionMenu(projection.id, ev.currentTarget);
          } }, deskIcon('menu'))));
      document.getElementById('egd-canvas-layer').prepend(region);
    }
    region.setAttribute('aria-label', `Board ${projection.title}`);
    const name = region.querySelector('.egd-board-region-name');
    if (name && name.textContent !== projection.title) name.textContent = projection.title;
    region.querySelector('.egd-board-region-title')?.setAttribute('aria-label', `Board ${projection.title} 선택`);
    region.querySelector('.egd-board-region-menu-button')?.setAttribute('aria-label', `${projection.title} Board 작업`);
    syncBoardRegionMarks(region, projection);
    const rects = projection.members.map(m => document.getElementById(m.viewId)).filter(Boolean).map(persistentEntityGeometry);
    const rect = SurfaceState.boardRegionRect(rects, { fallback: projection.offset });
    Object.assign(region.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    scheduleViewportBoardSync();
    return region;
  }

  let boardRegionMenu = null;
  function closeBoardRegionMenu({ restoreFocus = false } = {}) {
    const menu = boardRegionMenu;
    if (!menu) return;
    boardRegionMenu = null;
    menu._dispose?.();
    menu.remove();
    menu._anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus && menu._anchor.isConnected) menu._anchor.focus();
  }

  function toggleBoardRegionMenu(projectionId, anchor) {
    const sameMenu = boardRegionMenu?.dataset.projectionId === projectionId;
    closeBoardRegionMenu();
    const projection = state.boards.projections[projectionId];
    if (sameMenu || !projection || !anchor?.isConnected) return null;
    const item = (label, title, testid, action) => el('button', {
      type: 'button', class: 'egd-board-menu-item', role: 'menuitem', title, 'aria-label': title,
      data: { testid, projectionId },
      onclick: (ev) => {
        ev.stopPropagation();
        closeBoardRegionMenu();
        action();
      },
    }, label);
    const items = [
      item('저장', '이 Board 저장', 'board-save', () => saveCurrentAgendaState({ projectionId })),
      item('Chat에 첨부', '이 Board의 요소를 Chat에 첨부', 'board-attach-chat',
        () => openChatInputPanel(state.codex.activeThreadId, { viewIds: projection.members.map(member => member.viewId) })),
      item('Board 닫기', '이 Board 닫기', 'board-close', () => closeCurrentAgenda({ projectionId })),
    ];
    const pos = resolveFloatingMenuPlacement(anchor.getBoundingClientRect(), 152, 112);
    const menu = el('div', {
      class: 'egd-board-menu', role: 'menu', 'aria-label': `${projection.title} Board 작업`,
      data: { projectionId }, style: { left: `${Math.round(pos.left)}px`, top: `${Math.round(pos.top)}px` },
    }, ...items);
    const onKeydown = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeBoardRegionMenu({ restoreFocus: true });
        return;
      }
      const current = items.indexOf(document.activeElement);
      const next = ev.key === 'ArrowDown' ? (current + 1) % items.length
        : ev.key === 'ArrowUp' ? (current - 1 + items.length) % items.length
          : ev.key === 'Home' ? 0 : ev.key === 'End' ? items.length - 1 : -1;
      if (next < 0) return;
      ev.preventDefault();
      items[next].focus();
    };
    // The menu is screen chrome over a moving Canvas; a press elsewhere or a pan closes it.
    const onOutside = (ev) => {
      if (menu.contains(ev.target) || anchor.contains(ev.target)) return;
      closeBoardRegionMenu();
    };
    menu.addEventListener('keydown', onKeydown);
    window.addEventListener('mousedown', onOutside, true);
    window.addEventListener('wheel', onOutside, true);
    menu._anchor = anchor;
    menu._dispose = () => {
      window.removeEventListener('mousedown', onOutside, true);
      window.removeEventListener('wheel', onOutside, true);
    };
    document.documentElement.appendChild(menu);
    anchor.setAttribute('aria-expanded', 'true');
    boardRegionMenu = menu;
    items[0].focus();
    return menu;
  }

  function openBoardSnapshot(snapshot, options = {}) {
    if (!snapshot?.agenda?.id) { boardNotice('저장된 Board를 읽을 수 없습니다.'); return false; }
    let projection = Object.values(state.boards.projections).find(p => p.boardId === snapshot.agenda.id);
    if (!projection) {
      let projectionId;
      do { projectionId = `egd-board-${++cardSeq}`; } while (document.getElementById(projectionId));
      projection = SurfaceState.planBoardProjection(snapshot, projectionId);
      // The whole Board region keeps its saved layout and takes the closest
      // empty spot of the view, 24px clear of open Views and Boards.
      const occupied = Array.from(document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape, .egd-board-region')).map(persistentEntityGeometry);
      const saved = SurfaceState.boardRegionRect(projection.members.map(member => member.record.geometry
        || { x: 40, y: 80, width: 340, height: 180 }), { fallback: { x: 0, y: 0 } });
      const spot = SurfaceState.placeCanvasView({ size: saved, safe: safeViewportWorldRect(), occupied, gap: 24 });
      projection.offset = { x: spot.x - saved.x, y: spot.y - saved.y };
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
      // A region already in view keeps the camera; otherwise the camera moves just enough.
      state.setCanvasPanTarget?.(SurfaceState.revealRectPan(persistentEntityGeometry(region), safeViewportRect(),
        { pan: state.panTarget, zoom: state.zoomTarget }), { immediate: true });
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
      if (isCardFullscreen(card)) exitCardFullscreen(card, { restoreRect: false });
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
    const restored = SurfaceState.restoreCanvasShape(shapeState);
    const shape = createCanvasShape(restored.type);
    retargetRestoredEntityId(shape, shapeState?.id);
    if (shapeState?.sourceRef) shape._sourceRef = shapeState.sourceRef;
    applyPersistentEntityGeometry(shape, shapeState?.geometry);
    if (restored.transform) shape.style.transform = restored.transform;
    for (const [key, value] of Object.entries(restored.line)) {
      if (value != null) shape.dataset[key] = value;
    }
    if (restored.type === 'path') {
      shape._pathPoints = restored.points;
      renderCanvasPath(shape);
    }
    if (restored.type === 'label') {
      shape._labelText = restored.text;
      shape.querySelector('.egd-canvas-shape-label-text').textContent = restored.text;
      // A label sizes to its text; the saved box is only its last measured extent.
      shape.style.width = '';
      shape.style.height = '';
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
        // An engine that is no longer usable falls back to Codex when a room resolves it.
        if (typeof snapshot.chat.recentEngineId === 'string') state.codex.recentEngineId = snapshot.chat.recentEngineId;
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
        if (isCardFullscreen(view)) exitCardFullscreen(view, { restoreRect: false });
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

  function normalizeAgendaTitle(title, fallback = 'Board') {
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
    const fallbackTitle = snapshot?.agenda?.title || store.meta?.[agendaId]?.title || 'Board';
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
    const sourceTitle = sourceSnapshot.agenda?.title || store.meta?.[agendaId]?.title || 'Board';
    const newId = newAgendaId('agenda-copy');
    const newTitle = normalizeAgendaTitle(options.title, `${sourceTitle} 사본`);
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
    return SurfaceState.boardEntryStatusLabel(entry);
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
      return card.querySelector('.egd-card-url')?.value || card._sourceRef?.uri || 'Browser 카드';
    }
    if (card.classList.contains('egd-chat-card')) {
      const active = getActiveCodexThread(state.codex);
      return active ? `${codexThreadLongLabel(active.type)} · ${codexThreadSessionLabel(active)}` : 'Chat 카드';
    }
    if (card.classList.contains('egd-ontology-card')) return '온톨로지 지도';
    if (card.classList.contains('egd-terminal-card')) return 'Terminal 카드';
    if (card.classList.contains('egd-settings-card')) return '설정 카드';
    return card._sourceRef?.uri || card._sourceRef?.id || card.id || 'Canvas 카드';
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
        section: SurfaceState.railSearchSectionLabel('agenda'),
        title: entry.title,
        subtitle: [agendaEntryStatus(entry), SurfaceState.boardItemCountLabel(entry.count)].join(' · '),
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
        section: SurfaceState.railSearchSectionLabel('card'),
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
          section: SurfaceState.railSearchSectionLabel('history'),
          title: railSearchUrlTitle(uri),
          subtitle: `${agendaTitle} · 저장된 Browser`,
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
      section: SurfaceState.railSearchSectionLabel('file'),
      title: file.name,
      subtitle: `${file.root} · ${file.type === 'folder' ? '폴더' : '파일'} · ${file.path}`,
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
        section: SurfaceState.railSearchSectionLabel('thread'),
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
      section: SurfaceState.railSearchSectionLabel('web'),
      title: railSearchLooksLikeNavigation(q) ? url : `웹에서 "${q}" 검색`,
      subtitle: '새 Browser 카드로 열기',
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
        el('span', { class: `egd-rail-search-type egd-rail-search-type-${result.type}` }, SurfaceState.railSearchSectionLabel(result.type)),
        el('span', { class: 'egd-rail-search-main' },
          el('span', { class: 'egd-rail-search-title' }, result.title),
          el('span', { class: 'egd-rail-search-subtitle' }, result.subtitle),
        ),
        result.active ? el('span', { class: 'egd-rail-search-current' }, '현재') : null,
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
    title = 'Board',
    heading = 'Board를 전환할까요?',
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
      'aria-current': entry.current ? 'true' : null,
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
      el('span', { class: 'egd-agenda-switch-row-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'egd-agenda-switch-row-main' },
        el('span', { class: 'egd-agenda-switch-row-title' }, entry.title),
        el('span', { class: 'egd-agenda-switch-row-meta' },
          [
            // The current Board is said in words, not only by the row colour.
            entry.current && agendaEntryStatus(entry) !== '현재' ? '현재' : null,
            agendaEntryStatus(entry),
            SurfaceState.boardEntryRecencyLabel(entry),
            SurfaceState.boardItemCountLabel(entry.count),
          ].filter(Boolean).join(' · '),
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
          placeholder: 'Board 검색...',
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
      syncViewportAgendaRail();
      return;
    }
    active.classList.add('egd-entity-active');
    state.activeEntityId = active.id || null;
    syncViewportAgendaRail();
  }

  function viewportToCanvasPoint(clientX, clientY) {
    return {
      x: (clientX - state.panTarget.x) / state.zoomTarget,
      y: (clientY - state.panTarget.y) / state.zoomTarget,
    };
  }

  function activeToolIsShape() {
    return !!SurfaceState.canvasToolShapeType(state.activeTool);
  }

  function syncActiveToolMode() {
    document.documentElement.dataset.egdActiveTool = SurfaceState.normalizeCanvasTool(state.activeTool);
  }

  function shapeTypeForTool(tool = state.activeTool) {
    return SurfaceState.canvasToolShapeType(tool) || 'rect';
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
    const railRect = rail?.getBoundingClientRect();
    const dockRect = dock?.getBoundingClientRect();
    const bagRect = bag?.getBoundingClientRect();
    if (railRect?.height > 0) top = Math.max(top, railRect.bottom + margin);
    if (dockRect?.height > 0) bottom = Math.min(bottom, dockRect.top - margin);
    if (bagRect?.width > 0) left = Math.max(left, bagRect.right + margin);
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

  // The visible safe area in world px, where new Views open.
  function safeViewportWorldRect(options = {}) {
    const safe = safeViewportRect(options);
    const zoom = Math.max(0.001, state.zoomTarget || state.zoom || 1);
    const topLeft = viewportToCanvasPoint(safe.left, safe.top);
    return { left: topLeft.x, top: topLeft.y, right: topLeft.x + safe.width / zoom, bottom: topLeft.y + safe.height / zoom };
  }

  // CNV-02: a new View opens at its type's size (shrunk to the visible safe
  // area, never below its minimum) in the closest empty spot of that area,
  // 24px clear of other Views and Board regions. Without room there it takes
  // the closest empty Canvas spot and revealPlacedCanvasCard brings the camera.
  // Existing Views never move or shrink.
  function resolveCanvasCardPlacement(kind, options = {}) {
    const safe = safeViewportWorldRect(options);
    const size = SurfaceState.canvasViewSize(kind, { width: safe.right - safe.left, height: safe.bottom - safe.top });
    const anchor = Number.isFinite(options.anchorClientX) && Number.isFinite(options.anchorClientY)
      ? viewportToCanvasPoint(options.anchorClientX, options.anchorClientY) : null;
    const occupied = Array.from(document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape, .egd-board-region'))
      .map(persistentEntityGeometry);
    return SurfaceState.placeCanvasView({ size, safe, occupied, anchor, gap: 24 });
  }

  // The camera follows a View placed outside the view once its caller is done.
  // A restore that writes the saved rect, or a camera move made meanwhile (a
  // Board focus, a Briefing fit), keeps the camera where it is. A View opened
  // from a Chat card (an artifact chip) is framed with that Chat while both
  // stay readable; otherwise it shows alone with a short way back to the Chat.
  function revealPlacedCanvasCard(card, placement, options = {}) {
    if (!card || !placement || placement.inView) return;
    const camera = { x: state.panTarget.x, y: state.panTarget.y, zoom: state.zoomTarget };
    window.setTimeout(() => {
      if (!card.isConnected || state.agenda.restoreInProgress || state.surface.restoring) return;
      if (state.panTarget.x !== camera.x || state.panTarget.y !== camera.y || state.zoomTarget !== camera.zoom) return;
      const rect = persistentEntityGeometry(card);
      if (rect.x !== Math.round(placement.x) || rect.y !== Math.round(placement.y)) return;
      const safe = safeViewportRect();
      const view = { pan: state.panTarget, zoom: state.zoomTarget };
      const opener = options.opener?.isConnected && options.opener !== card ? options.opener : null;
      if (opener) {
        const chat = chatOpenerView(opener);
        const minZoom = SurfaceState.semanticDetailZoomFloor([{ ...rect, kind: options.kind }, chat]);
        const paired = SurfaceState.pairedRevealCamera([rect, chat], safe, { ...view, minZoom });
        if (paired) { state.setCanvasViewportTarget?.(paired); return; }
        showChatReturnCue(opener);
      }
      state.setCanvasPanTarget?.(SurfaceState.revealRectPan(rect, safe, view));
    }, 0);
  }

  // The opening Chat card as the camera sees it: its visible height (a
  // readable cap may shorten it) and the body font its detail level reads.
  function chatOpenerView(card) {
    const rect = persistentEntityGeometry(card);
    const height = card.style.maxHeight ? Math.min(rect.height, parsePxNumber(card.style.maxHeight, rect.height)) : rect.height;
    const body = card.querySelector('.egd-chat-card-body') || card;
    return { kind: 'chat', x: rect.x, y: rect.y, width: rect.width, height,
      fontPx: parsePxNumber(window.getComputedStyle(body).fontSize, 14) };
  }

  // Shown for a few seconds when a View opened from Chat took the camera
  // alone. Pressing it brings that Chat back the way the Dock's Chat does; it
  // leaves once the Chat is back by any way (Dock, a click into the Chat).
  const CHAT_RETURN_CUE_MS = 6000;
  function dismissChatReturnCue() {
    document.getElementById('egd-chat-return')?._dismiss?.();
  }

  function showChatReturnCue(chatCard) {
    document.getElementById('egd-chat-return')?._dismiss?.();
    const cue = el('div', { id: 'egd-chat-return', class: 'egd-edge egd-frosted', role: 'status' });
    const chatListeners = new AbortController();
    let timer = 0;
    const dismiss = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      chatListeners.abort();
      cue.remove();
    };
    cue._dismiss = dismiss;
    for (const type of ['mousedown', 'focusin']) chatCard.addEventListener(type, dismiss, { capture: true, signal: chatListeners.signal });
    cue.appendChild(el('button', {
      type: 'button', class: 'egd-chat-return-button', data: { testid: 'chat-return' },
      onclick: (ev) => {
        ev.stopPropagation();
        dismiss();
        if (!chatCard.isConnected) return;
        if (!state.focusChatDockIfCompact?.(chatCard)) focusCanvasCard(chatCard);
      },
    }, deskIcon('chat'), el('span', {}, '채팅으로 돌아가기')));
    document.documentElement.appendChild(cue);
    timer = window.setTimeout(dismiss, CHAT_RETURN_CUE_MS);
    return cue;
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

  // The top bar names the Board on screen. Saved titles keep using
  // currentViewportAgendaLabel, which never carries the '· +N' suffix.
  function viewportBoardResolution() {
    const regions = [];
    for (const projection of Object.values(state.boards.projections)) {
      const region = document.getElementById(projection.id);
      if (!region) continue;
      const left = parsePxNumber(region.style.left, NaN);
      const top = parsePxNumber(region.style.top, NaN);
      regions.push({ id: projection.id, rect: { left, top,
        right: left + parsePxNumber(region.style.width, 0), bottom: top + parsePxNumber(region.style.height, 0) } });
    }
    const activeEntity = state.activeEntityId ? document.getElementById(state.activeEntityId) : null;
    return SurfaceState.resolveViewportBoard({
      viewport: viewportWorldRect(), regions,
      activeId: state.boards.activeProjectionId,
      activeEntityBoardId: activeEntity?.dataset.projectionId || null,
      recentIds: recentBoardProjectionIds,
    });
  }

  function viewportBoardLabel(resolution = viewportBoardResolution()) {
    const projection = resolution.primaryId != null ? state.boards.projections[resolution.primaryId] : null;
    if (!projection) return { text: 'Board 없음', title: '화면에 보이는 Board가 없습니다' };
    const names = resolution.visibleIds.map(id => state.boards.projections[id]?.title).filter(Boolean);
    return {
      text: resolution.extraCount > 0 ? `${projection.title} · +${resolution.extraCount}` : projection.title,
      title: names.length > 1 ? `화면의 Board: ${names.join(', ')}` : projection.title,
    };
  }

  function syncViewportBoardName() {
    const agendaName = document.querySelector('.egd-rail-agenda-name');
    if (!agendaName) return;
    const label = viewportBoardLabel();
    if (agendaName.textContent !== label.text) agendaName.textContent = label.text;
    if (agendaName.title !== label.title) agendaName.title = label.title;
  }

  // Camera frames call this; the name follows the camera at most every 120ms.
  const VIEWPORT_BOARD_SYNC_MS = 120;
  let viewportBoardSyncTimer = 0;
  let viewportBoardSyncAt = 0;
  function scheduleViewportBoardSync() {
    if (viewportBoardSyncTimer) return;
    const wait = Math.max(0, VIEWPORT_BOARD_SYNC_MS - (Date.now() - viewportBoardSyncAt));
    viewportBoardSyncTimer = window.setTimeout(() => {
      viewportBoardSyncTimer = 0;
      viewportBoardSyncAt = Date.now();
      syncViewportBoardName();
    }, wait);
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
    // The focused Browser can be removed before this sync; retain the single
    // gadget node so its poller and controls can return to the rail intact.
    const gadget = resourceGadget;
    const fullscreenCard = state.cardFullscreen?.cardId
      ? document.getElementById(state.cardFullscreen.cardId) : null;
    const focusedBrowserToolbar = fullscreenCard?.classList.contains('egd-browser-card')
      ? fullscreenCard.querySelector('.egd-desk-window-toolbar') : null;
    if (gadget && focusedBrowserToolbar) {
      const duplicate = focusedBrowserToolbar.querySelector('.egd-card-duplicate');
      if (duplicate && (gadget.parentElement !== focusedBrowserToolbar || gadget.nextElementSibling !== duplicate)) {
        focusedBrowserToolbar.insertBefore(gadget, duplicate);
      }
    } else if (gadget) {
      const railRight = document.querySelector('#egd-desk-rail .egd-rail-right');
      const avatar = railRight?.querySelector('.egd-rail-avatar');
      if (avatar && (gadget.parentElement !== railRight || gadget.nextElementSibling !== avatar)) {
        railRight.insertBefore(gadget, avatar);
      }
    }
    syncViewportBoardName();
    syncAllBoardRegionMarks();
    const switcher = document.querySelector('.egd-rail-switcher');
    if (switcher) switcher.classList.toggle('egd-rail-switcher-open', !!document.getElementById('egd-agenda-switcher'));
    const dirtyBadge = document.querySelector('.egd-rail-dirty-badge');
    if (dirtyBadge) {
      dirtyBadge.hidden = !state.agenda.dirty;
      dirtyBadge.title = SurfaceState.boardSaveStatusTitle(state.agenda.dirty);
      dirtyBadge.dataset.revision = String(state.agenda.dirtyRevision || 0);
    }
    const saveBtn = document.querySelector('.egd-rail-save-btn');
    if (saveBtn) saveBtn.hidden = !state.agenda.dirty;
    const restoreBtn = document.querySelector('.egd-rail-restore-btn');
    if (restoreBtn) restoreBtn.hidden = !state.agenda.hasSavedState;
    const focusedFile = Boolean(state.activeEntityId
      && document.getElementById(state.activeEntityId)?.classList.contains('egd-file-card'));
    const fileRailItem = document.querySelector('#egd-preset-bag .egd-bag-file');
    fileRailItem?.classList.toggle('egd-bag-chip-active', focusedFile);
    if (fileRailItem) {
      if (focusedFile) fileRailItem.setAttribute('aria-current', 'page');
      else fileRailItem.removeAttribute('aria-current');
    }
    document.querySelector('#egd-preset-bag .egd-bag-header')?.classList.toggle('egd-bag-header-muted', focusedFile);

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
    closeMinimapStack();
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

  // Each open Board's region in world px, for the minimap.
  function boardRegionWorldRects() {
    return Object.values(state.boards.projections).map((projection) => {
      const region = document.getElementById(projection.id);
      return region ? { id: projection.id, title: projection.title, rect: entityWorldRect(region) } : null;
    }).filter(Boolean);
  }

  function minimapDeskBounds() {
    const viewport = viewportWorldRect();
    const entities = Array.from(document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape'))
      .map((entity) => ({ entity, rect: entityWorldRect(entity) }))
      .filter((item) => item.rect);
    const regions = boardRegionWorldRects();
    let left = viewport.left;
    let top = viewport.top;
    let right = viewport.right;
    let bottom = viewport.bottom;
    for (const { rect } of [...entities, ...regions]) {
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
    return { bounds, viewport, entities, regions, density, sparsity, spreadRatio };
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
      caption.textContent = SurfaceState.deskMinimapCaption(dimensions.zoom, modelBase.entities.length);
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
    const box = SurfaceState.minimapBox(rect, model, Number.isFinite(options.minSize) ? options.minSize : 3);
    return { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' };
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

  function minimapEntityTitle(entity) {
    return entity.classList.contains('egd-canvas-card')
      ? cardLabelForViewportRail(entity)
      : CANVAS_SHAPE_TITLES[entity.dataset.shapeType] || '도형';
  }

  // Presses on the map are read from its model (minimapTargetsAt), so markers
  // only show where things are and name them on hover.
  function buildMinimapEntityMarker(item, model) {
    const entity = item.entity;
    const isCard = entity.classList.contains('egd-canvas-card');
    return el('span', {
      class: 'egd-minimap-entity'
        + (isCard ? ' egd-minimap-entity-card' : ' egd-minimap-entity-shape')
        + (entity.id === state.activeEntityId ? ' egd-minimap-entity-active' : ''),
      title: minimapEntityTitle(entity),
      data: { entityId: entity.id },
      style: worldRectToMinimapStyle(item.rect, model),
    });
  }

  function buildMinimapBoardRegion(board) {
    const label = `${board.title} Board로 이동`;
    return el('div', {
      class: 'egd-minimap-board',
      data: { projectionId: board.id, active: String(board.active), testid: 'minimap-board' },
      style: { left: board.left + 'px', top: board.top + 'px', width: board.width + 'px', height: board.height + 'px' },
    }, el('button', {
      type: 'button', class: 'egd-minimap-board-label', title: label, 'aria-label': label,
      data: { projectionId: board.id, compact: String(!board.showLabel), testid: 'minimap-board-go' },
      onclick: (ev) => {
        ev.stopPropagation();
        focusBoardFromMinimap(board.id);
      },
    }, board.showLabel ? board.title : ''));
  }

  function renderDeskMinimapWorld(panel) {
    const map = panel?.querySelector('.egd-minimap-map');
    if (!map) return null;
    const model = minimapWorldModel(map);
    map.textContent = '';
    const boards = SurfaceState.minimapBoardRegions({
      regions: model.regions, model, activeId: state.boards.activeProjectionId,
    });
    const entityMarkers = model.entities.map((item) => buildMinimapEntityMarker(item, model));
    const viewportMarker = el('div', {
      class: 'egd-minimap-viewport',
      style: worldRectToMinimapStyle(model.viewport, model, { minSize: 8 }),
      title: `현재 화면 · ${Math.round((state.zoomTarget || state.zoom || 1) * 100)}%`,
    });
    for (const board of boards) map.appendChild(buildMinimapBoardRegion(board));
    for (const marker of entityMarkers) map.appendChild(marker);
    map.appendChild(viewportMarker);
    map._egdeskMinimapModel = model;
    // Boards first, then Views from the top of the stack down: the order the
    // '이 위치의 N개' list reads in.
    const views = model.entities
      .map((item) => ({ item, z: parsePxNumber(item.entity.style.zIndex, 0) }))
      .sort((a, b) => b.z - a.z)
      .map(({ item }) => ({
        kind: 'view', id: item.entity.id, title: minimapEntityTitle(item.entity),
        projectionId: item.entity.dataset.projectionId || null, box: SurfaceState.minimapBox(item.rect, model),
      }));
    map._egdeskMinimapTargets = [
      ...boards.map((board) => ({ kind: 'board', id: board.id, title: board.title, box: board })),
      ...views,
    ];
    return model;
  }

  // A Board picked on the minimap becomes the current Board, and the camera
  // fits its region into the safe area without zooming past 100%.
  function focusBoardFromMinimap(projectionId) {
    const region = document.getElementById(projectionId);
    if (!region || !state.boards.projections[projectionId]) return false;
    closeMinimapStack();
    selectBoardProjection(projectionId);
    state.setCanvasViewportTarget?.(SurfaceState.fitSurfaceCamera(persistentEntityGeometry(region), safeViewportRect(), 1));
    refreshDeskMinimap();
    return true;
  }

  // A View picked on the minimap: the camera moves just enough to show it
  // (its bar first when it is larger than the view) and it comes to the front.
  function focusEntityFromMinimap(entityId) {
    const entity = document.getElementById(entityId);
    if (!entity?.isConnected) return false;
    closeMinimapStack();
    state.setCanvasPanTarget?.(SurfaceState.revealRectPan(persistentEntityGeometry(entity), safeViewportRect(),
      { pan: state.panTarget, zoom: state.zoomTarget }));
    focusCanvasCard(entity);
    refreshDeskMinimap();
    return true;
  }

  function goToMinimapTarget(target) {
    return target?.kind === 'board' ? focusBoardFromMinimap(target.id) : focusEntityFromMinimap(target?.id);
  }

  function closeMinimapStack() {
    const stack = document.querySelector('#egd-desk-minimap .egd-minimap-stack');
    if (!stack) return;
    stack._dispose?.();
    stack.remove();
  }

  // One target under the press goes straight there; several open the
  // '이 위치의 N개' list beside the press so the user picks one.
  function openMinimapTargets(panel, targets, point) {
    if (!targets?.length) return null;
    if (targets.length === 1) {
      goToMinimapTarget(targets[0]);
      return null;
    }
    closeMinimapStack();
    const map = panel.querySelector('.egd-minimap-map');
    const title = SurfaceState.minimapStackTitle(targets.length);
    const rows = targets.map((target) => el('button', {
      type: 'button', class: 'egd-minimap-row egd-minimap-stack-row', role: 'menuitem',
      data: { kind: target.kind, targetId: target.id, testid: 'minimap-stack-row' },
      onclick: (ev) => {
        ev.stopPropagation();
        goToMinimapTarget(target);
      },
    },
      el('span', { class: 'egd-minimap-row-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'egd-minimap-row-label' }, target.title),
      target.kind === 'board' ? el('span', { class: 'egd-minimap-row-kind' }, 'Board') : null,
    ));
    const stack = el('div', { class: 'egd-minimap-stack', role: 'menu', 'aria-label': title, data: { testid: 'minimap-stack' } },
      el('div', { class: 'egd-minimap-stack-title' }, title), ...rows);
    const onKeydown = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeMinimapStack();
        return;
      }
      const current = rows.indexOf(document.activeElement);
      const next = ev.key === 'ArrowDown' ? (current + 1) % rows.length
        : ev.key === 'ArrowUp' ? (current - 1 + rows.length) % rows.length : -1;
      if (next < 0) return;
      ev.preventDefault();
      rows[next].focus();
    };
    const onOutside = (ev) => {
      if (!stack.isConnected) { stack._dispose(); return; }
      if (!stack.contains(ev.target)) closeMinimapStack();
    };
    stack.addEventListener('keydown', onKeydown);
    window.addEventListener('mousedown', onOutside, true);
    stack._dispose = () => window.removeEventListener('mousedown', onOutside, true);
    panel.appendChild(stack);
    const maxLeft = Math.max(6, panel.clientWidth - stack.offsetWidth - 6);
    stack.style.left = Math.round(clampNumber((map?.offsetLeft || 0) + point.x - 12, 6, maxLeft)) + 'px';
    stack.style.top = Math.round((map?.offsetTop || 0) + point.y + 8) + 'px';
    rows[0].focus();
    return stack;
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
        : CANVAS_SHAPE_TITLES[entity.dataset.shapeType] || '도형';
      return el('button', {
        class: 'egd-minimap-row' + (isActive ? ' egd-minimap-row-active' : ''),
        title: `${kind} 보기`,
        'aria-current': isActive ? 'true' : null,
        onclick: () => {
          focusEntityFromMinimap(entity.id);
          closeDeskMinimap();
        },
      },
        el('span', { class: 'egd-minimap-row-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'egd-minimap-row-label' }, kind),
        isActive ? el('span', { class: 'egd-minimap-row-current' }, '현재') : null,
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
      boards: Array.from(panel?.querySelectorAll('.egd-minimap-board') || []).map((node) => ({
        projectionId: node.dataset.projectionId,
        active: node.dataset.active === 'true',
        label: node.querySelector('.egd-minimap-board-label')?.textContent || '',
        rect: rectOf(node),
      })),
      stack: Array.from(panel?.querySelectorAll('.egd-minimap-stack-row') || []).map((node) => ({
        kind: node.dataset.kind, targetId: node.dataset.targetId, label: node.textContent,
      })),
    };
  }

  const MINIMAP_PICK_SLOP = 4;
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
    // A press on Boards or Views that does not move is a pick (one target goes
    // there, several open the list); once it moves it pans like empty map.
    map.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if (ev.target?.closest?.('.egd-minimap-board-label')) return;
      closeMinimapStack();
      const model = minimapWorldModel(map);
      const point = minimapPointToWorld(ev.clientX, ev.clientY, map, model);
      const viewport = viewportWorldRect();
      const mapRect = map.getBoundingClientRect();
      const local = { x: ev.clientX - mapRect.left, y: ev.clientY - mapRect.top };
      const targets = SurfaceState.minimapTargetsAt(local, map._egdeskMinimapTargets || []);
      const press = { startX: ev.clientX, startY: ev.clientY, local, targets, moved: false };
      if (ev.target?.classList?.contains('egd-minimap-viewport')) {
        drag = { ...press, mode: 'box', offsetX: point.x - viewport.left, offsetY: point.y - viewport.top };
      } else if (targets.length) {
        drag = { ...press, mode: 'center' };
      } else {
        drag = { ...press, mode: 'center', moved: true };
        setFromEvent(ev);
      }
      map.classList.add('egd-minimap-dragging');
      ev.preventDefault();
      ev.stopPropagation();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < MINIMAP_PICK_SLOP) return;
      drag.moved = true;
      setFromEvent(ev);
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
    window.addEventListener('mouseup', (ev) => {
      if (!drag) return;
      const press = drag;
      drag = null;
      map.classList.remove('egd-minimap-dragging');
      ev.preventDefault();
      ev.stopPropagation();
      if (!press.moved) openMinimapTargets(panel, press.targets, press.local);
    }, true);
  }

  function toggleDeskMinimap() {
    if (state.cardFullscreen) return;
    const existing = document.getElementById('egd-desk-minimap');
    if (existing) {
      closeDeskMinimap();
      return;
    }
    const panel = el('div', { id: 'egd-desk-minimap', class: 'egd-edge egd-frosted' },
      el('div', { class: 'egd-minimap-header' },
        el('div', { class: 'egd-minimap-title' }, '미니맵'),
        el('button', { class: 'egd-minimap-close', title: '닫기', onclick: closeDeskMinimap }, '×'),
      ),
      el('div', { class: 'egd-minimap-map' }),
      el('div', { class: 'egd-minimap-caption' }, SurfaceState.deskMinimapCaption(1, 0)),
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

  // Four quiet host-resource marks live in viewport chrome, never in Canvas or Chat.
  // Values come only from the protected local bridge; unavailable is not zero.
  let resourceGadget = null;
  function buildResourceGadget() {
    if (resourceGadget) return resourceGadget;
    const specs = [
      { id: 'cpu', label: 'CPU' },
      { id: 'memory', label: '메모리' },
      { id: 'disk', label: '디스크' },
      { id: 'network', label: '네트워크' },
    ];
    const gadget = el('div', { class: 'egd-resource-gadget', role: 'group', 'aria-label': '이 컴퓨터의 자원 사용량' });
    resourceGadget = gadget;
    const detail = el('section', {
      class: 'egd-resource-detail', id: 'egd-resource-detail', role: 'group',
      'aria-label': '자원 사용량 상세', hidden: true,
    });
    let snapshot = null;
    let opened = null;
    let pending = null;
    let timer = null;
    let disposed = false;
    let refreshOnResume = false;
    const pollMs = 5000;
    const staleMs = 15000;
    const requestTimeoutMs = 4000;
    const buttons = new Map();
    const metricReady = (metric) => metric?.status === 'ok';
    const numeric = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const size = (bytes) => {
      if (!numeric(bytes)) return '—';
      if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
      if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
      if (bytes < 1024) return `${Math.round(bytes)} B`;
      return `${Math.round(bytes / 1024)} KiB`;
    };
    const rate = (bytes) => numeric(bytes) ? `${size(bytes)}/s` : '—';
    const percent = (metric) => metricReady(metric) && numeric(metric.percent)
      ? `${Math.round(metric.percent)}%` : '—';
    const title = (id) => id === 'memory' ? '메모리 사용(캐시 포함)' : specs.find(spec => spec.id === id)?.label || id;
    const rows = (id, metric) => {
      if (!metricReady(metric)) return [['상태', metric?.status === 'warming' ? '측정 준비 중' : '측정할 수 없음']];
      if (id === 'cpu') return [
        ['사용률', percent(metric)],
        ['기준', metric.basis === 'all-logical-cores' ? '전체 논리 코어' : '기준 미확인'],
        ['측정 구간', numeric(metric.intervalMs) ? `${Math.round(metric.intervalMs)} ms` : '—'],
      ];
      if (id === 'memory') return [
        ['사용량(캐시 포함)', size(metric.usedBytes)],
        ['전체', size(metric.totalBytes)],
        ['사용률', percent(metric)],
        ['기준', metric.basis === 'total-minus-os-free' ? '전체 − OS 여유 메모리 (캐시 포함)' : '기준 미확인'],
      ];
      if (id === 'disk') return [
        ['저장 공간', `${size(metric.usedBytes)} / ${size(metric.totalBytes)}`],
        ['사용률', percent(metric)],
        ['대상', metric.target === 'profile-volume' ? 'EG-Desk 데이터 저장 볼륨' : '대상 미확인'],
      ];
      return [
        ['수신', rate(metric.rxBytesPerSecond)],
        ['송신', rate(metric.txBytesPerSecond)],
        ['인터페이스', typeof metric.interface === 'string' && metric.interface ? metric.interface : '미확인'],
        ['측정 구간', numeric(metric.intervalMs) ? `${Math.round(metric.intervalMs)} ms` : '—'],
      ];
    };
    const discardStale = () => {
      if (!snapshot) return;
      const sampleTime = Date.parse(snapshot.sampledAt);
      const age = Date.now() - sampleTime;
      if (!Number.isFinite(sampleTime) || age > staleMs || age < -2000) snapshot = null;
    };
    const renderDetail = () => {
      if (!opened) return;
      const metric = snapshot?.[opened];
      const sampledAt = snapshot?.sampledAt && !Number.isNaN(Date.parse(snapshot.sampledAt))
        ? new Date(snapshot.sampledAt).toLocaleTimeString('ko-KR') : '측정 시각 미확인';
      detail.replaceChildren(
        el('div', { class: 'egd-resource-detail-title' }, title(opened)),
        el('p', { class: 'egd-resource-detail-scope' }, `${opened === 'network' ? '기본 네트워크 연결' : '이 컴퓨터'} · ${sampledAt}`),
        el('dl', {}, ...rows(opened, metric).map(([label, value]) =>
          el('div', { class: 'egd-resource-detail-row' }, el('dt', {}, label), el('dd', {}, value)))),
      );
    };
    const render = () => {
      discardStale();
      for (const spec of specs) {
        const button = buttons.get(spec.id);
        const metric = snapshot?.[spec.id];
        const value = spec.id === 'network'
          ? metricReady(metric) ? `수신 ${rate(metric.rxBytesPerSecond)}, 송신 ${rate(metric.txBytesPerSecond)}` : '측정 대기'
          : percent(metric);
        const label = spec.id === 'memory' ? '메모리 사용(캐시 포함)' : spec.label;
        button.setAttribute('aria-label', `${label} ${value}, 상세 보기`);
        button.title = `${label} · ${value}`;
        const ring = button.querySelector('.egd-resource-ring');
        if (spec.id !== 'network') {
          const measured = metricReady(metric) && numeric(metric.percent);
          ring.style.setProperty('--egd-resource-fill', measured ? `${Math.min(100, metric.percent)}%` : '0%');
          ring.classList.toggle('egd-resource-unmeasured', !measured);
        } else ring.classList.toggle('egd-resource-unmeasured', !metricReady(metric));
      }
      renderDetail();
    };
    const close = (restoreFocus = false) => {
      if (!opened) return;
      const prior = buttons.get(opened);
      opened = null;
      detail.hidden = true;
      for (const button of buttons.values()) button.setAttribute('aria-expanded', 'false');
      if (restoreFocus) prior?.focus();
    };
    for (const spec of specs) {
      const ring = el('span', { class: `egd-resource-ring egd-resource-${spec.id} egd-resource-unmeasured`, 'aria-hidden': 'true' },
        spec.id === 'network' ? '↕' : null);
      const button = el('button', {
        type: 'button', class: 'egd-resource-button', title: `${title(spec.id)} · 측정 대기`,
        'aria-label': `${title(spec.id)} 측정 대기, 상세 보기`,
        'aria-controls': 'egd-resource-detail', 'aria-expanded': 'false',
        onclick: (event) => {
          event.stopPropagation();
          if (opened === spec.id) { close(); return; }
          opened = spec.id;
          detail.hidden = false;
          for (const [id, control] of buttons) control.setAttribute('aria-expanded', String(id === opened));
          render();
        },
      }, ring);
      buttons.set(spec.id, button);
      gadget.appendChild(button);
    }
    gadget.appendChild(detail);
    const onOutside = (event) => { if (opened && !gadget.contains(event.target)) close(); };
    const onKeydown = (event) => { if (opened && event.key === 'Escape') { event.stopPropagation(); close(true); } };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKeydown, true);
    const refresh = async () => {
      if (disposed || document.hidden || pending) return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await fetch('http://127.0.0.1:39218/system/resources', {
          method: 'GET', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error(`resource status ${response.status}`);
        const payload = await response.json();
        snapshot = payload?.version === 1 && payload.scope === 'host' ? payload : null;
      } catch {
        if (!disposed) snapshot = null;
      } finally {
        window.clearTimeout(timeout);
        if (pending === controller) pending = null;
        if (!disposed) {
          render();
          if (!document.hidden) {
            timer = window.setTimeout(refresh, refreshOnResume ? 0 : pollMs);
            refreshOnResume = false;
          }
        }
      }
    };
    const onWake = () => {
      if (disposed) return;
      if (document.hidden) {
        if (timer) window.clearTimeout(timer);
        timer = null;
        if (pending) {
          refreshOnResume = true;
          pending.abort();
        }
        return;
      }
      render();
      if (!pending) {
        if (timer) window.clearTimeout(timer);
        timer = null;
        refreshOnResume = false;
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('unload', () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      pending?.abort();
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    }, { once: true });
    void refresh();
    return gadget;
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
        el('span', { class: 'egd-rail-desk-name egd-rail-agenda-name' }, viewportBoardLabel().text),
        el('span', { class: 'egd-rail-dirty-badge', hidden: !state.agenda.dirty }, '저장 안 됨'),
        el('span', { class: 'egd-rail-card-badge', hidden: true }),
        el('span', { class: 'egd-rail-chevron' }, deskIcon('chevron')),
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
        el('span', { class: 'egd-rail-search-icon' }, deskIcon('search')),
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
      }, deskIcon('check')),
      el('button', {
        class: 'egd-rail-icon egd-rail-restore-btn',
        title: '저장된 Board 열기',
        'aria-label': '저장된 Board 열기',
        hidden: !state.agenda.hasSavedState,
        onclick: (ev) => {
          ev.stopPropagation();
          restoreSavedAgendaState();
        },
      }, deskIcon('recovery')),
      el('button', {
        class: 'egd-rail-icon egd-rail-close-agenda-btn',
        title: 'Board 닫기',
        'aria-label': '선택한 Board 닫기',
        onclick: (ev) => {
          ev.stopPropagation();
          closeCurrentAgenda();
        },
      }, deskIcon('close')),
      el('button', { class: 'egd-rail-icon', title: '미니맵', 'aria-label': '미니맵', onclick: toggleDeskMinimap }, deskIcon('minimap')),
      el('button', { id: 'egd-recovery-open', class: 'egd-rail-icon', 'aria-label': '복구 기록', title: '복구 기록', hidden: true, onclick: () => renderDeskRecoveryNotice(true) }, deskIcon('recovery')),
      el('button', { class: 'egd-rail-icon', title: '알림 연결 전', 'aria-label': '알림 연결 전', disabled: 'true' }, deskIcon('alert')),
      buildResourceGadget(),
      el('div', { class: 'egd-rail-avatar', title: '로컬 Desk', 'aria-label': '로컬 Desk' }, deskIcon('account')),
    );

    rail.appendChild(left);
    rail.appendChild(center);
    rail.appendChild(right);
    queueMicrotask(syncViewportAgendaRail);
    return rail;
  }

  // ============ Bottom: Dock ============
  function buildDock() {
    const dock = el('div', {
      id: 'egd-dock',
      class: 'egd-edge egd-frosted',
      role: 'region',
      'aria-label': 'Desk 도구 모음',
      tabindex: '0',
    });

    const makeGroup = (items, kind) => {
      const g = el('div', { class: `egd-dock-group egd-dock-${kind}` });
      for (const item of items) {
        const btn = el('button', {
          class: 'egd-dock-btn' + (kind === 'center' && state.activeTool === item.id ? ' egd-dock-btn-active' : ''),
          title: item.label,
          data: { id: item.id, kind, ...(item.id === 'shelf' ? { testid: 'file-dock-open' } : {}) },
          'aria-label': item.label,
          // The chosen tool is also said as a pressed state, not only by its tint.
          'aria-pressed': kind === 'center' ? String(state.activeTool === item.id) : null,
          onclick: () => {
            if (kind === 'center') {
              state.activeTool = item.id;
              syncActiveToolMode();
              for (const b of g.querySelectorAll('.egd-dock-btn')) {
                b.classList.toggle('egd-dock-btn-active', b.dataset.id === item.id);
                b.setAttribute('aria-pressed', String(b.dataset.id === item.id));
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
                dismissChatReturnCue();
                state.codex.hudView = 'conversation';
                const chatCard = spawnCodexChatCard();
                state.codexBridge?.selectThread(state.codex.activeThreadId, { openConversation: true });
                // The human Dock intent is already to open Chat. If the
                // settled camera would show only its semantic proxy, use the
                // proxy's existing focus-to-readable path without another click.
                state.focusChatDockIfCompact?.(chatCard);
              } else {
                toggleHUD(item.id, item.label);
              }
            } else if (kind === 'right' && item.id === 'trash') {
              deleteSelectedEntities();
            }
          },
        }, el('span', { class: 'egd-dock-icon' }, deskIcon(item.icon)));
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

    bag.appendChild(el('div', { class: 'egd-bag-header', title: 'Desk 도구' },
      deskIcon('desk'), el('span', {}, 'Desk')));
    bag.appendChild(el('span', { class: 'egd-bag-divider', 'aria-hidden': 'true' }));
    bag.appendChild(el('button', { class: 'egd-bag-chip egd-bag-file', title: '파일 작업 열기', 'aria-label': '파일 작업 열기',
      data: { testid: 'file-sidebar-open' }, onclick: () => spawnFileCard() }, deskIcon('folder'), el('span', {}, '파일')));

    const list = el('div', { class: 'egd-bag-list' });
    for (const preset of PRESETS) {
      const chip = el('button', {
        class: 'egd-bag-chip',
        title: `${preset.name} · ${preset.count}개 항목`,
        data: { id: preset.id },
      }, deskIcon({ 'react-dev': 'ide', meeting: 'users', research: 'search', writing: 'pencil' }[preset.id] || 'desk'), el('span', {}, preset.label));
      list.appendChild(chip);
    }
    list.appendChild(el('button', { class: 'egd-bag-add', title: '새 프리셋', 'aria-label': '새 프리셋' }, deskIcon('plus')));
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
        if (current && !ChatState.nativeBindingHeld(current)) {
          return openCodexResultLink(artifact, { opener: container.closest?.('.egd-chat-card') || null });
        }
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

  // /v1/state `bridge` is { buildHash, startedAt, sourceMismatch }. An older
  // bridge omits it and reads as matching. A successful read also clears the
  // reconnect count and the raw error.
  function bridgeConnectionFields(bridgeState) {
    const bridge = bridgeState?.bridge;
    return {
      bridgeFailures: 0,
      bridgeError: null,
      bridgeBuild: bridge && typeof bridge === 'object' ? {
        buildHash: typeof bridge.buildHash === 'string' ? bridge.buildHash : null,
        startedAt: Number.isFinite(bridge.startedAt) ? bridge.startedAt : null,
        sourceMismatch: bridge.sourceMismatch === true,
      } : null,
    };
  }

  // CHAT-09/CU-07: /v1/state capabilities.chat and inheritedMcp, kept as
  // reported. An older bridge sends neither: no one-time start or branching,
  // and the inherited tool list reads '확인할 수 없음'.
  function bridgeSessionFields(bridgeState) {
    const chat = bridgeState?.capabilities?.chat;
    return {
      chatCapabilities: Array.isArray(chat) ? chat.filter((name) => typeof name === 'string') : null,
      inheritedMcp: Array.isArray(bridgeState?.inheritedMcp) ? bridgeState.inheritedMcp : null,
    };
  }

  // RT-05: the helper build this overlay was installed with. The launcher
  // writes the marker; an overlay installed without it sends nothing, and the
  // bridge then never reports a mismatch.
  const OVERLAY_BUILD_MARKER_URL = 'chrome://userchrome/content/egdesk-bridge-build.json';
  function readExpectedOverlayBuild(load = fetch) {
    return Promise.resolve()
      .then(() => load(OVERLAY_BUILD_MARKER_URL, { cache: 'no-store' }))
      .then((response) => (response?.ok ? response.json() : null))
      .then((marker) => {
        const value = typeof marker?.buildHash === 'string' ? marker.buildHash.trim().toLowerCase() : '';
        return /^[a-f0-9]{64}$/.test(value) ? value : null;
      })
      .catch(() => null);
  }

  function overlayBuildHeaders(buildHash) {
    return typeof buildHash === 'string' && /^[a-f0-9]{64}$/.test(buildHash) ? { 'X-EGDesk-Overlay-Build': buildHash } : {};
  }

  // /v1/state engines[] rows and the verified Codex launch model, kept as
  // reported; ChatState reads them (older bridges send neither).
  function bridgeEngineFields(bridgeState) {
    return {
      engines: Array.isArray(bridgeState?.engines) ? bridgeState.engines : null,
      engineConfiguration: bridgeState?.engineConfiguration && typeof bridgeState.engineConfiguration === 'object' ? bridgeState.engineConfiguration : null,
    };
  }

  function codexBridgeNotice(codex) {
    return SurfaceState.bridgeConnectionNotice({
      connected: codex.connected,
      failures: codex.bridgeFailures,
      error: codex.bridgeError,
      latencyMs: codex.lastBridgeLatency,
      bridge: codex.bridgeBuild,
    });
  }

  function codexBridgeSummary(codex) {
    return codexBridgeNotice(codex).text;
  }

  // The bridge state in one line; the raw error and timing stay folded under
  // '자세히', which keeps its open state across re-renders.
  function buildCodexBridgeNotice(codex, codexBridge) {
    const notice = codexBridgeNotice(codex);
    if (notice.state === 'online') return null;
    return el('div', {
      class: `egd-codex-connection egd-codex-connection-${notice.state}`,
      role: 'status',
      data: { testid: 'chat-bridge-connection', bridgeState: notice.state },
    },
      el('div', { class: 'egd-codex-connection-row' },
        el('span', { class: 'egd-codex-connection-text' }, notice.text),
        notice.action ? el('button', {
          class: 'egd-codex-chip egd-codex-chip-subtle',
          onclick: () => codexBridge.reconnectNow?.(),
        }, notice.action) : null,
      ),
      notice.details.length ? el('details', {
        class: 'egd-codex-connection-details',
        open: state.codex.showBridgeDetails ? '' : null,
        ontoggle: (ev) => { state.codex.showBridgeDetails = ev.currentTarget.open === true; },
      }, el('summary', {}, '자세히'), el('pre', {}, notice.details.join('\n'))) : null,
    );
  }

  function mountCodexHUD(body, codexBridge, options = {}) {
    let unsubscribe = null;
    let composerObserver = null;
    let compositionInProgress = false;
    let deferredCodex = null;
    let pendingMessageScroll = null;
    let focusOpenedRoom = false;
    const mode = options.mode || 'hud';
    // A room opened from the keyboard hands focus to its conversation, so the
    // list leaving the screen does not drop focus onto the page.
    const openRoomFromKeyboard = (threadId) => {
      focusOpenedRoom = true;
      try { codexBridge.selectThread(threadId, { openConversation: true }); } finally { focusOpenedRoom = false; }
    };
    const closeFloatingMenus = () => {
      codexBridge.closeMemberMenu();
      codexBridge.closeThreadMenu();
      codexBridge.closeEngineMenu();
      codexBridge.closeMessageMenu?.();
      codexBridge.closeAgentPeek?.();
    };
    const onMessageScrollGesture = (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const log = target.closest('.egd-codex-messages');
      if (!log || !body.contains(log)) return;
      if (ev.type === 'keydown' && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar'].includes(ev.key)) return;
      if (ev.type === 'wheel' && (!ev.deltaY || ev.ctrlKey)) return;
      // A deliberate log interaction wins over an unpainted automatic restore.
      pendingMessageScroll = null;
    };
    const onDocumentMouseDown = (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      onMessageScrollGesture(ev);
      if (target.closest('.egd-codex-thread-member-menu')) return;
      if (target.closest('.egd-codex-thread-member-clickable')) return;
      if (target.closest('.egd-codex-thread-menu')) return;
      if (target.closest('.egd-codex-thread-menu-trigger')) return;
      if (target.closest('.egd-codex-message-menu-trigger')) return;
      if (target.closest('.egd-codex-engine-panel, .egd-codex-engine-chip')) return;
      if (target.closest('.egd-codex-agent-peek, .egd-codex-agent-peek-trigger')) return;
      closeFloatingMenus();
    };
    const onViewportMutate = (ev) => {
      if (ev.type === 'wheel') onMessageScrollGesture(ev);
      closeFloatingMenus();
    };
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('wheel', onViewportMutate, { capture: true, passive: true });
    window.addEventListener('resize', onViewportMutate);
    body.addEventListener('keydown', onMessageScrollGesture, true);
    body.addEventListener('pointerdown', onMessageScrollGesture, true);

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
      // Repeated SSE renders can replace this log before its rAF restore runs.
      // Carry the intended viewport instead of sampling its temporary scrollTop=0.
      const messageState = pendingMessageScroll?.element === oldMessages
        ? pendingMessageScroll.state
        : oldMessages ? {
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
      pendingMessageScroll = null;
      composerObserver?.disconnect();
      composerObserver = null;
      const focusState = chatFocusSnapshot(body, document.activeElement);
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

      // While the bridge is not online the connection notice says the state;
      // the chip row then carries only the account.
      const bridgeNotice = codexBridgeNotice(codex);
      const statusBridge = bridgeNotice.state !== 'online'
        ? null
        : (codex.error ? 'Codex 점검 필요' : 'Codex 연결됨');
      const statusAccount = codex.authStatus.isLoggedIn
        ? '로그인됨'
        : ((codex.isStartingLogin || codex.authStatus.loginInProgress) ? '로그인 중…' : '로그인 필요');
      const indicatorState = bridgeNotice.state === 'reconnecting'
        ? 'idle'
        : (bridgeNotice.state !== 'online' || codex.error ? 'error' : 'ok');
      const connectionNotice = buildCodexBridgeNotice(codex, codexBridge);

      const chromeActions = [];
      if (!codex.authStatus.isLoggedIn) {
        chromeActions.push(el('button', {
          class: 'egd-codex-chip egd-codex-chip-primary',
          disabled: (codex.isStartingLogin || codex.authStatus.loginInProgress) ? 'true' : null,
          onclick: () => codexBridge.startLogin(),
        }, (codex.isStartingLogin || codex.authStatus.loginInProgress) ? '로그인 중…' : '로그인'));
      }
      if (codex.error && codex.connected) {
        chromeActions.push(el('button', {
          class: 'egd-codex-chip egd-codex-chip-subtle',
          onclick: () => codexBridge.refreshAuthStatus(),
        }, '새로고침'));
      }
      const chromeRow = el('div', { class: 'egd-codex-chrome-row' },
        el('div', { class: 'egd-codex-chrome-main' },
          el('span', { class: `egd-codex-chrome-indicator egd-codex-chrome-indicator-${indicatorState}` }),
          el('div', { class: 'egd-codex-chrome-status' },
            statusBridge ? el('span', { class: `egd-codex-system-chip egd-codex-system-chip-${indicatorState}` }, statusBridge) : null,
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
            el('div', { class: 'egd-codex-thread-session-pill' }, `Board ${groupThreads.length}`),
            el('div', { class: 'egd-codex-thread-session-pill' }, `안 읽음 ${unreadCountTotal}`),
          ),
        ));
      }

      const threadSearch = el('input', {
        type: 'text',
        class: 'egd-codex-thread-search',
        value: codex.threadQuery || '',
        placeholder: '대화방 찾기',
        'aria-label': '대화방 찾기',
        data: { focusKey: 'room-search' },
      });
      // Each filtered render replaces this input; the caret comes back through
      // its focus key. A Korean syllable in composition is filtered once it ends.
      threadSearch.addEventListener('input', (ev) => {
        if (ev.isComposing || compositionInProgress) return;
        codexBridge.setThreadQuery(threadSearch.value);
      });
      threadSearch.addEventListener('compositionstart', () => { compositionInProgress = true; });
      threadSearch.addEventListener('compositionend', () => {
        compositionInProgress = false;
        const next = deferredCodex;
        deferredCodex = null;
        queueMicrotask(() => {
          if (!threadSearch.isConnected) return;
          if (threadSearch.value !== (codex.threadQuery || '')) codexBridge.setThreadQuery(threadSearch.value);
          else if (next) render(next);
        });
      });
      threadTop.appendChild(threadSearch);

      const threadFilter = normalizeThreadFilter(codex.threadFilter);
      const filterRow = el('div', { class: 'egd-codex-thread-filter-row' });
      const filterDefs = [
        { key: 'all', label: '전체' },
        { key: 'dm', label: 'Agent' },
        { key: 'group', label: 'Board' },
      ];
      for (const filterDef of filterDefs) {
        const selected = threadFilter === filterDef.key;
        filterRow.appendChild(el('button', {
          class: `egd-codex-thread-filter-chip${selected ? ' egd-codex-thread-filter-chip-active' : ''}`,
          'aria-pressed': String(selected),
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
          el('div', { class: 'egd-codex-thread-menu-label' }, 'Agent'),
          el('button', {
            class: `egd-codex-thread-menu-item${thread.profileEnabled !== true ? ' egd-codex-thread-menu-item-active' : ''}`, 'aria-label': '기본 Codex 선택',
            onclick: () => codexBridge.setThreadAgentProfile(thread.id, null),
          }, '기본 Codex'),
          ...codexAgentProfileChoices().map((profile) => el('button', {
            class: `egd-codex-thread-menu-item egd-codex-thread-menu-profile${thread.profileEnabled === true && profile.id === activeProfile.id ? ' egd-codex-thread-menu-item-active' : ''}`,
            title: profile.summary,
            onclick: () => codexBridge.setThreadAgentProfile(thread.id, profile.id),
          },
          profile.server ? codexProfileAvatar(profile.avatar, profile.name, 'egd-codex-thread-menu-avatar') : null,
          el('span', { class: 'egd-codex-thread-menu-profile-label' }, profile.label),
          el('span', { class: 'egd-codex-thread-menu-profile-name' }, profile.server ? profile.role || '' : profile.name),
          )),
          // The room's own Agent stays visible while it cannot be chosen again.
          thread.profileEnabled === true && activeProfile.server && activeProfile.revision === null
            ? el('div', { class: 'egd-codex-thread-menu-note', role: 'note' }, `${activeProfile.name} · 지금 쓸 수 없음`) : null,
          el('button', {
            class: 'egd-codex-thread-menu-item',
            onclick: () => { codexBridge.closeThreadMenu(); spawnSettingsCard({ tab: 'agents' }); },
          }, 'Agent 관리 열기'),
          ...renderForkMenuItems(thread, null, '대화 분기', '지금까지의 대화를 새 대화방으로 이어 갑니다.'),
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

      // The room's AI engine (SUB-07): a badge in the room list, a header chip
      // that opens the engine/model/effort panel, and the new-room choices.
      const engineContext = { recentEngineId: codex.recentEngineId, engines: codex.engines,
        auth: codex.authStatus, engineConfiguration: codex.engineConfiguration };
      const renderEngineBadge = (thread) => {
        const view = ChatState.chatEngineChipView(thread, engineContext);
        return el('span', { class: 'egd-codex-engine-badge', title: view.title, data: { engine: view.engineId } }, view.label);
      };
      const renderEngineChip = (thread) => {
        const view = ChatState.chatEngineChipView(thread, engineContext);
        const open = codex.engineMenu?.threadId === thread.id;
        return el('button', {
          class: `egd-codex-engine-chip${open ? ' egd-codex-engine-chip-open' : ''}`,
          title: view.title, 'aria-label': `${view.title} · AI 엔진과 추론 강도 선택`,
          'aria-haspopup': 'dialog', 'aria-expanded': open ? 'true' : 'false',
          data: { testid: 'chat-engine-chip', engine: view.engineId, locked: view.locked ? 'true' : 'false' },
          onclick: (ev) => {
            ev.stopPropagation();
            codexBridge.toggleEngineMenu(thread.id, ev.currentTarget);
          },
        }, el('span', { class: 'egd-codex-engine-chip-text' }, view.text), deskIcon('chevron', 'egd-codex-engine-chip-icon'));
      };
      const renderEngineChoices = (thread) => {
        const current = ChatState.chatThreadEngineId(thread, engineContext);
        return el('div', { class: 'egd-codex-engine-choices', role: 'radiogroup', 'aria-label': 'AI 엔진' },
          ...ChatState.chatEngineChoices(codex.engines, codex.authStatus).map((choice) => el('button', {
            class: `egd-codex-engine-choice${choice.id === current ? ' egd-codex-engine-choice-selected' : ''}`,
            role: 'radio', 'aria-checked': choice.id === current ? 'true' : 'false',
            disabled: choice.selectable ? null : 'true',
            data: { testid: 'chat-engine-choice', engine: choice.id },
            onclick: () => codexBridge.setThreadEngine(thread.id, choice.id),
          },
          el('span', { class: 'egd-codex-engine-choice-name' }, choice.label),
          el('span', { class: 'egd-codex-engine-choice-note' }, [choice.account, choice.note].filter(Boolean).join(' · ')),
          choice.id === current ? deskIcon('check', 'egd-codex-engine-choice-check') : null)));
      };
      const renderEnginePanel = (thread) => {
        const engineId = ChatState.chatThreadEngineId(thread, engineContext);
        const choice = ChatState.chatEngineChoices(codex.engines, codex.authStatus).find((row) => row.id === engineId) || null;
        const label = choice?.label || engineId;
        // The account's models when the bridge lists them; each model offers only its own efforts.
        const modelView = ChatState.chatModelView(thread, { ...engineContext, engineId });
        const effort = modelView.effort;
        const effortChoices = modelView.effortChoices;
        const modelSection = modelView.listed
          ? el('div', { class: 'egd-codex-engine-models', role: 'radiogroup', 'aria-label': '모델', data: { testid: 'chat-engine-models' } },
            ...modelView.modelChoices.map((option) => el('button', {
              class: `egd-codex-engine-model-choice${option.selected ? ' egd-codex-engine-model-choice-selected' : ''}`,
              role: 'radio', 'aria-checked': option.selected ? 'true' : 'false',
              title: option.note ? `${option.label} · ${option.note}` : option.label,
              data: { testid: 'chat-engine-model', model: option.id || 'default' },
              onclick: () => codexBridge.setThreadModel(thread.id, option.value),
            },
            el('span', { class: 'egd-codex-engine-model-name' }, option.label),
            option.note ? el('span', { class: 'egd-codex-engine-model-note' }, option.note) : null,
            option.selected ? deskIcon('check', 'egd-codex-engine-model-check') : null)))
          : el('div', { class: 'egd-codex-engine-model' }, ChatState.chatModelLabel(codex.engineConfiguration));
        const effortColumns = effortChoices.length <= 4 ? effortChoices.length : effortChoices.length <= 6 ? 3 : 4;
        // D3: a room that has started keeps its engine; switching means a new room.
        const engineSection = ChatState.chatThreadEngineLocked(thread)
          ? el('div', { class: 'egd-codex-engine-locked' },
            el('div', { class: 'egd-codex-engine-locked-row' },
              deskIcon('lock', 'egd-codex-engine-locked-icon'),
              el('span', { class: 'egd-codex-engine-choice-name' }, label),
              choice?.account ? el('span', { class: 'egd-codex-engine-choice-note' }, choice.account) : null),
            el('p', { class: 'egd-codex-engine-hint' }, `이 대화는 ${label}로 이어집니다. 다른 AI로 바꾸려면 새 대화로 이어가세요.`),
            el('button', {
              class: 'egd-codex-chip egd-codex-chip-subtle', data: { testid: 'chat-engine-continue' },
              onclick: () => codexBridge.continueInNewThread(thread.id),
            }, '새 대화로 이어가기'))
          : renderEngineChoices(thread);
        return el('div', {
          class: 'egd-codex-engine-panel', role: 'dialog', 'aria-label': 'AI 엔진 설정',
          data: { testid: 'chat-engine-panel' },
          style: {
            left: `${Math.round(codex.engineMenu?.left ?? 12)}px`,
            top: `${Math.round(codex.engineMenu?.top ?? 12)}px`,
          },
          onclick: (ev) => ev.stopPropagation(),
        },
        el('div', { class: 'egd-codex-engine-section-label' }, 'AI 엔진'),
        engineSection,
        el('div', { class: 'egd-codex-engine-section-label' }, '모델'),
        modelSection,
        effortChoices.length ? el('div', { class: 'egd-codex-engine-section-label' }, '추론 강도') : null,
        effortChoices.length ? el('div', { class: 'egd-codex-engine-efforts', role: 'radiogroup', 'aria-label': '추론 강도', data: { columns: String(effortColumns) } },
          ...effortChoices.map((option) => el('button', {
            class: `egd-codex-engine-effort${option.value === effort ? ' egd-codex-engine-effort-selected' : ''}`,
            role: 'radio', 'aria-checked': option.value === effort ? 'true' : 'false',
            title: option.isDefault ? `${option.label} · 이 모델의 기본 강도` : null,
            data: { testid: 'chat-engine-effort', effort: option.value || 'default' },
            onclick: () => codexBridge.setThreadEffort(thread.id, option.value),
          }, option.label))) : null,
        effortChoices.length || modelView.listed ? el('p', { class: 'egd-codex-engine-hint' }, '다음에 보내는 메시지부터 적용됩니다.') : null);
      };

      // CHAT-07: the profile peek for one Agent answer. The room Agent's saved
      // settings load when it opens; the model line is the engine chip's text.
      const renderAgentPeek = (thread, message) => {
        const peek = codex.agentPeek || {};
        const profile = thread.profileEnabled === true ? codexThreadAgentProfile(thread) : null;
        const entry = profile?.server === true ? codexBridge.agentProfileDetail(profile.id, profile.revision) : null;
        const view = ChatState.agentPeekView({
          author: codexMessageAuthorLabel(message), authorAvatar: message.authorAvatar || null, profile,
          detail: entry?.detail || null, detailStatus: entry?.status || 'idle',
          modelText: ChatState.chatEngineChipView(thread, engineContext).text,
          boardTitle: state.agenda?.activeTitle || '', threadType: thread.type,
        });
        const returnFocus = () => {
          const key = peek.returnFocusKey || `agent-peek-face-${message.id}`;
          [...body.querySelectorAll('[data-focus-key]')].find((node) => node.dataset.focusKey === key)?.focus({ preventScroll: true });
        };
        return codexAgentPeekPanel(view, {
          left: peek.left ?? 12, top: peek.top ?? 12,
          onClose: () => { codexBridge.closeAgentPeek(); returnFocus(); },
          onOpenSettings: () => {
            codexBridge.closeAgentPeek();
            spawnSettingsCard({ tab: 'agents', ...(view.profileId ? { profileId: view.profileId } : {}) });
          },
          onOpenActivity: () => { codexBridge.closeAgentPeek(); codexBridge.openActivity(thread.id); },
        });
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

      // CHAT-09: branch actions in the room and message menus, the message
      // menu itself, and the '기록 없이 시작' switch on a new room. A branch
      // that cannot run now stays visible, disabled, with its reason.
      const renderForkMenuItems = (thread, fromTurnId, label, hint) => {
        const fork = codexBridge.forkAvailability(thread.id, fromTurnId);
        return [
          el('button', {
            class: 'egd-codex-thread-menu-item',
            disabled: fork.available ? null : 'true', 'aria-disabled': fork.available ? null : 'true',
            data: { testid: fromTurnId ? 'chat-fork-message' : 'chat-fork-thread' },
            onclick: () => { void codexBridge.forkThread(thread.id, fromTurnId ? { fromTurnId } : {}); },
          }, label),
          el('div', { class: 'egd-codex-thread-menu-note', role: 'note' }, fork.available ? hint : fork.reason),
        ];
      };
      const renderMessageMenu = (thread, message) => el('div', {
        class: 'egd-codex-thread-menu egd-codex-message-menu', role: 'group', 'aria-label': '메시지 메뉴',
        data: { testid: 'chat-message-menu', messageId: message.id },
        style: {
          left: `${Math.round(codex.messageMenu?.left ?? 12)}px`,
          top: `${Math.round(codex.messageMenu?.top ?? 12)}px`,
        },
        onclick: (ev) => ev.stopPropagation(),
      },
      ...renderForkMenuItems(thread, message.runId, '이 지점에서 분기', message.role === 'user'
        ? '이 요청과 그 응답까지의 대화를 새 대화방으로 이어 갑니다.' : '이 응답까지의 대화를 새 대화방으로 이어 갑니다.'),
      el('button', { class: 'egd-codex-thread-menu-item', onclick: () => codexBridge.closeMessageMenu() }, '닫기'));
      const renderMessageMenuTrigger = (thread, message) => {
        if (!ChatState.chatMessageForkPoint(thread, message)) return null;
        const open = codex.messageMenu?.threadId === thread.id && codex.messageMenu.messageId === message.id;
        return el('button', {
          class: `egd-codex-message-menu-trigger${open ? ' egd-codex-message-menu-trigger-active' : ''}`,
          type: 'button', title: '메시지 메뉴', 'aria-label': '메시지 메뉴',
          'aria-expanded': open ? 'true' : 'false',
          data: { testid: 'chat-message-menu-open', focusKey: `message-menu-${message.id}` },
          onclick: (ev) => {
            ev.stopPropagation();
            codexBridge.toggleMessageMenu(thread.id, message.id, ev.currentTarget);
          },
        }, '⋯');
      };
      const renderStatelessStart = (thread) => {
        const view = ChatState.chatStatelessStartView(thread, codex.chatCapabilities);
        return el('div', { class: 'egd-codex-stateless-start', data: { testid: 'chat-stateless-start', state: view.on ? 'on' : 'off' } },
          el('button', {
            class: `egd-codex-stateless-toggle${view.on ? ' egd-codex-stateless-toggle-on' : ''}`,
            type: 'button', role: 'switch', 'aria-checked': view.on ? 'true' : 'false',
            disabled: view.available ? null : 'true',
            data: { testid: 'chat-stateless-toggle', focusKey: 'stateless-start' },
            onclick: () => codexBridge.setThreadStateless(thread.id, !view.on),
          },
          el('span', { class: 'egd-codex-stateless-switch', 'aria-hidden': 'true' }),
          el('span', { class: 'egd-codex-stateless-label' }, '기록 없이 시작')),
          el('p', { class: 'egd-codex-engine-hint' }, view.note));
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
            'aria-current': activeThread && thread.id === activeThread.id ? 'true' : null,
            role: 'button',
            tabindex: '0',
            'aria-label': codexThreadRowLabel(thread),
            data: { focusKey: `room-${thread.id}` },
          });
          item.addEventListener('click', () => codexBridge.selectThread(thread.id, { openConversation: true }));
          bindChatRoomRowKeys(item, () => openRoomFromKeyboard(thread.id));
          const lastMsg = thread.messages && thread.messages.length > 0 ? thread.messages[thread.messages.length - 1] : null;
          const lastTime = lastMsg && lastMsg.createdAt ? formatRelativeTime(lastMsg.createdAt) : '';
          const kindMeta = codexThreadKindMeta(thread.type);
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
                    buildCodexSessionBadge(thread, codexBridge),
                    renderEngineBadge(thread),
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
                      'aria-label': `${thread.title} 채팅방 메뉴`,
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
            }, deskIcon('back')),
            el('div', { class: 'egd-codex-conversation-hud-center' },
              el('div', { class: 'egd-codex-conversation-hud-title' }, activeThread.title),
              activeThread.type === 'group'
                ? el('div', { class: 'egd-codex-conversation-hud-sub' }, (activeThread.participants || []).join(' · '))
                : null,
              el('div', { class: 'egd-codex-conversation-hud-badges' }, buildCodexSessionBadge(activeThread, codexBridge)),
            ),
            renderEngineChip(activeThread),
            codexUsageRing(codex.authStatus),
            el('button', {
              class: `egd-codex-conversation-menu-trigger${threadMenuOpen ? ' egd-codex-conversation-menu-trigger-active' : ''}`,
              title: '채팅방 메뉴',
              'aria-label': '채팅방 메뉴',
              onclick: (ev) => {
                ev.stopPropagation();
                codexBridge.toggleThreadMenu(activeThread.id, ev.currentTarget);
              },
            }, deskIcon('menu')),
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
              }, 'Board Thread에서 제거'),
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
            }, deskIcon('back')),
            el('div', { class: 'egd-codex-thread-active-title' }, activeThread.title,
              buildCodexSessionBadge(activeThread, codexBridge)),
            renderEngineChip(activeThread),
            codexUsageRing(codex.authStatus),
            el('button', {
              class: 'egd-codex-conversation-menu-trigger',
              'aria-label': '채팅방 메뉴',
              onclick: (ev) => {
                ev.stopPropagation();
                codexBridge.toggleThreadMenu(activeThread.id, ev.currentTarget);
              },
            }, deskIcon('menu')),
            memberRowWrap,
          ));
          if (codex.threadMenu?.threadId === activeThread.id) conversation.appendChild(renderThreadMenu(activeThread));
        }
        if (codex.engineMenu?.threadId === activeThread.id) conversation.appendChild(renderEnginePanel(activeThread));

        const messages = el('div', {
          class: 'egd-codex-messages',
          role: 'log',
          'aria-label': '대화 내역',
          'aria-live': 'polite',
          data: {
            threadId: activeThread.id,
            // A plan step resumed in place is not 대표님 sending: it never pulls the view down.
            lastUserMessageId: activeThread.messages.filter(message => message.role === 'user' && !ChatState.awaitResumeMessageView(message)).at(-1)?.id || '',
          },
        });
        if (!hasConversation) {
          const emptyChildren = [
            el('div', { class: 'egd-codex-empty-eyebrow' }, codex.authStatus.isLoggedIn ? '새 대화' : 'Codex 연결'),
            el('div', { class: 'egd-codex-empty-title' }, codex.authStatus.isLoggedIn ? '어떤 일을 함께할까요?' : '로그인 필요'),
          ];
          if (codex.authStatus.isLoggedIn) {
            emptyChildren.push(el('div', { class: 'egd-codex-empty-sub' }, '질문을 하거나 자료를 첨부해 대화를 시작하세요.'));
          }
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
          // A new room picks its AI before the first message; after that the room keeps it.
          if (codex.authStatus.isLoggedIn && !ChatState.chatThreadEngineLocked(activeThread)) {
            messages.appendChild(el('div', { class: 'egd-codex-engine-start', data: { testid: 'chat-engine-start' } },
              el('div', { class: 'egd-codex-engine-section-label' }, '이 대화에 쓸 AI'),
              renderEngineChoices(activeThread)));
            messages.appendChild(renderStatelessStart(activeThread));
          }
        } else {
          // Agent answers carry the Profile avatar captured at send; older answers
          // borrow the room's current Agent avatar only when the name still matches.
          const roomProfile = activeThread.profileEnabled === true ? codexThreadAgentProfile(activeThread) : null;
          // AGENT-05: while the run is busy, one '[···] Agent 작업 중' bubble closes the
          // conversation; it replaces the dots inside the streaming answer.
          const workingRun = codexCurrentRun(activeThread);
          const working = ChatState.nativeBindingHeld(activeThread) ? null : ChatState.agentWorkingView(workingRun, { connected: codex.connected });
          // CHAT-07: an answer's face and name open the profile peek; focus moves into it.
          const peekOpenFor = (message) => codex.agentPeek?.threadId === activeThread.id && codex.agentPeek.messageId === message.id;
          const togglePeek = (message, ev) => {
            ev.stopPropagation();
            const opening = !peekOpenFor(message);
            codexBridge.toggleAgentPeek(activeThread.id, message.id, ev.currentTarget);
            if (opening) body.querySelector('.egd-codex-agent-peek [data-focus-key]')?.focus({ preventScroll: true });
          };
          const peekTriggerProps = (message, author, className, focusKey) => ({
            class: `${className} egd-codex-agent-peek-trigger`, type: 'button',
            'aria-label': `${author} 프로필 보기`, 'aria-haspopup': 'dialog', 'aria-expanded': peekOpenFor(message) ? 'true' : 'false',
            data: { testid: 'chat-agent-peek-open', focusKey, messageId: message.id || '' },
            onclick: (ev) => togglePeek(message, ev),
          });
          // CHAT-06 Await: each plan card sits under the Agent answer that proposed it.
          const planPlacement = ChatState.planProposalPlacement(ChatState.planProposalsForThread(codex.planProposals, activeThread), activeThread.messages);
          const appendPlanCards = (entries) => {
            for (const entry of entries || []) {
              const card = renderChatPlanCard(entry, codexBridge, connectedFolderName);
              if (card) messages.appendChild(card);
            }
          };
          // A plan step resumed in place is a system line; it never groups with 대표님's bubbles.
          const groupRole = (message) => (message && ChatState.awaitResumeMessageView(message) ? 'system' : message?.role);
          // BRW-13: 대표님 took a Browser Card back from this room's Agent. One quiet line, in time order.
          const controlNotices = ChatState.browserUserControlNoticesFor(codex.browserUserControlNotices, ChatState.clientThreadBinding(activeThread));
          let controlNoticeIndex = 0;
          const appendControlNotices = (until = Infinity) => {
            while (controlNoticeIndex < controlNotices.length && controlNotices[controlNoticeIndex].at <= until) {
              const notice = controlNotices[controlNoticeIndex++];
              const view = ChatState.browserUserControlNoticeView(notice);
              messages.appendChild(el('div', {
                class: 'egd-codex-browser-control', role: 'note', data: { testid: 'chat-browser-user-control' },
              }, deskIcon('pointer', 'egd-codex-browser-control-mark'),
              el('span', { class: 'egd-codex-browser-control-text' }, view.line),
              el('span', { class: 'egd-codex-browser-control-detail' }, view.detail),
              el('span', { class: 'egd-codex-message-time' }, formatMessageTime(notice.at))));
            }
          };
          activeThread.messages.forEach((message, index) => {
            if (Number.isFinite(message.createdAt)) appendControlNotices(message.createdAt);
            if (message.role === 'assistant' && message.status === 'streaming' && !message.content) return;
            const resumed = ChatState.awaitResumeMessageView(message);
            if (resumed) {
              messages.appendChild(el('div', {
                class: 'egd-codex-await-resume', role: 'note',
                data: { testid: 'chat-await-resume', messageId: message.id || '', runId: message.runId || '' },
              }, deskIcon('check', 'egd-codex-await-resume-mark'),
              el('span', { class: 'egd-codex-await-resume-text' }, resumed.line),
              message.createdAt ? el('span', { class: 'egd-codex-message-time' }, formatMessageTime(message.createdAt)) : null));
              return;
            }
            const previous = activeThread.messages[index - 1] || null;
            const next = activeThread.messages[index + 1] || null;
            const previousDelta = message.createdAt && previous?.createdAt ? Math.abs(message.createdAt - previous.createdAt) : Infinity;
            const nextDelta = message.createdAt && next?.createdAt ? Math.abs(next.createdAt - message.createdAt) : Infinity;
            const author = codexMessageAuthorLabel(message);
            const groupedWithPrevious = groupRole(previous) === message.role && codexMessageAuthorLabel(previous) === author && previousDelta < 120000;
            const groupedWithNext = groupRole(next) === message.role && codexMessageAuthorLabel(next) === author && nextDelta < 120000;
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
            if (message.status === 'streaming' && message.role === 'assistant' && activeThread.profileEnabled === true && !ChatState.nativeBindingHeld(activeThread)
              && !(working && message.runId && message.runId === workingRun?.runId)) {
              bubble.appendChild(el('div', {
                class: 'egd-codex-streaming',
                role: 'status',
                'aria-label': `${author} 응답 중`,
              }, el('div', { class: 'egd-codex-typing-dots', 'aria-hidden': 'true' }, el('span'), el('span'), el('span'))));
            }
            const roleLabel = !groupedWithPrevious && message.role !== 'user'
              ? el('div', { class: 'egd-codex-message-role' }, message.role === 'assistant'
                ? el('button', peekTriggerProps(message, author, 'egd-codex-message-role-name', `agent-peek-name-${message.id}`), author)
                : author)
              : null;
            const meta = codexMessageTimeMeta(message, activeThread);
            // The message menu sits on the open side of the bubble.
            const menuTrigger = renderMessageMenuTrigger(activeThread, message);
            const messageLine = el('div', { class: 'egd-codex-message-line' },
              message.role === 'user' ? menuTrigger : null, bubble, message.role === 'user' ? null : menuTrigger);
            const messageStack = el('div', { class: 'egd-codex-message-stack' }, roleLabel, messageLine, resultChips, briefingControl, meta);
            if (message.inputReferences?.length) messageStack.appendChild(el('button', {
              class: 'egd-codex-result-chip', data: { testid: 'chat-message-inputs', requestId: message.requestId || '' },
              onclick: () => openCodexActivityPanel(activeThread.id),
            }, `첨부 입력 ${message.inputReferences.length}개 · 기록 보기`));
            const authorAvatar = message.role === 'assistant'
              ? message.authorAvatar || (roomProfile?.avatar && roomProfile.name === author ? roomProfile.avatar : null) : null;
            const avatarView = ChatState.profileAvatarView(authorAvatar, author);
            const avatarClass = `egd-codex-message-avatar${groupedWithPrevious ? ' egd-codex-message-avatar-spacer' : ''}${avatarView.saved ? ` egd-profile-avatar-tone-${avatarView.tone}` : ''}`;
            const avatarText = groupedWithPrevious ? '' : avatarView.saved ? avatarView.text : author.slice(0, 1);
            const avatar = message.role === 'assistant' && !groupedWithPrevious
              ? el('button', peekTriggerProps(message, author, avatarClass, `agent-peek-face-${message.id}`), avatarText)
              : message.role !== 'user' ? el('div', { class: avatarClass, 'aria-hidden': 'true' }, avatarText) : null;
            messages.appendChild(el('div', {
              data: { messageId: message.id, runId: message.runId || '', testid: 'chat-message', role: message.role },
              class: [
                'egd-codex-message-row',
                `egd-codex-message-row-${message.role || 'assistant'}`,
                groupedWithPrevious ? 'egd-codex-message-row-grouped' : '',
              ].filter(Boolean).join(' '),
            }, avatar, messageStack));
            appendPlanCards(planPlacement.byMessageId.get(message.id));
          });
          appendPlanCards(planPlacement.trailing);
          appendControlNotices();
          if (working) {
            messages.appendChild(codexAgentWorkingRow(working, {
              runId: workingRun.runId || '', name: workingRun.authorName || roomProfile?.name || 'Codex',
              avatar: workingRun.authorAvatar || roomProfile?.avatar || null,
              onOpen: () => codexBridge.openActivity(activeThread.id),
            }));
          }
        }
        conversation.appendChild(messages);
        if (codex.agentPeek?.threadId === activeThread.id) {
          const peekMessage = activeThread.messages.find((message) => message.id === codex.agentPeek.messageId && message.role === 'assistant');
          if (peekMessage) conversation.appendChild(renderAgentPeek(activeThread, peekMessage));
        }
        const menuMessage = codex.messageMenu?.threadId === activeThread.id
          ? activeThread.messages.find((message) => message.id === codex.messageMenu.messageId && ChatState.chatMessageForkPoint(activeThread, message)) : null;
        if (menuMessage) conversation.appendChild(renderMessageMenu(activeThread, menuMessage));
        if (activeThread.localHistoryCoverage && activeThread.localHistoryCoverage.status !== 'complete') conversation.appendChild(el('p', {
          class: 'egd-codex-run-status', role: 'status', data: { testid: 'chat-local-history-coverage' },
        }, activeThread.localHistoryCoverage.status === 'unknown' && !activeThread.localHistoryCoverage.reasons?.length
          ? '이 기기에 저장된 기록 · 전체 대화 범위 미확인'
          : '로컬 기록 일부를 확인하지 못했습니다. 표시된 대화는 유지됩니다.'));
        if (codex.localHistoryStatus === 'error' && codex.localHistoryError) conversation.appendChild(el('p', {
          class: 'egd-codex-error', role: 'status', data: { testid: 'chat-local-history-error' },
        }, codex.localHistoryError));
        const bindingHeld = ChatState.nativeBindingHeld(activeThread);
        if (bindingHeld) conversation.appendChild(el('div', {
          class: 'egd-codex-error', role: 'status', data: { testid: 'chat-binding-held', bindingState: activeThread.bindingState },
        }, '이전 대화의 계정 소유가 확인되지 않아 연결을 보류했습니다. 로컬 기록은 유지됩니다.',
        el('button', { class: 'egd-codex-chip', 'aria-label': '새 Codex 대화 열기', data: { testid: 'chat-new-unbound-room' }, onclick: () => codexBridge.createThread('dm', { openConversation: true }) }, '새 Codex 대화')));
        // A stopped or missing Agent is named, not replaced; the room and draft stay.
        const roomAgent = activeThread.profileEnabled === true ? codexThreadAgentProfile(activeThread) : null;
        if (roomAgent && !roomAgent.server && roomAgent.lifecycle === 'unknown' && codexProfileCatalog.status === 'unavailable') {
          conversation.appendChild(el('div', {
            class: 'egd-codex-error', role: 'status', data: { testid: 'chat-agent-unavailable', lifecycle: 'store-unavailable' },
          }, 'Agent 저장소에 연결되지 않아 이 대화방의 Agent를 지금 쓸 수 없습니다. 대화와 초안은 그대로 남아 있습니다.',
          el('button', { class: 'egd-codex-chip', onclick: (ev) => { ev.stopPropagation(); codexBridge.toggleThreadMenu(activeThread.id, ev.currentTarget); } }, '다른 Agent 고르기')));
        }
        if (roomAgent?.server && roomAgent.revision === null) {
          const reason = ({ disabled: '사용 중지된', archived: '보관된', draft: '아직 사용 전인' })[roomAgent.lifecycle] || null;
          conversation.appendChild(el('div', {
            class: 'egd-codex-error', role: 'status', data: { testid: 'chat-agent-unavailable', lifecycle: roomAgent.lifecycle },
          }, reason
            ? `이 대화방의 Agent ${roomAgent.name}는 ${reason} 상태라 지금 보낼 수 없습니다. 대화와 초안은 그대로 남아 있습니다.`
            : '이 대화방의 Agent를 찾을 수 없어 지금 보낼 수 없습니다. 대화와 초안은 그대로 남아 있습니다.',
          el('button', { class: 'egd-codex-chip', onclick: (ev) => { ev.stopPropagation(); codexBridge.toggleThreadMenu(activeThread.id, ev.currentTarget); } }, '다른 Agent 고르기')));
        }
        const run = codexCurrentRun(activeThread);
        const pending = Object.values(codex.chatProtocol.requests).find(request => ChatState.requestBelongsToThread(request, activeThread) && ['submitting', 'unconfirmed'].includes(request.status));
        const status = activeThread.preparingInput ? 'preparing-input' : activeThread.resuming ? 'restoring' : pending?.status || run?.status || 'ready';
        const statusText = bindingHeld ? '로컬 기록 · 연결 확인 필요' : activeThread.preparingInput ? '첨부 캡처 준비 중 · 아직 전송하지 않음' : activeThread.resuming ? '대화 상태 확인 중' : pending ? (pending.status === 'unconfirmed' ? '접수 상태 확인 필요' : '요청 보내는 중')
          : !run && codex.chatProtocol.unobservedPreviousRun ? '이전 연결의 실행 상태 미확인' : codexRunLabel(run);
        conversation.appendChild(el('div', {
          class: 'egd-codex-run-status', role: 'status', 'aria-live': 'polite',
          data: { testid: 'chat-run-status', status, runId: run?.runId || '', stopConfirmed: String(run?.status === 'interrupted') },
        }, el('span', {}, statusText),
        el('button', { 'aria-label': '활동 기록 열기', data: { testid: 'chat-activity-open', threadId: activeThread.id }, onclick: () => codexBridge.openActivity(activeThread.id) }, codexActivityButtonLabel(run))));
        // CHAT-06 Await: the task list line sits right under the run state.
        const taskBoard = renderChatTaskBoard(codex, codexBridge, connectedFolderName);
        if (taskBoard) conversation.appendChild(taskBoard);
        const runError =run?.status === 'failed' && run.error && run.error.code !== 'RUNTIME_LOST'
          ? ChatState.runErrorNotice(run.error, codex.authStatus?.usage) : null;
        if (runError) conversation.appendChild(el('div', {
          class: `egd-codex-error egd-codex-run-error egd-codex-run-error-${runError.kind}`, role: 'alert',
          data: { testid: 'chat-run-error', kind: runError.kind },
        }, el('span', {}, runError.text),
        runError.action === 'login' ? el('button', {
          class: 'egd-codex-chip egd-codex-chip-primary', data: { testid: 'chat-run-error-login' },
          disabled: (codex.isStartingLogin || codex.authStatus.loginInProgress) ? 'true' : null,
          onclick: () => codexBridge.startLogin(),
        }, (codex.isStartingLogin || codex.authStatus.loginInProgress) ? '로그인 중…' : '로그인') : null,
        runError.action === 'retry' ? el('button', {
          class: 'egd-codex-chip', data: { testid: 'chat-run-error-retry' },
          onclick: () => codexBridge.retryRun(activeThread.id, run.runId),
        }, '다시 시도') : null));
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
          'aria-expanded': String(state.codex.showDiagnostics),
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
              rows: '1',
              placeholder: '메시지 보내기',
              'aria-label': `${activeThread.title}에 보낼 메시지`,
              'aria-description': 'Enter로 줄바꿈, Ctrl 또는 Command와 Enter로 전송',
              title: 'Enter 줄바꿈 · Ctrl/⌘ Enter 전송',
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
              const main = input.closest?.('.egd-codex-chat-main');
              const footer = input.closest?.('.egd-codex-footer');
              const pane = main?.querySelector('.egd-codex-conversation-pane');
              const messages = pane?.querySelector('.egd-codex-messages');
              const cssMaxHeight = Number.parseFloat(input.ownerDocument.defaultView.getComputedStyle(input).maxHeight);
              let heightLimit = Number.isFinite(cssMaxHeight) ? Math.min(240, cssMaxHeight) : 240;
              if (main?.clientHeight > 0 && footer && pane && messages) {
                main.dataset.compactComposer = String(main.clientHeight < 480);
                const outerHeight = (node) => {
                  const style = node.ownerDocument.defaultView.getComputedStyle(node);
                  return node.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
                };
                const otherChildrenHeight = (parent, excluded) => Array.from(parent.children)
                  .filter(child => !excluded.includes(child)).reduce((total, child) => total + outerHeight(child), 0);
                // Reserve 80px of readable log content in addition to its padding
                // and borders. The compact styles must apply before measuring.
                const logStyle = messages.ownerDocument.defaultView.getComputedStyle(messages);
                const logReserve = 80 + ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth']
                  .reduce((total, key) => total + (parseFloat(logStyle[key]) || 0), 0);
                const chromeHeight = otherChildrenHeight(main, [pane, footer])
                  + otherChildrenHeight(pane, [messages]) + outerHeight(footer) - input.offsetHeight;
                heightLimit = Math.max(40, Math.min(heightLimit, Math.floor(main.clientHeight - chromeHeight - logReserve)));
                if (main.clientHeight < 480) heightLimit = Math.min(80, heightLimit);
              }
              const height = Math.min(heightLimit, Math.max(40, input.scrollHeight));
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
            let composerBodyHeight = 0;
            composerObserver = new ResizeObserver(() => {
              if (input.clientWidth === composerWidth && body.clientHeight === composerBodyHeight) return;
              composerWidth = input.clientWidth;
              composerBodyHeight = body.clientHeight;
              resizeComposer();
            });
            composerObserver.observe(input);
            composerObserver.observe(body);
            queueMicrotask(resizeComposer);
            const run = codexCurrentRun(activeThread);
            const stopButton = run && ChatState.isRunBusy(run) ? el('button', {
              class: 'egd-codex-stop', type: 'button', 'aria-label': '이 업무 중지',
              data: { testid: 'chat-stop', runId: run.runId, conversationId: run.conversationId },
              disabled: run.stopPending || run.stopRequested || run.status === 'stopping' ? 'true' : null,
              onclick: () => codexBridge.interrupt(activeThread.id),
            }, run.stopUnconfirmed || ((run.stopPending || run.stopRequested || run.status === 'stopping') && !codex.connected)
              ? '중지 확인 필요' : run.stopPending || run.stopRequested || run.status === 'stopping' ? '중지 요청 중' : '중지') : null;
            return el('div', { class: 'egd-codex-footer' },
              el('div', { class: 'egd-codex-input-row' },
                buildChatInputTray(activeThread, codexBridge),
                input,
                el('div', { class: 'egd-codex-compose-actions' },
                  el('span', { class: 'egd-codex-compose-hint', 'aria-hidden': 'true' }, 'Enter 줄바꿈 · Ctrl/⌘ Enter 전송'),
                  stopButton,
                  sendButton,
                ),
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
          connectionNotice,
          authCard || null,
          threadRail,
          diagnostics || null,
        );
        contentChildren.push(mainPane);
      } else {
        const mainPane = el('div', { class: 'egd-codex-chat-main egd-codex-chat-main-conversation' },
          authCard || null,
          conversation || null,
          connectionNotice,
          diagnostics || null,
          footer || null,
        );
        contentChildren.push(mainPane);
      }
      body.appendChild(el('div', { class: shellClasses }, ...contentChildren));
      const msgEl = body.querySelector(".egd-codex-messages");
      if (msgEl) {
        const sentNewMessage = msgEl.dataset.lastUserMessageId !== messageState?.lastUserMessageId;
        const preserveAnchor = messageState?.threadId === activeThread?.id && !messageState.atBottom && !sentNewMessage;
        const scrollIntent = {
          element: msgEl,
          state: {
            threadId: msgEl.dataset.threadId,
            lastUserMessageId: msgEl.dataset.lastUserMessageId,
            atBottom: !preserveAnchor,
            top: preserveAnchor ? messageState.top : 0,
            anchor: preserveAnchor ? messageState.anchor : null,
          },
        };
        pendingMessageScroll = scrollIntent;
        requestAnimationFrame(() => {
          if (!msgEl.isConnected || pendingMessageScroll !== scrollIntent) return;
          const target = scrollIntent.state;
          if (!target.atBottom) {
            const anchor = target.anchor && Array.from(msgEl.querySelectorAll('[data-testid="chat-message"]'))
              .find(item => item.dataset.messageId === target.anchor.id);
            msgEl.scrollTop = anchor
              ? msgEl.scrollTop + anchor.getBoundingClientRect().top - msgEl.getBoundingClientRect().top - target.anchor.offset
              : target.top;
          } else msgEl.scrollTop = msgEl.scrollHeight;
          pendingMessageScroll = null;
        });
      }
      const newInput = body.querySelector('.egd-codex-input');
      if (newInput && inputState?.threadId === activeThread?.id && inputState.focused) {
        newInput.focus({ preventScroll: true });
        newInput.setSelectionRange(inputState.start, inputState.end, inputState.direction);
        requestAnimationFrame(() => { if (newInput.isConnected) newInput.scrollTop = inputState.scrollTop; });
      }
      if (focusOpenedRoom) {
        const target = newInput && !newInput.disabled ? newInput : body.querySelector('.egd-codex-conversation-back');
        target?.focus({ preventScroll: true });
      } else restoreChatFocus(body, focusState);
    };

    unsubscribe = codexBridge.subscribe(render)
    body._codexCleanup = () => {
      unsubscribe?.();
      composerObserver?.disconnect();
      compositionInProgress = false;
      deferredCodex = null;
      pendingMessageScroll = null;
      body.removeEventListener('keydown', onMessageScrollGesture, true);
      body.removeEventListener('pointerdown', onMessageScrollGesture, true);
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
    // Rooms with a /chat/fork request in flight (one branch at a time per room).
    const forkingThreads = new Set();
    // RT-05: the installed build, read once and sent with every /v1/state read.
    let overlayBuildRead = null;
    const bridgeStateHeaders = async () => overlayBuildHeaders(await (overlayBuildRead ||= readExpectedOverlayBuild()));
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
    let browserTransportId = null;
    let browserTransportSource = null;
    let detachBrowserToolTransport = null;
    let browserTransportAbort = null;

    const clearBrowserToolTransport = ({ revoke = false } = {}) => {
      const hadTransport = !!browserTransportId;
      try { detachBrowserToolTransport?.(); } catch {}
      detachBrowserToolTransport = null;
      try { browserTransportAbort?.abort(); } catch {}
      browserTransportAbort = null;
      browserTransportId = null;
      browserTransportSource = null;
      if (revoke && hadTransport) {
        browserToolAuthorityEpoch++;
        browserToolFixtureLastAction = null;
        browserToolFixtureAuthorizationByCard.clear();
        browserToolRunBindings.clear();
        browserToolPendingBindings.clear();
        browserToolActionLeases.clear();
        browserToolUserSelections.clear();
        state.codex.threads = state.codex.threads.map(thread => ({ ...thread,
          inputSources: (thread.inputSources || []).map(input => input.kind === 'browser' &&
            input.browserToolPermission === 'interact'
            ? { ...input, browserToolPermission: 'observe', browserToolSelection: null,
              browserToolIdentity: null }
            : input),
        }));
      }
    };

    // Read-only, sampled at call time. A ready event from an older stream is
    // never evidence that the current root Chat SSE can carry Browser tools.
    const rootSseReady = () => {
      let eventSourceReadyState = null;
      try { if (Number.isSafeInteger(source?.readyState)) eventSourceReadyState = source.readyState; } catch {}
      const stable = !!(source && browserTransportSource === source && streamReady &&
        eventSourceReadyState === (window.EventSource?.OPEN ?? 1) &&
        typeof detachBrowserToolTransport === 'function' &&
        browserTransportAbort && !browserTransportAbort.signal.aborted &&
        typeof browserTransportId === 'string' && browserTransportId);
      return { sourceReady: stable, stable, eventSourceReadyState,
        browserTransportId: stable ? browserTransportId : null, sampledAtMs: Date.now() };
    };

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
      if (state.codex.engineMenu && !getCodexThreadById(state.codex, state.codex.engineMenu.threadId)) state.codex.engineMenu = null;
      if (state.codex.messageMenu && !getCodexThreadById(state.codex, state.codex.messageMenu.threadId)?.messages
        ?.some((message) => message.id === state.codex.messageMenu.messageId)) state.codex.messageMenu = null;
      if (state.codex.agentPeek && !getCodexThreadById(state.codex, state.codex.agentPeek.threadId)?.messages
        ?.some((message) => message.id === state.codex.agentPeek.messageId)) state.codex.agentPeek = null;
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
      if (ChatState.codexAccountChanged(state.codex.codexAccountKey, patch.authStatus)) {
        resetThreadConversations();
        // Task graphs belong to the account that made them.
        state.codex.taskBoard = ChatState.createTaskBoard();
        state.codex.taskContinue = null;
        state.codex.taskApproval = null;
        state.codex.taskResume = null;
        state.codex.planProposals = ChatState.createPlanProposals();
      }
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
      clearBrowserToolTransport();
      browserToolAuthorityEpoch++;
      browserToolFixtureLastAction = null;
      browserToolFixtureAuthorizationByCard.clear();
      browserToolRunBindings.clear();
      browserToolPendingBindings.clear();
      browserToolUserSelections.clear();
      browserToolActionLeases.clear();
      ChatState.resetChatProtocol(protocol);
      userInputDrafts.clear();
      activityPanelComposing = false;
      activityPanelDeferred = false;
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
      state.codex.messageMenu = null;
      forkingThreads.clear();
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

    // One catalog read at a time; a bridge without the profile store leaves
    // rooms on the built-in definitions instead of inventing Agents.
    let profileCatalogLoad = null;
    // CHAT-07 peek: GET /profiles/:id per Agent, keyed by the active revision asked for.
    const agentProfileDetails = new Map();
    const loadProfileCatalog = () => {
      if (profileCatalogLoad) return profileCatalogLoad;
      if (codexProfileCatalog.status !== 'ready') codexProfileCatalog = { status: 'loading', profiles: [] };
      profileCatalogLoad = fetchJson('/profiles?includeArchived=true')
        .then((payload) => { codexProfileCatalog = { status: 'ready', profiles: ChatState.normalizeProfileCatalog(payload) }; })
        .catch(() => { codexProfileCatalog = { status: 'unavailable', profiles: [] }; })
        .finally(() => { profileCatalogLoad = null; emit(); });
      return profileCatalogLoad;
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

    // SSE engine.status replaces engines[] (models included); a brief '로그인 필요'
    // right after connecting is held so the panel does not flicker.
    const engineStatus = ChatState.createEngineStatusDebouncer({
      current: () => state.codex.engines,
      apply: (engines) => update({ engines }),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
    });
    // BRW-04: Browser card locations for workflow gates, origin + path only.
    const browserWorkflow = SurfaceState.createBrowserWorkflowReporter({
      post: (body) => fetchJson('/events/browser', { method: 'POST', body: JSON.stringify(body) }),
      onError: (error) => { if (error?.status) console.warn(TAG, 'browser workflow event was not accepted', error.status, error.code || ''); },
    });

    // CHAT-06 Await task list: the graphs this screen has seen through task.graph
    // and task.plan frames. A state read adds the Board and exact scope that
    // '계속' needs; a read never replaces a frame that arrived after it began.
    const taskStateReads = new Map();
    const readTaskGraph = (graphId) => {
      if (!ChatState.taskRef(graphId)) return Promise.resolve(null);
      if (taskStateReads.has(graphId)) return taskStateReads.get(graphId);
      const ifRev = ChatState.taskBoardEntry(state.codex.taskBoard, graphId)?.rev ?? 0;
      const read = fetchJson(`/tasks/state?graphId=${encodeURIComponent(graphId)}`)
        .then((payload) => {
          const fresh = (ChatState.taskBoardEntry(state.codex.taskBoard, graphId)?.rev ?? 0) === ifRev;
          state.codex.taskBoard = ChatState.taskBoardWithState(state.codex.taskBoard, payload, { ifRev });
          if (fresh) browserWorkflow.graph(payload?.graph);
          return null;
        })
        .catch((error) => {
          if (error?.code === 'TASK_NOT_FOUND') state.codex.taskBoard = ChatState.taskBoardWithout(state.codex.taskBoard, graphId);
          return error;
        })
        .finally(() => { taskStateReads.delete(graphId); emit(); });
      taskStateReads.set(graphId, read);
      return read;
    };
    const readTaskGraphs = ({ openOnly = false } = {}) => {
      const graphIds = openOnly ? ChatState.taskBoardOpenGraphIds(state.codex.taskBoard)
        : (state.codex.taskBoard?.graphs || []).map((entry) => entry.graphId);
      for (const graphId of graphIds) void readTaskGraph(graphId);
    };
    const taskGraphFrame = (graph) => {
      state.codex.taskBoard = ChatState.taskBoardWithGraph(state.codex.taskBoard, graph);
      const entry = ChatState.taskBoardEntry(state.codex.taskBoard, graph?.graphId);
      if (entry && !entry.boardId) void readTaskGraph(entry.graphId);
      emit();
    };
    // A plan gets its approval card; once approved its graph joins the task list.
    const taskPlanFrame = (plan) => {
      state.codex.planProposals = ChatState.planProposalsWithPlan(state.codex.planProposals, plan);
      if (ChatState.planOnTaskBoard(plan)) {
        state.codex.taskBoard = ChatState.taskBoardWithPlan(state.codex.taskBoard, plan);
        const entry = ChatState.taskBoardEntry(state.codex.taskBoard, plan?.graphId);
        if (entry && !entry.graph) void readTaskGraph(entry.graphId);
      }
      emit();
    };
    // chat.event 'plan.proposed': the card goes under that run's answer (the chat event's own emit draws it).
    const planProposalFrame = (run, details) => {
      state.codex.planProposals = ChatState.planProposalsWithEvent(state.codex.planProposals, run, details);
    };
    // GET /tasks/plans?planId=: this account's plan with each step's instructions.
    const planDetailReads = new Map();
    const readPlanDetail = (planId) => {
      if (!ChatState.planRef(planId)) return Promise.resolve(null);
      if (planDetailReads.has(planId)) return planDetailReads.get(planId);
      state.codex.planProposals = ChatState.planProposalsWithDetail(state.codex.planProposals, planId, 'loading');
      const read = fetchJson(`/tasks/plans?planId=${encodeURIComponent(planId)}`)
        .then((payload) => {
          state.codex.planProposals = ChatState.planProposalsWithPlan(state.codex.planProposals, payload?.plan);
          if (ChatState.planProposalEntry(state.codex.planProposals, planId)?.detail !== 'loaded') {
            state.codex.planProposals = ChatState.planProposalsWithDetail(state.codex.planProposals, planId, 'error');
          }
          return null;
        })
        .catch((error) => {
          state.codex.planProposals = error?.code === 'PLAN_NOT_FOUND'
            ? ChatState.planProposalsWithMissing(state.codex.planProposals, planId)
            : ChatState.planProposalsWithDetail(state.codex.planProposals, planId, 'error');
          return error;
        })
        .finally(() => { planDetailReads.delete(planId); emit(); });
      planDetailReads.set(planId, read);
      emit();
      return read;
    };
    // After a (re)connect: plans waiting for 대표님 get their cards back, and
    // approved plans still running rejoin the task list. Read only, never decided.
    const loadTaskPlans = () => fetchJson('/tasks/plans')
      .then((payload) => {
        const plans = Array.isArray(payload?.plans) ? payload.plans.slice(0, ChatState.PLAN_PROPOSAL_LIMIT) : [];
        for (const plan of [...plans].reverse()) {
          state.codex.planProposals = ChatState.planProposalsWithPlan(state.codex.planProposals, plan);
          if (plan?.status !== 'approved') continue;
          state.codex.taskBoard = ChatState.taskBoardWithPlan(state.codex.taskBoard, plan);
          const entry = ChatState.taskBoardEntry(state.codex.taskBoard, plan.graphId);
          if (entry && !entry.graph) void readTaskGraph(entry.graphId);
        }
        emit();
      })
      .catch(() => {});

    const handleEvent = (event) => {
      if (event?.type?.startsWith('assistant-')) return;
      switch (event.type) {
        case 'engine.status':
          engineStatus.push(event.engines);
          return;
        // Task graph frames: the open sign-in gates (to tell a finished sign-in) and the task list.
        case 'task.graph':
          browserWorkflow.graph(event.graph);
          taskGraphFrame(event.graph);
          return;
        // A hint only: unfinished graphs on screen are read again.
        case 'task.native':
          readTaskGraphs({ openOnly: true });
          return;
        // A plan names its steps; the list uses those titles.
        case 'task.plan':
          taskPlanFrame(event.plan);
          return;
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
        // CU-07: the inherited tool list changed (null when it can no longer be read).
        case 'mcp.inherited':
          update({ inheritedMcp: Array.isArray(event.inheritedMcp) ? event.inheritedMcp : null });
          return;
        case 'chat.event': {
          if (event.v === 2) {
            if (!ChatState.canAdmitChatEvent(protocol, state.codex.threads, event)) return;
            const run = ChatState.reduceChatEvent(protocol, event, ChatState.knownChatEngineIds(state.codex.engines));
            // CHAT-06 Await: an Agent proposed a plan; its approval card goes under this run's answer.
            if (run && event.event === 'plan.proposed') planProposalFrame(run, event.details);
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
        const bridgeState = await fetchJson('/v1/state', { signal: token.signal, headers: await bridgeStateHeaders() });
        if (!epochScope.valid(token)) return;
        engineStatus.cancel();
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
          ...bridgeConnectionFields(bridgeState),
          ...bridgeEngineFields(bridgeState),
          ...bridgeSessionFields(bridgeState),
        });
      } catch (error) {
        if (!epochScope.valid(token)) return;
        try {
          const status = await fetchJson('/auth/status', { signal: token.signal });
          if (!epochScope.valid(token)) return;
          update({ authStatus: status, isStartingLogin: Boolean(status.loginInProgress), connected: true, error: null,
            ...bridgeConnectionFields(null), ...bridgeSessionFields(null) });
        } catch (fallbackError) {
          if (!epochScope.valid(token)) return;
          // The screen says '다시 연결 중…' by state; the raw message is kept
          // for the folded '자세히' only.
          update({
            connected: false,
            bridgeFailures: (state.codex.bridgeFailures || 0) + 1,
            bridgeError: String(fallbackError?.message || fallbackError || ''),
          });
          scheduleReconnect();
        }
      }

      if (!epochScope.valid(token)) return;
      if (state.codex.connected) void loadProfileCatalog();
      const streamEpoch = epochScope.current();
      try {
        source = new EventSource('http://127.0.0.1:39218/events?chatProtocol=2');
      } catch (error) {
        scheduleReconnect();
        return;
      }

      const connectionSource = source;
      connectionSource.addEventListener('ready', (event) => {
        if (!epochScope.valid(streamEpoch) || source !== connectionSource) return;
        let ready = null;
        try { ready = JSON.parse(event.data); } catch {}
        const nextTransportId = ready?.browserTransportId;
        const sameTransport = browserTransportId === nextTransportId &&
          browserTransportSource === connectionSource && !!detachBrowserToolTransport;
        if (!sameTransport && browserTransportId) {
          clearBrowserToolTransport({ revoke: true });
        } else if (!sameTransport) clearBrowserToolTransport();
        if (!sameTransport && typeof nextTransportId === 'string' &&
            nextTransportId.length > 0 && nextTransportId.length <= 160) {
          const transportId = nextTransportId;
          browserTransportId = transportId;
          browserTransportSource = connectionSource;
          browserTransportAbort = new window.AbortController();
          const responseSignal = browserTransportAbort.signal;
          detachBrowserToolTransport = attachBrowserToolTransport({ source: connectionSource, respond: async response => {
            if (!epochScope.valid(streamEpoch) || source !== connectionSource ||
                browserTransportId !== transportId || browserTransportSource !== connectionSource) {
              throw new Error('Browser tool UI stream changed before response');
            }
            const receipt = await fetchJson('/browser-tool/respond', { method: 'POST', signal: responseSignal,
              body: JSON.stringify({ browserTransportId: transportId, response }) });
            if (receipt?.accepted !== true || receipt.requestId !== response.requestId) {
              throw new Error('Browser tool response was not accepted by the bound stream');
            }
          } });
        }
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
      // CHAT-06: frames may have been missed while away; the graphs on screen and the plans are read again.
      connectionSource.addEventListener('ready', () => { if (epochScope.valid(streamEpoch) && source === connectionSource) { readTaskGraphs(); void loadTaskPlans(); } });

      connectionSource.onerror = () => {
        if (!epochScope.valid(streamEpoch) || source !== connectionSource) return;
        clearBrowserToolTransport({ revoke: true });
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
      rootSseReady,
      // BRW-04: a user's Browser card arrived at a new top-level location. The
      // bridge hears origin + path, and a finished sign-in when an open gate matches.
      reportBrowserLocation(cardId, url) {
        if (!state.codex.connected) return [];
        return browserWorkflow.location(cardId, url);
      },
      // BRW-13: 대표님 took a Browser Card back from this room's run. One local
      // system line in that room; nothing is sent and nothing is saved.
      noteBrowserUserControl(clientThreadId, host = '') {
        const before = state.codex.browserUserControlNotices;
        state.codex.browserUserControlNotices = ChatState.addBrowserUserControlNotice(before, { clientThreadId, host, at: Date.now() });
        if (state.codex.browserUserControlNotices !== before) emit();
      },
      // CHAT-06 Await task list: open or close it in place.
      toggleTaskBoard() {
        state.codex.taskBoardOpen = !state.codex.taskBoardOpen;
        emit();
      },
      // '계속' first asks; only '진행' sends. Upstream tasks and approvals never offer it.
      askTaskContinue(graphId, taskId, gateId) {
        if (state.codex.taskContinue?.phase === 'sending') return;
        state.codex.taskContinue = { graphId, taskId, gateId, phase: 'confirm', error: null };
        emit();
      },
      cancelTaskContinue() {
        if (state.codex.taskContinue?.phase === 'sending') return;
        state.codex.taskContinue = null;
        emit();
      },
      // POST /tasks/continue for one outside condition: the task goes on without it.
      async continueTaskGate(graphId, taskId, gateId) {
        if (state.codex.taskContinue?.phase === 'sending') return;
        const target = { graphId, taskId, gateId };
        state.codex.taskContinue = { ...target, phase: 'sending', error: null };
        emit();
        try {
          const readError = ChatState.taskBoardEntry(state.codex.taskBoard, graphId)?.boardId ? null : await readTaskGraph(graphId);
          const entry = ChatState.taskBoardEntry(state.codex.taskBoard, graphId);
          if (!entry?.boardId) throw readError || Object.assign(new Error('task board unknown'), { status: 404, code: 'TASK_NOT_FOUND' });
          const body = ChatState.buildTaskContinueRequest(entry, taskId, gateId);
          if (!body) throw Object.assign(new Error('gate not waiting'), { status: 409, code: 'TASK_GATE_STALE' });
          const ifRev = entry.rev;
          const payload = await fetchJson('/tasks/continue', { method: 'POST', body: JSON.stringify(body) });
          const fresh = ChatState.taskBoardEntry(state.codex.taskBoard, graphId)?.rev === ifRev;
          state.codex.taskBoard = ChatState.taskBoardWithState(state.codex.taskBoard, payload, { ifRev });
          if (fresh) browserWorkflow.graph(payload?.graph);
          state.codex.taskContinue = null;
        } catch (error) {
          state.codex.taskContinue = { ...target, phase: 'error', error: ChatState.taskContinueErrorText(error) };
          if (error?.code === 'TASK_GATE_STALE') void readTaskGraph(graphId);
        }
        emit();
      },
      // An approval a task asked for: only 대표님's click decides; the approval ID
      // comes from a state read, never from the screen.
      async decideTaskApproval(graphId, taskId, decision) {
        if (state.codex.taskApproval?.phase === 'sending') return;
        const target = { graphId, taskId, decision };
        state.codex.taskApproval = { ...target, phase: 'sending', error: null };
        emit();
        let sent = false;
        try {
          let entry = ChatState.taskBoardEntry(state.codex.taskBoard, graphId);
          if (!ChatState.buildTaskApprovalRequest(entry, taskId, decision)) {
            const readError = await readTaskGraph(graphId);
            entry = ChatState.taskBoardEntry(state.codex.taskBoard, graphId);
            if (!entry?.boardId && readError) throw readError;
          }
          const body = ChatState.buildTaskApprovalRequest(entry, taskId, decision);
          if (!body) throw Object.assign(new Error('approval not pending'), { status: 409, code: 'TASK_APPROVAL_STALE' });
          const ifRev = entry.rev;
          sent = true;
          const payload = await fetchJson('/tasks/approval', { method: 'POST', body: JSON.stringify(body) });
          const fresh = ChatState.taskBoardEntry(state.codex.taskBoard, graphId)?.rev === ifRev;
          state.codex.taskBoard = ChatState.taskBoardWithState(state.codex.taskBoard, payload, { ifRev });
          if (fresh) browserWorkflow.graph(payload?.graph);
          state.codex.taskApproval = null;
        } catch (error) {
          state.codex.taskApproval = { ...target, phase: 'error', error: ChatState.taskApprovalErrorText(error) };
          if (sent && error?.status === 409) void readTaskGraph(graphId);
        }
        emit();
      },
      // '이어서 진행' after a bridge restart: POST /tasks/resume for each held graph.
      async resumeHeldTasks() {
        if (state.codex.taskResume?.phase === 'sending') return;
        state.codex.taskResume = { phase: 'sending', error: null };
        emit();
        let failure = null;
        for (const held of ChatState.taskBoardHeldEntries(state.codex.taskBoard)) {
          const graphId = held.graphId;
          let sent = false;
          try {
            const readError = held.boardId ? null : await readTaskGraph(graphId);
            const entry = ChatState.taskBoardEntry(state.codex.taskBoard, graphId);
            if (!entry?.boardId) throw readError || Object.assign(new Error('task board unknown'), { status: 404, code: 'TASK_NOT_FOUND' });
            const body = ChatState.buildTaskResumeRequest(entry);
            if (!body) continue;
            const ifRev = entry.rev;
            sent = true;
            const payload = await fetchJson('/tasks/resume', { method: 'POST', body: JSON.stringify(body) });
            const fresh = ChatState.taskBoardEntry(state.codex.taskBoard, graphId)?.rev === ifRev;
            state.codex.taskBoard = ChatState.taskBoardWithState(state.codex.taskBoard, payload, { ifRev });
            if (fresh) browserWorkflow.graph(payload?.graph);
          } catch (error) {
            failure ||= error;
            if (sent && error?.status === 409) void readTaskGraph(graphId);
          }
        }
        state.codex.taskResume = failure ? { phase: 'error', error: ChatState.taskResumeErrorText(failure) } : null;
        emit();
      },
      openTaskBoard() {
        state.codex.taskBoardOpen = true;
        emit();
      },
      // CHAT-06 Await plan card: '승인하고 시작' first asks; only '승인' sends.
      askPlanApprove(planId) {
        const entry = ChatState.planProposalEntry(state.codex.planProposals, planId);
        if (entry?.status !== 'proposed' || entry.decision?.phase === 'sending') return;
        state.codex.planProposals = ChatState.planProposalsWithDecision(state.codex.planProposals, planId, { action: 'approve', phase: 'confirm' });
        emit();
      },
      cancelPlanDecision(planId) {
        if (ChatState.planProposalEntry(state.codex.planProposals, planId)?.decision?.phase === 'sending') return;
        state.codex.planProposals = ChatState.planProposalsWithDecision(state.codex.planProposals, planId, null);
        emit();
      },
      // POST /tasks/plans/:planId/approve|reject with an empty body. One decision at
      // a time; the reply's plan updates the card and its graph joins the task list.
      async decidePlan(planId, action) {
        const entry = ChatState.planProposalEntry(state.codex.planProposals, planId);
        const request = ChatState.buildPlanDecisionRequest(entry, action);
        if (!request) return;
        state.codex.planProposals = ChatState.planProposalsWithDecision(state.codex.planProposals, planId, { action, phase: 'sending' });
        emit();
        try {
          const ifRev = ChatState.taskBoardEntry(state.codex.taskBoard, entry.graphId)?.rev ?? 0;
          const payload = await fetchJson(request.path, { method: 'POST', body: JSON.stringify(request.body) });
          state.codex.planProposals = ChatState.planProposalsWithDecision(
            ChatState.planProposalsWithPlan(state.codex.planProposals, payload?.plan), planId, null);
          if (ChatState.planOnTaskBoard(payload?.plan)) {
            const fresh = (ChatState.taskBoardEntry(state.codex.taskBoard, entry.graphId)?.rev ?? 0) === ifRev;
            state.codex.taskBoard = ChatState.taskBoardWithPlan(ChatState.taskBoardWithState(state.codex.taskBoard, payload, { ifRev }), payload.plan);
            if (fresh) browserWorkflow.graph(payload?.graph);
          }
        } catch (error) {
          state.codex.planProposals = ChatState.planProposalsWithDecision(state.codex.planProposals, planId,
            { action, phase: 'error', error: ChatState.planDecisionErrorText(error, action) });
          if (error?.code === 'PLAN_NOT_FOUND') state.codex.planProposals = ChatState.planProposalsWithMissing(state.codex.planProposals, planId);
          else if (error?.status === 409) void readPlanDetail(planId);
        }
        emit();
      },
      // A step's instructions open in place; the first open reads them.
      togglePlanStep(planId, taskId) {
        state.codex.planProposals = ChatState.planProposalsWithStep(state.codex.planProposals, planId, taskId);
        const entry = ChatState.planProposalEntry(state.codex.planProposals, planId);
        emit();
        if (entry?.openSteps.includes(taskId) && !entry.instructions && entry.detail !== 'loading') void readPlanDetail(planId);
      },
      retryPlanDetail(planId) {
        void readPlanDetail(planId);
      },
      // '다시 시도' after the quiet retries ran out: start a fresh connect now
      // and say '다시 연결 중…' again while it runs.
      reconnectNow() {
        if (state.codex.connected) return false;
        if (reconnectTimer) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (source) {
          clearBrowserToolTransport({ revoke: true });
          try { source.close(); } catch {}
          source = null;
        }
        update({ bridgeFailures: 0 });
        void connect();
        return true;
      },
      async reconcileRequest(threadId = state.codex.activeThreadId) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread) return null;
        // Explicit recheck of an unconfirmed send: only the resume path can settle it.
        // A read-only refresh leaves the request unconfirmed and the room blocked.
        if (thread.conversationId) return refreshConversation(thread, true);
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
      async replyUserInput({ userInputId, conversationId, runId, action = 'submit', draft }) {
        const run = protocol.runs[ChatState.runKey(conversationId, runId)];
        const input = run?.pendingUserInputs?.find(item => item.userInputId === userInputId);
        const draftKey = `${conversationId}/${runId}/${userInputId}`;
        const request = ChatState.userInputRequestFor(run, userInputId, draft ?? userInputDrafts.get(draftKey), action);
        if (!request) return false;
        const token = epochScope.begin();
        input.replyPending = true;
        input.error = null;
        emit();
        try {
          const result = await fetchJson('/chat/user-input', { method: 'POST', signal: token.signal, body: JSON.stringify(request) });
          if (!epochScope.valid(token)) return false;
          if (ChatState.acknowledgeUserInputReply(run, result) && result.userInputId === userInputId) userInputDrafts.delete(draftKey);
          return result;
        } catch (error) {
          if (!epochScope.valid(token)) return false;
          // Error text is the helper's public message only; answers are never echoed.
          const current = run.pendingUserInputs?.find(item => item.userInputId === userInputId) || input;
          current.stale = error.code === 'STALE_USER_INPUT' || error.status === 409;
          if (current.stale) userInputDrafts.delete(draftKey);
          current.error = current.stale ? '이 질문은 더 이상 답할 수 없습니다.'
            : error.code === 'INVALID_USER_INPUT_ANSWER' ? '답변을 보낼 수 없습니다. 선택과 입력을 다시 확인해 주세요.'
              : `답변 전달 여부를 확인하지 못했습니다: ${error.message}`;
          return false;
        } finally { epochScope.finish(token); if (epochScope.valid(token)) { input.replyPending = false; emit(); } }
      },
      async interrupt(threadId = state.codex.activeThreadId) {
        const thread = getCodexThreadById(state.codex, threadId);
        const run = ChatState.runsForThread(protocol, thread).findLast(ChatState.isRunBusy);
        if (!run || run.stopPending || run.stopRequested) return false;
        const token = epochScope.begin();
        run.stopPending = true;
        run.stopUnconfirmed = false;
        revokeBrowserToolRunImmediately(run, thread);
        emit();
        try {
          const result = await fetchJson('/chat/interrupt', { method: 'POST', signal: token.signal, body: JSON.stringify({ conversationId: run.conversationId, runId: run.runId }) });
          if (!epochScope.valid(token)) return false;
          if (result.accepted && result.stopRequested && ChatState.isRunBusy(run)) {
            run.stopRequested = true;
            run.status = 'stopping';
          } else if (!result.accepted) {
            if (ChatState.isRunBusy(run)) run.stopUnconfirmed = true;
            updateThreadById(threadId, current => ({ ...current, sendError: '중지 요청이 수락되지 않았습니다. 상태를 다시 확인해 주세요.' }));
          }
          return result;
        } catch (error) {
          if (!epochScope.valid(token)) return false;
          if (ChatState.isRunBusy(run)) run.stopUnconfirmed = true;
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
        return codexAgentProfileChoices().map((profile) => ({ ...profile }));
      },
      profileCatalog() {
        return { status: codexProfileCatalog.status, profiles: codexProfileCatalog.profiles.map((profile) => ({ ...profile })) };
      },
      // Refreshes the shared catalog that Chat rooms read; settings call it after every change.
      loadProfiles() {
        return loadProfileCatalog();
      },
      // Settings-only access to the local profile routes; nothing else is reachable here.
      async profileRequest(path, { method = 'GET', body } = {}) {
        if (typeof path !== 'string' || !/^\/profiles(?:[/?]|$)/.test(path)) throw new Error('Invalid profile path');
        return fetchJson(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
        const source = getCodexThreadById(state.codex, threadId)?.inputSources?.find(item => item.id === sourceId);
        if (source?.browserToolSelection?.token) browserToolUserSelections.delete(source.browserToolSelection.token);
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
        if (profileId && !codexAgentProfileChoices().some((profile) => profile.id === profileId)) return;
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
        const order = codexAgentProfileChoices().map((profile) => profile.id);
        if (!order.length) return;
        const currentIndex = order.indexOf(currentId);
        this.setThreadAgentProfile(threadId, order[(currentIndex + 1) % order.length]);
      },
      setHudView(view) {
        state.codex.hudView = normalizeHudView(view);
        if (state.codex.hudView === 'list') {
          state.codex.threadMenu = null;
          state.codex.memberMenu = null;
          state.codex.engineMenu = null;
          state.codex.messageMenu = null;
          state.codex.agentPeek = null;
        }
        emit();
      },
      openHudHome() {
        state.codex.hudView = 'list';
        state.codex.threadMenu = null;
        state.codex.memberMenu = null;
        state.codex.engineMenu = null;
        state.codex.messageMenu = null;
        state.codex.agentPeek = null;
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
        if (!alreadyOpen) {
          state.codex.memberMenu = null;
          state.codex.messageMenu = null;
          state.codex.agentPeek = null;
        }
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
      toggleEngineMenu(threadId, anchorEl = null) {
        if (!threadId) return;
        if (state.codex.engineMenu?.threadId === threadId) {
          state.codex.engineMenu = null;
        } else {
          const rect = anchorEl?.getBoundingClientRect?.();
          state.codex.engineMenu = { threadId, ...(rect ? resolveFloatingMenuPlacement(rect, 264, 320) : { left: 12, top: 12 }) };
          state.codex.threadMenu = null;
          state.codex.memberMenu = null;
          state.codex.messageMenu = null;
          state.codex.agentPeek = null;
        }
        emit();
      },
      closeEngineMenu() {
        if (!state.codex.engineMenu) return;
        state.codex.engineMenu = null;
        emit();
      },
      // D3: only a room that has not started can change its engine.
      setThreadEngine(threadId, engineId) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || ChatState.chatThreadEngineLocked(thread)) return;
        if (!ChatState.chatEngineChoices(state.codex.engines, state.codex.authStatus).some((choice) => choice.id === engineId && choice.selectable)) return;
        updateThreadById(threadId, (current) => ({ ...current, engineId }));
        emit();
      },
      // Model and effort apply per turn, so a started room can change them.
      // Only offered values are kept; another model starts on its own default effort.
      setThreadModel(threadId, model) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread) return;
        const pick = ChatState.chatModelPick(thread, model, { ...state.codex, auth: state.codex.authStatus });
        if (pick === undefined) return;
        updateThreadById(threadId, (current) => ({ ...current, model: pick, effort: (current.model || null) === pick ? current.effort : null }));
        emit();
      },
      setThreadEffort(threadId, effort) {
        if (!getCodexThreadById(state.codex, threadId)) return;
        updateThreadById(threadId, (current) => ({ ...current, effort: ChatState.chatEffortPick(current, effort, { ...state.codex, auth: state.codex.authStatus }) }));
        emit();
      },
      continueInNewThread(threadId) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread) return;
        state.codex.engineMenu = null;
        this.createThread(thread.type, { agentProfileId: thread.agentProfileId, profileEnabled: thread.profileEnabled === true, openConversation: true });
        boardNotice('새 대화를 열었습니다. 이전 대화 내용은 자동으로 옮겨지지 않습니다.');
      },
      // CHAT-09: '기록 없이 시작' on a room that has not sent yet.
      setThreadStateless(threadId, on) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || ChatState.chatThreadEngineLocked(thread)) return;
        updateThreadById(threadId, (current) => ({ ...current, startStateless: on === true }));
        emit();
      },
      forkAvailability(threadId, fromTurnId = null) {
        const thread = getCodexThreadById(state.codex, threadId);
        return ChatState.chatForkAvailability(thread, {
          connected: state.codex.connected, auth: state.codex.authStatus, capabilities: state.codex.chatCapabilities,
          busy: !!thread && (threadBusy(thread) || forkingThreads.has(thread.id)),
          runs: ChatState.runsForThread(protocol, thread), fromTurnId,
        });
      },
      // The bridge branches the native conversation into a new room; the new
      // room then opens and /chat/resume shows the history it carried over.
      async forkThread(threadId, { fromTurnId = null } = {}) {
        const source = getCodexThreadById(state.codex, threadId);
        const availability = this.forkAvailability(threadId, fromTurnId);
        state.codex.threadMenu = null;
        state.codex.messageMenu = null;
        if (!source || !availability.available) {
          if (availability.reason) boardNotice(availability.reason);
          emit();
          return null;
        }
        const target = createCodexThread(source.type, `${source.title} (분기)`, '', {
          participants: source.participants, participantRoles: source.participantRoles,
          profileEnabled: source.profileEnabled === true, agentProfileId: source.agentProfileId,
        });
        if (source.effort) target.effort = source.effort;
        if (source.model) target.model = source.model;
        if (source.sentModel) target.sentModel = source.sentModel;
        const body = ChatState.buildChatForkRequest(source, ChatState.clientThreadBinding(target), fromTurnId, source.engineId);
        const token = epochScope.begin();
        forkingThreads.add(source.id);
        emit();
        try {
          const result = await fetchJson('/chat/fork', { method: 'POST', signal: token.signal, body: JSON.stringify(body) });
          if (!epochScope.valid(token)) return null;
          const forked = ChatState.forkedThreadFromResult(target, getCodexThreadById(state.codex, source.id) || source, result);
          if (!forked) throw Object.assign(new Error('Fork reply did not name the new conversation'), { code: 'INVALID_THREAD_RESPONSE', status: 502 });
          state.codex.threads = [forked, ...state.codex.threads];
          state.codex.threadDrafts = { ...(state.codex.threadDrafts || {}), [forked.id]: '' };
          this.selectThread(forked.id, { openConversation: true });
          boardNotice(fromTurnId ? '선택한 지점까지의 대화를 새 대화방으로 분기했습니다. 원본 대화는 그대로입니다.'
            : '대화를 새 대화방으로 분기했습니다. 원본 대화는 그대로입니다.');
          return result;
        } catch (error) {
          if (!epochScope.valid(token)) return null;
          boardNotice(ChatState.chatForkErrorText(error));
          return null;
        } finally {
          epochScope.finish(token);
          forkingThreads.delete(source.id);
          if (epochScope.valid(token)) emit();
        }
      },
      openForkSource(threadId) {
        const thread = getCodexThreadById(state.codex, threadId);
        const source = ChatState.findForkSourceThread(state.codex.threads.filter((item) => item.id !== threadId), thread?.forkedFrom);
        if (!source) {
          boardNotice('원본 대화방을 이 기기에서 찾지 못했습니다.');
          return false;
        }
        this.selectThread(source.id, { openConversation: true });
        return true;
      },
      toggleMessageMenu(threadId, messageId, anchorEl = null) {
        if (!threadId || !messageId) return;
        if (state.codex.messageMenu?.threadId === threadId && state.codex.messageMenu.messageId === messageId) {
          state.codex.messageMenu = null;
        } else {
          const rect = anchorEl?.getBoundingClientRect?.();
          state.codex.messageMenu = { threadId, messageId, ...(rect ? resolveFloatingMenuPlacement(rect, 230, 120) : { left: 12, top: 12 }) };
          state.codex.threadMenu = null;
          state.codex.memberMenu = null;
          state.codex.engineMenu = null;
          state.codex.agentPeek = null;
        }
        emit();
      },
      closeMessageMenu() {
        if (!state.codex.messageMenu) return;
        state.codex.messageMenu = null;
        emit();
      },
      // CHAT-07: one peek at a time, opened beside the face or name that was pressed.
      toggleAgentPeek(threadId, messageId, anchorEl = null) {
        if (!threadId || !messageId) return;
        if (state.codex.agentPeek?.threadId === threadId && state.codex.agentPeek.messageId === messageId) {
          state.codex.agentPeek = null;
        } else {
          const rect = anchorEl?.getBoundingClientRect?.();
          // Left-aligned with the face: the anchor's right edge is pushed out by the panel width.
          const placement = rect ? resolveFloatingMenuPlacement({ top: rect.top, bottom: rect.bottom, right: rect.left + 288 }, 288, 300) : { left: 12, top: 12 };
          state.codex.agentPeek = { threadId, messageId, ...placement, returnFocusKey: anchorEl?.dataset?.focusKey || null };
          state.codex.threadMenu = null;
          state.codex.memberMenu = null;
          state.codex.engineMenu = null;
          state.codex.messageMenu = null;
          // A failed read is tried again each time the peek opens.
          for (const [profileId, entry] of agentProfileDetails) if (entry.status === 'error') agentProfileDetails.delete(profileId);
        }
        emit();
      },
      closeAgentPeek() {
        if (!state.codex.agentPeek) return;
        state.codex.agentPeek = null;
        emit();
      },
      // The room Agent's saved settings for the peek, read once per active
      // revision; the read finishing redraws. Returns { status, detail }.
      agentProfileDetail(profileId, revision = null) {
        if (!ChatState.isProfileId(profileId)) return null;
        const cached = agentProfileDetails.get(profileId);
        if (cached && cached.revision === revision) return cached;
        const entry = { status: 'loading', detail: cached?.detail || null, revision };
        agentProfileDetails.set(profileId, entry);
        fetchJson(`/profiles/${encodeURIComponent(profileId)}`)
          .then((detail) => { entry.status = 'ready'; entry.detail = detail; })
          .catch(() => { entry.status = 'error'; })
          .finally(() => { if (agentProfileDetails.get(profileId) === entry) emit(); });
        return entry;
      },
      selectThread(threadId, options = {}) {
        if (!threadId) return;
        if (!setActiveThread(threadId)) return;
        state.codex.memberMenu = null;
        state.codex.threadMenu = null;
        state.codex.engineMenu = null;
        state.codex.messageMenu = null;
        state.codex.agentPeek = null;
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
          const bridgeState = await fetchJson('/v1/state', { signal: token.signal, headers: await bridgeStateHeaders() });
          if (!epochScope.valid(token)) return;
          engineStatus.cancel();
          const status = bridgeState?.auth || state.codex.authStatus;
          update({
            provider: bridgeState?.provider || state.codex.provider,
            protocolVersion: Number(bridgeState?.protocolVersion || state.codex.protocolVersion || 0),
            authStatus: status,
            isStartingLogin: Boolean(status.loginInProgress),
            error: null,
            bridgeBuild: bridgeConnectionFields(bridgeState).bridgeBuild,
            ...bridgeEngineFields(bridgeState),
            ...bridgeSessionFields(bridgeState),
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
      // '다시 시도' after a network failure: the same words go out once more on an
      // explicit click, only into an empty composer. Attachments are not re-sent.
      retryRun(threadId, runId) {
        const thread = getCodexThreadById(state.codex, threadId);
        if (!thread || threadBusy(thread)) return null;
        const run = codexRuns(thread).find((item) => item.runId === runId);
        const prompt = thread.messages.findLast((message) => message.role === 'user' &&
          ((run?.requestId && message.requestId === run.requestId) || (runId && message.runId === runId)));
        if (!prompt?.content) { boardNotice('다시 보낼 메시지를 찾지 못했습니다.'); return null; }
        // A plan step resumed in place is not 대표님's message to send again.
        if (ChatState.awaitResumeMessageView(prompt)) { boardNotice('계획 단계에서 이어진 실행은 다시 보내지 않습니다. 작업 목록에서 상태를 확인해 주세요.'); return null; }
        if (getCodexThreadDraft(state.codex, threadId).trim()) {
          boardNotice('입력 중인 내용이 있어 다시 보내지 않았습니다. 입력창을 비운 뒤 다시 시도해 주세요.');
          return null;
        }
        state.codex.activeThreadId = threadId;
        this.setDraft(prompt.content, threadId);
        return this.sendMessage();
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
        const selectedBrowserSources = browserToolSelectedSources(activeThread.id, selectedInputs);
        const requestedBrowserInteraction = selectedInputs.some(input => input.kind === 'browser' &&
          input.selectedByUser === true && input.browserToolPermission === 'interact');
        if (requestedBrowserInteraction && !selectedBrowserSources.some(input => input.browserToolPermission === 'interact')) {
          updateThreadById(activeThread.id, thread => ({ ...thread,
            sendError: '선택한 Browser 조작 권한이 만료됐습니다. 현재 Browser에서 다시 선택해 주세요.' }));
          epochScope.finish(token);
          return;
        }
        const browserSseStatus = rootSseReady();
        const selectedBrowserTransportId = browserSseStatus.browserTransportId;
        if (selectedBrowserSources.length && !browserSseStatus.sourceReady) {
          updateThreadById(activeThread.id, thread => ({ ...thread,
            sendError: '선택한 Browser 연결이 바뀌었습니다. Browser를 다시 선택한 뒤 전송해 주세요.' }));
          epochScope.finish(token);
          return;
        }
        // The first send ties the room to its engine (D3) and makes it the app's recent one (D4).
        const engineId = ChatState.chatThreadEngineId(getCodexThreadById(state.codex, activeThread.id) || activeThread,
          { recentEngineId: state.codex.recentEngineId, engines: state.codex.engines });
        updateThreadById(activeThread.id, thread => thread.engineId === engineId ? thread : { ...thread, engineId });
        state.codex.recentEngineId = engineId;
        const authorProfile = activeThread.profileEnabled ? codexThreadAgentProfile(activeThread) : null;
        ChatState.registerChatRequest(protocol, { requestId, clientThreadId: ChatState.clientThreadBinding(activeThread), localThreadId: activeThread.id, conversationId: activeThread.conversationId, authorName: authorProfile ? authorProfile.name : 'Codex', ...(authorProfile?.avatar ? { authorAvatar: authorProfile.avatar } : {}) }, state.codex.authStatus);
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
          runtimeConfig.engineId = engineId;
          // The model and effort the panel shows: a listed model with its effort, or nothing for '기본 모델'.
          const sendingThread = getCodexThreadById(state.codex, activeThread.id) || activeThread;
          const modelFields = ChatState.chatModelSendFields(sendingThread, ChatState.chatModelView(sendingThread, {
            engineId, engines: state.codex.engines, auth: state.codex.authStatus, engineConfiguration: state.codex.engineConfiguration }));
          runtimeConfig.model = modelFields.model;
          runtimeConfig.effort = modelFields.effort;
          runtimeConfig.contextSnapshotIds = inputReferences.map(reference => reference.snapshotId);
          runtimeConfig.contextCapabilities = ChatState.contextCapabilitiesForRequest(activeThread, state.codex.authStatus, runtimeConfig.contextSnapshotIds);
          runtimeConfig.stateless = ChatState.chatStatelessStartView(activeThread, state.codex.chatCapabilities).on;
          const chatRequest = ChatState.buildChatRequest(activeThread, content, requestId, runtimeConfig);
          if (selectedBrowserSources.length) {
            chatRequest.selectedSources = selectedBrowserSources;
            chatRequest.browserTransportId = selectedBrowserTransportId;
            // The one-time UI selection belongs to this send. The native
            // envelope cannot create or renew a Browser interaction grant.
            chatRequest.executionPolicy = { mode: 'browserBounded' };
          }
          const result = await fetchJson('/chat/send', {
            method: 'POST',
            signal: token.signal,
            body: JSON.stringify(chatRequest),
          });
          if (!epochScope.valid(token)) return;
          const run = ChatState.acceptChatRequest(protocol, result, requestId);
          if (run) {
            // CHAT-09: the reply confirms a one-time start; a bounded run keeps the room from branching.
            if (chatRequest.stateless || chatRequest.executionPolicy) updateThreadById(activeThread.id, thread => ({ ...thread,
              ...(chatRequest.stateless ? { stateless: result.stateless === true, startStateless: false } : {}),
              ...(chatRequest.executionPolicy ? { executionBounded: true } : {}) }));
            // Codex keeps a named model for later turns; going back to the default must name it.
            if (chatRequest.model) updateThreadById(activeThread.id, thread => ({ ...thread, sentModel: chatRequest.model, nameModelNext: false }));
            syncProtocolRun(run);
          } else {
            const error = new Error(result.error || '실행 접수 상태를 확인하지 못했습니다.');
            error.status = result.accepted === false ? 400 : 0;
            error.code = typeof result.code === 'string' ? result.code : null;
            error.conversationId = result.conversationId || null;
            error.accepted = result.accepted;
            error.resumeRequired = result.resumeRequired;
            throw error;
          }
        } catch (error) {
          if (!epochScope.valid(token)) return;
          const request = protocol.requests[requestId];
          if (error.code === 'BROWSER_TOOLS_UNAVAILABLE') {
            error.message = '이 대화는 Browser 조작 도구가 등록되기 전에 만들어졌습니다. 기존 기록과 초안은 유지됩니다. 새 Chat을 만든 뒤 Browser에서 이번 실행의 조작 대상을 다시 선택해 주세요.';
          }
          const profileText = ChatState.profileSendErrorText(error.code) || ChatState.chatStatelessErrorText(error.code)
            || ChatState.chatModelSendErrorText(error.code);
          if (profileText) error.message = profileText;
          // A refused model or effort returns the room's choice to the default.
          const modelReset = ChatState.chatModelRejectionReset(error.code);
          if (modelReset) updateThreadById(activeThread.id, thread => ({ ...thread, ...modelReset }));
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

  function toggleHUD(appId, appLabel, options = {}) {
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
      if (options.preserveConversation && getCodexThreadById(state.codex, state.codex.activeThreadId)) {
        state.codex.hudView = 'conversation';
      } else {
        state.codexBridge.openHudHome?.();
      }
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
    toggleHUD('chat', '채팅', { preserveConversation: true });
  }

  const CHAT_ZOOM_GAP = 8;

  function visibleChatZoomRect() {
    const indicator = document.getElementById('egd-zoom-indicator');
    if (!indicator) return null;
    const style = window.getComputedStyle(indicator);
    const rect = indicator.getBoundingClientRect();
    return style.display !== 'none' && style.visibility === 'visible' &&
      Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function fitCodexChatCardToReadableViewport(card, safe, bodyFontPx) {
    if (!card || !safe || !Number.isFinite(safe.height) || safe.height <= 0) return false;
    if (card.classList.contains('egd-card-fullscreen')) {
      if (!card.style.maxHeight) return false;
      card.style.maxHeight = '';
      return true;
    }
    // Semantic focus raises Chat to this readable font size. A Card sized at
    // the old, smaller camera zoom can otherwise put its composer below Dock.
    const fontPx = Number.isFinite(bodyFontPx) && bodyFontPx > 0 ? bodyFontPx : 14;
    const readableZoom = Math.min(ZOOM_MAX, Math.max(0.76, 10.6 / fontPx));
    const style = window.getComputedStyle(card);
    const minHeight = parsePxNumber(style.minHeight, 420);
    const frameHeight = style.boxSizing === 'border-box' ? 0 :
      parsePxNumber(style.borderTopWidth) + parsePxNumber(style.borderBottomWidth) +
      parsePxNumber(style.paddingTop) + parsePxNumber(style.paddingBottom);
    // Projection centers the inline content height, leaving half the spare
    // space below. Reserve twice the frame so its outer bottom also fits.
    const dockLimit = Math.floor(safe.height / readableZoom - frameHeight * 2);
    const savedHeight = parsePxNumber(card.style.height, minHeight);
    let presentationHeight = dockLimit >= minHeight ? Math.min(savedHeight, dockLimit) : savedHeight;

    const zoomRect = visibleChatZoomRect();
    const cardRect = card.getBoundingClientRect();
    const cameraZoom = state.zoom;
    if (zoomRect && Number.isFinite(cameraZoom) && cameraZoom > 0 &&
        cardRect.left < zoomRect.right && cardRect.right > zoomRect.left &&
        cardRect.top < zoomRect.bottom &&
        cardRect.top + (presentationHeight + frameHeight) * cameraZoom > zoomRect.top) {
      // Only the visible Chat box contracts. The inline world height remains
      // the saved/user size, and the message log already owns vertical scroll.
      const zoomLimit = Math.floor((zoomRect.top - CHAT_ZOOM_GAP - cardRect.top) / cameraZoom - frameHeight);
      presentationHeight = Math.min(presentationHeight, Math.max(minHeight, zoomLimit));
    }
    const nextMaxHeight = presentationHeight < savedHeight ? `${presentationHeight}px` : '';
    if (card.style.maxHeight === nextMaxHeight) return false;
    card.style.maxHeight = nextMaxHeight;
    return true;
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
    const placement = resolveCanvasCardPlacement('chat', { anchorClientX, anchorClientY, avoidHud: true });
    const { width, height } = placement;
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
      el('div', { class: 'egd-chat-card-title-group' },
        el('span', { class: 'egd-window-grip', 'aria-hidden': 'true' }, deskIcon('grip')),
        deskIcon('chat', 'egd-ui-icon egd-window-kind-icon'),
        el('div', { class: 'egd-chat-card-title' }, '채팅'),
      ),
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
        }, deskIcon('close')),
      ),
    );
    const body = el('div', { class: 'egd-chat-card-body' });
    card.appendChild(header);
    card.appendChild(body);

    const host = document.getElementById('egd-canvas-layer') || document.documentElement;
    host.appendChild(card);
    fitCodexChatCardToReadableViewport(card, safe,
      parsePxNumber(window.getComputedStyle(body).fontSize, 14));
    bindCardSourceRef(card, currentChatSourceRef());
    markAgendaDirty('create-chat-card', card);
    setActiveEntity(card);
    revealPlacedCanvasCard(card, placement);

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
      document.documentElement.classList.remove('egd-browser-fullscreen-active');
      if (state.surface.initialBrowserFocus) {
        state.surface.initialBrowserFocus = false;
        document.documentElement.classList.remove('egd-initial-browser-focus');
      }
      syncViewportAgendaRail();
      return;
    }
    const zoom = canvasZoom();
    const isBrowserFullscreen = card.classList.contains('egd-browser-card');
    const safe = safeViewportRect({ avoidHud: false, margin: (state.surface.initialBrowserFocus || isBrowserFullscreen) ? 0 : 10 });
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
    // Browser cards go Chrome-like: hide Desk chrome, edge-to-edge browser area.
    if (card.classList.contains('egd-browser-card')) {
      document.documentElement.classList.add('egd-browser-fullscreen-active');
    }
    setHudPresentationHidden(true);
    if (previousMinimapOpen) closeDeskMinimap();
    syncCardFullscreenLayout();
    syncViewportAgendaRail();
  }

  function exitCardFullscreen(card = null, options = {}) {
    const fullscreen = state.cardFullscreen;
    if (!fullscreen) return false;
    if (card && fullscreen.cardId !== card.id) return false;
    const initialBrowserFocus = state.surface.initialBrowserFocus && fullscreen.cardId === state.surface.browserCardId;
    if (initialBrowserFocus) {
      state.surface.initialBrowserFocus = false;
      document.documentElement.classList.remove('egd-initial-browser-focus');
    }
    const fullscreenCard = document.getElementById(fullscreen.cardId);
    if (fullscreenCard) {
      fullscreenCard.classList.remove('egd-card-fullscreen');
      if (options.restoreRect !== false) applyCardRect(fullscreenCard, fullscreen.rect);
    }
    document.documentElement.classList.remove('egd-card-fullscreen-active');
    document.documentElement.classList.remove('egd-browser-fullscreen-active');
    state.cardFullscreen = null;
    setHudPresentationHidden(fullscreen.previousHudHidden);
    if (fullscreen.previousMinimapOpen) toggleDeskMinimap();
    if (initialBrowserFocus && fullscreenCard?.isConnected && options.restoreRect !== false
        && typeof state.setCanvasViewportTarget === 'function') {
      // The first Browser's restoreRect may be the full initial viewport at
      // world (0, 0). Fit the camera into Desk chrome; never rewrite that rect.
      const camera = SurfaceState.fitSurfaceCamera(
        persistentEntityGeometry(fullscreenCard), safeViewportRect({ avoidHud: false }));
      state.setCanvasViewportTarget(camera, { immediate: true });
    }
    if (fullscreenCard?.isConnected) setActiveEntity(fullscreenCard);
    syncViewportAgendaRail();
    if (initialBrowserFocus) scheduleDeskSessionSave();
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
    identity.appendChild(deskIcon({ browser: 'browser', ontology: 'ontology', file: 'file', 'input-evidence': 'file' }[kind] || 'square', 'egd-ui-icon egd-window-kind-icon'));
    const actions = el('div', { class: 'egd-desk-window-actions' });
    const topbar = el('div', { class: 'egd-card-topbar egd-desk-window-titlebar' },
      el('div', { class: 'egd-card-dots-shell' },
        el('div', { class: 'egd-card-dots' }, closeControl, minimizeControl, maximizeControl),
      ),
      el('span', { class: 'egd-window-grip', 'aria-hidden': 'true' }, deskIcon('grip')),
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
  const CANVAS_SHAPE_TITLES = {
    rect: '사각형', ellipse: '원', line: '선', arrow: '화살표',
    path: '펜 그림', label: '글자', highlight: '강조',
  };

  function createCanvasShape(type = 'rect') {
    const shapeType = SurfaceState.CANVAS_SHAPE_TYPES.includes(type) ? type : 'rect';
    const shape = el('div', {
      id: `egd-shape-${++cardSeq}`,
      class: `egd-canvas-shape egd-canvas-shape-${shapeType}`,
      data: { shapeType },
      title: CANVAS_SHAPE_TITLES[shapeType],
      style: { zIndex: String(++cardZ) },
    });
    if (shapeType === 'line' || shapeType === 'arrow') {
      shape.appendChild(el('span', { class: 'egd-canvas-shape-line-stroke' }));
    }
    if (shapeType === 'arrow') {
      shape.appendChild(el('span', { class: 'egd-canvas-shape-arrow-head' }));
    }
    if (shapeType === 'path') {
      const stroke = { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
      shape.appendChild(svgEl('svg', { class: 'egd-canvas-shape-path-svg', 'aria-hidden': 'true', focusable: 'false' },
        svgEl('polyline', { ...stroke, class: 'egd-canvas-shape-path-stroke', stroke: 'currentColor', 'stroke-width': '3', 'pointer-events': 'none' }),
        svgEl('polyline', { ...stroke, class: 'egd-canvas-shape-path-hit', stroke: 'transparent', 'stroke-width': '14', 'pointer-events': 'stroke', cursor: 'move' })));
      shape._pathPoints = [];
    }
    if (shapeType === 'label') {
      shape.appendChild(el('span', { class: 'egd-canvas-shape-label-text', spellcheck: 'false' }));
      shape._labelText = '';
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
    if (type === 'path' || type === 'label') return;
    if (type === 'line' || type === 'arrow') {
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
      width = type === 'ellipse' ? 96 : type === 'highlight' ? 160 : 140;
      height = type === 'ellipse' ? 96 : type === 'highlight' ? 40 : 88;
      left = start.x - width / 2;
      top = start.y - height / 2;
    }
    shape.style.left = `${Math.round(left)}px`;
    shape.style.top = `${Math.round(top)}px`;
    shape.style.width = `${Math.max(12, Math.round(width))}px`;
    shape.style.height = `${Math.max(12, Math.round(height))}px`;
  }

  function renderCanvasPath(shape) {
    const points = (shape._pathPoints || []).map(([x, y]) => `${x},${y}`).join(' ');
    for (const line of shape.querySelectorAll('polyline')) line.setAttribute('points', points);
  }

  // Freehand points are stored relative to the mark's box, so a move only
  // changes the box position.
  function updateCanvasPathGeometry(shape, worldPoints) {
    const box = SurfaceState.canvasPathBox(worldPoints);
    if (!box) return false;
    shape.style.left = `${box.x}px`;
    shape.style.top = `${box.y}px`;
    shape.style.width = `${box.width}px`;
    shape.style.height = `${box.height}px`;
    shape._pathPoints = box.points;
    renderCanvasPath(shape);
    return true;
  }

  function beginCanvasLabelEdit(shape, { created = false } = {}) {
    const text = shape?.querySelector('.egd-canvas-shape-label-text');
    if (!text || shape.dataset.editing === 'true') return false;
    const before = shape._labelText || '';
    let composing = false;
    let finished = false;
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => { composing = false; };
    const onKeydown = (ev) => {
      ev.stopPropagation();
      // A Korean IME confirms the syllable with Enter; only a settled Enter commits.
      if (composing || ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
    };
    // Blur commits an open composition first; read the text after it lands.
    const onBlur = () => window.setTimeout(() => finish(true), 0);
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      text.removeEventListener('compositionstart', onCompositionStart);
      text.removeEventListener('compositionend', onCompositionEnd);
      text.removeEventListener('keydown', onKeydown);
      text.removeEventListener('blur', onBlur);
      for (const name of ['contenteditable', 'role', 'aria-label']) text.removeAttribute(name);
      delete shape.dataset.editing;
      shape._finishLabelEdit = null;
      if (!shape.isConnected) return;
      const value = commit ? SurfaceState.normalizeCanvasLabelText(text.innerText ?? text.textContent) : before;
      if (!value) {
        if (state.activeEntityId === shape.id) setActiveEntity(null);
        shape._cleanup?.();
        shape.remove();
        if (!created) markAgendaDirty('delete-shape', shape);
        return;
      }
      text.textContent = value;
      shape._labelText = value;
      if (value !== before) markAgendaDirty(created ? 'create-shape' : 'edit-shape', shape);
    };
    shape.dataset.editing = 'true';
    text.setAttribute('contenteditable', 'true');
    text.setAttribute('role', 'textbox');
    text.setAttribute('aria-label', '글자 입력');
    text.addEventListener('compositionstart', onCompositionStart);
    text.addEventListener('compositionend', onCompositionEnd);
    text.addEventListener('keydown', onKeydown);
    text.addEventListener('blur', onBlur);
    shape._finishLabelEdit = finish;
    text.focus();
    const selection = window.getSelection?.();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(text);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }

  function finishCanvasLabelEdits() {
    const open = Array.from(document.querySelectorAll('.egd-canvas-shape-label[data-editing="true"]'));
    for (const shape of open) shape._finishLabelEdit?.(true);
    return open.length > 0;
  }

  function installShapeInteractions(shape) {
    let drag = null;
    shape.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if (shape.dataset.editing === 'true') {
        // Caret placement inside the label being typed, not a move.
        ev.stopPropagation();
        return;
      }
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
    if (shape.dataset.shapeType === 'label') {
      shape.addEventListener('dblclick', (ev) => {
        if (shape.dataset.editing === 'true') return;   // word selection while typing
        ev.preventDefault();
        ev.stopPropagation();
        setActiveEntity(shape);
        beginCanvasLabelEdit(shape);
      });
    }
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
    const placement = resolveCanvasCardPlacement('ontology', { avoidHud: false, margin: 12 });
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
        top: placement.y + 'px',
        left: placement.x + 'px',
        width: placement.width + 'px',
        height: placement.height + 'px',
        zIndex: String(++cardZ),
      },
    });
    const card = deskWindow.root;
    revealPlacedCanvasCard(card, placement);
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
    const placement = resolveCanvasCardPlacement('file');
    const shell = spawnDeskWindowShell({ id: `egd-file-card-${++cardSeq}`, kind: 'file', className: 'egd-file-card',
      activate: !options.restore, sourceRef: { kind: 'file-surface', id: `file-view-${chatBindingNonce()}`, scope: 'local-files' },
      style: { left: `${placement.x}px`, top: `${placement.y}px`, width: `${placement.width}px`, height: `${placement.height}px` } });
    const card = shell.root;
    if (!options.restore) revealPlacedCanvasCard(card, placement);
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

  // ============ Settings Canvas Card ============
  // 계정: the real ChatGPT sign-in, plan and usage from the bridge.
  // Agent 관리: Agent Profiles in the local profile store (/profiles).
  function spawnSettingsCard(options = {}) {
    const sourceRef = singletonSourceRef('settings', { kind: 'settings-card' });
    const existing = options.openMode === 'new' ? null : focusOpenSourceCard(sourceRef);
    if (existing) {
      if (options.tab) existing._settingsShowTab?.(options.tab);
      if (options.profileId) existing._settingsOpenProfile?.(options.profileId);
      return existing;
    }

    const id = `egd-settings-card-${++cardSeq}`;
    const placement = resolveCanvasCardPlacement('settings');
    const card = el('div', {
      id,
      class: 'egd-canvas-card egd-settings-card',
      style: {
        top: placement.y + 'px',
        left: placement.x + 'px',
        width: placement.width + 'px',
        height: placement.height + 'px',
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
    let activeTab = options.tab === 'agents' ? 'agents' : 'account';
    const bridge = () => state.codexBridge || null;

    // --- 계정: the signed-in ChatGPT account as the bridge reports it ---
    const renderAccountTab = () => {
      const codex = state.codex;
      const auth = codex.authStatus || {};
      const loginBusy = Boolean(codex.isStartingLogin || auth.loginInProgress);
      const section = el('section', { class: 'egd-settings-section', 'aria-label': 'ChatGPT 계정' },
        el('div', { class: 'egd-settings-section-title' }, 'ChatGPT 계정'));
      if (!codex.connected) {
        section.appendChild(el('div', { class: 'egd-settings-account-card', data: { testid: 'settings-account', state: 'offline' } },
          el('div', { class: 'egd-settings-account-copy' },
            el('div', { class: 'egd-settings-account-title' }, '코덱스에 연결되지 않았습니다'),
            el('div', { class: 'egd-settings-account-sub' }, '이 컴퓨터의 코덱스 연결이 준비되면 계정과 사용 한도를 보여 드립니다.')),
          el('button', { class: 'egd-settings-btn', onclick: () => bridge()?.refreshAuthStatus() }, '상태 새로고침')));
      } else if (!auth.isLoggedIn) {
        section.appendChild(el('div', { class: 'egd-settings-account-card', data: { testid: 'settings-account', state: 'signed-out' } },
          el('div', { class: 'egd-settings-account-copy' },
            el('div', { class: 'egd-settings-account-title' }, '로그인되어 있지 않습니다'),
            el('div', { class: 'egd-settings-account-sub' }, 'ChatGPT 계정으로 로그인하면 대화를 시작하고 사용 한도를 확인할 수 있습니다.')),
          el('button', {
            class: 'egd-settings-btn egd-settings-btn-primary', disabled: loginBusy ? 'true' : null,
            onclick: () => bridge()?.startLogin(),
          }, loginBusy ? '로그인 중…' : '로그인')));
      } else {
        const email = typeof auth.accountEmail === 'string' && auth.accountEmail.trim() ? auth.accountEmail.trim() : null;
        const plan = ChatState.codexPlanLabel(auth.planType);
        section.appendChild(el('div', { class: 'egd-settings-account-card', data: { testid: 'settings-account', state: 'signed-in' } },
          el('span', { class: 'egd-profile-avatar egd-profile-avatar-tone-0 egd-settings-account-avatar', 'aria-hidden': 'true' },
            ChatState.profileAvatarView(null, email || 'C').text),
          el('div', { class: 'egd-settings-account-copy' },
            el('div', { class: 'egd-settings-account-title' }, email || '이메일 확인 안 됨'),
            el('div', { class: 'egd-settings-account-sub' }, 'ChatGPT로 로그인됨',
              el('span', { class: 'egd-settings-plan-badge', data: { testid: 'settings-plan' } }, plan ? `${plan} 요금제` : '요금제 확인 안 됨'))),
          el('button', { class: 'egd-settings-btn', onclick: () => bridge()?.signOut() }, '로그아웃')));
        const ring = ChatState.usageRingView(auth);
        const usage = auth.usage && typeof auth.usage === 'object' ? auth.usage : {};
        const unknown = ring.level === 'unknown';
        section.appendChild(el('div', {
          class: `egd-settings-usage egd-usage-${ring.level}${ring.stale ? ' egd-usage-stale' : ''}`,
          data: { testid: 'settings-usage', level: ring.level }, title: ring.title,
        },
        el('span', { class: 'egd-usage-ring egd-usage-ring-large', 'aria-hidden': 'true', style: ring.percent === null ? null : `--egd-usage-fill: ${ring.percent}%` }),
        el('div', { class: 'egd-settings-usage-copy' },
          el('div', { class: 'egd-settings-usage-title' }, unknown ? '사용 한도 확인 안 됨'
            : [usage.windowLabel, usage.percentLabel].filter((part) => typeof part === 'string' && part).join(' · ') || ring.text),
          el('div', { class: 'egd-settings-usage-sub' }, unknown ? '아직 보고된 사용량이 없습니다.' : ring.resetLabel || '초기화 시각 확인 안 됨'),
          ring.stale ? el('div', { class: 'egd-settings-usage-note' }, '확인한 지 오래되어 실제와 다를 수 있습니다.') : null,
          ring.level === 'limit' ? el('div', { class: 'egd-settings-usage-note egd-settings-usage-note-strong' }, '한도에 도달했습니다. 초기화 전까지는 새 요청이 거절될 수 있습니다.') : null)));
      }
      contentArea.replaceChildren(section, renderConnectedTools(), el('section', { class: 'egd-settings-section', 'aria-label': 'Claude' },
        el('div', { class: 'egd-settings-section-title' }, 'Claude'),
        el('div', { class: 'egd-settings-pending-line', data: { testid: 'settings-claude' } }, '준비 중 — 연결 방식 결정 대기')));
    };

    // --- 연결된 도구 (CU-07): external tools ordinary Codex chats inherit from
    // the user's Codex settings, as the bridge lists them. Blocking them waits
    // for a decision, so there is no switch here.
    const renderConnectedTools = () => {
      // Offline, a list from before may be stale: it reads '확인할 수 없음' until the bridge answers again.
      const view = ChatState.inheritedMcpView(state.codex.connected ? state.codex.inheritedMcp : null);
      const section = el('section', { class: 'egd-settings-section', 'aria-label': '연결된 도구', data: { testid: 'settings-mcp', state: view.status } },
        el('div', { class: 'egd-settings-section-title' }, '연결된 도구'),
        el('p', { class: 'egd-settings-section-sub egd-settings-mcp-intro' }, '코덱스 설정에서 물려받아 일반 대화에서 쓰이는 외부 도구입니다.'));
      if (view.status === 'unknown') {
        section.appendChild(el('div', { class: 'egd-settings-empty', data: { testid: 'settings-mcp-unknown' } }, '확인할 수 없음 · 코덱스 연결이 준비되면 다시 확인합니다.'));
      } else if (view.status === 'empty') {
        section.appendChild(el('div', { class: 'egd-settings-empty', data: { testid: 'settings-mcp-empty' } }, '물려받은 외부 도구가 없습니다.'));
      } else {
        section.appendChild(el('ul', { class: 'egd-settings-mcp-list' }, ...view.rows.map((row) => el('li', {
          class: 'egd-settings-mcp-row', data: { testid: 'settings-mcp-row', kind: row.kind, tone: row.tone },
        },
        el('div', { class: 'egd-settings-mcp-head' },
          el('span', { class: 'egd-settings-mcp-name' }, row.name),
          el('span', { class: 'egd-settings-badge egd-settings-mcp-kind' }, row.kindLabel),
          el('span', { class: `egd-settings-mcp-status egd-settings-mcp-status-${row.tone}` }, row.statusLabel)),
        row.controlsExternal
          ? el('div', { class: 'egd-settings-mcp-note', data: { testid: 'settings-mcp-external' } }, '일반 대화에서 EG-Desk 승인 없이 쓸 수 있는 외부 제어 도구입니다')
          : null))));
      }
      section.appendChild(el('div', { class: 'egd-settings-pending-line', data: { testid: 'settings-mcp-block-pending' } }, '차단 여부 결정 대기'));
      return section;
    };

    // --- Agent 관리: saved Agent Profiles (list → detail → edit) ---
    const agents = { mode: 'list', profileId: null, detail: null, revisions: [], diff: null, form: null, baseRevision: null,
      errors: [], notice: null, keptForm: null, busy: false, showArchived: false, focusField: null };
    const chipInputs = new Map();
    const fieldId = (field) => `${id}-profile-${field}`;
    const profilePath = (profileId, suffix = '') => `/profiles/${encodeURIComponent(profileId)}${suffix}`;
    const profileApi = (path, init) => {
      const api = bridge();
      if (!api?.profileRequest) return Promise.reject(Object.assign(new Error('Profile storage unavailable'), { status: 0 }));
      return api.profileRequest(path, init);
    };
    const refreshCatalog = () => Promise.resolve(bridge()?.loadProfiles?.()).catch(() => {});
    const reloadAfter = (error, profileId) => {
      agents.notice = ChatState.profileRequestErrorText(error);
      if (['PROFILE_REVISION_CONFLICT', 'PROFILE_LIFECYCLE_CONFLICT', 'PROFILE_NOT_FOUND', 'PROFILE_REVISION_NOT_FOUND'].includes(error?.code)) {
        void refreshCatalog();
        if (profileId && error.code !== 'PROFILE_NOT_FOUND') return openProfile(profileId, agents.notice);
        if (error.code === 'PROFILE_NOT_FOUND') { agents.mode = 'list'; agents.profileId = null; }
      }
      agents.busy = false;
      renderAgentsTab();
      return null;
    };
    const openProfile = async (profileId, notice = null) => {
      Object.assign(agents, { mode: 'detail', profileId, notice, diff: null, busy: true, errors: [] });
      if (agents.detail?.id !== profileId) agents.detail = null;
      renderAgentsTab();
      try {
        const [detail, history] = await Promise.all([profileApi(profilePath(profileId)), profileApi(profilePath(profileId, '/revisions'))]);
        if (agents.profileId !== profileId) return;
        agents.detail = detail;
        agents.revisions = Array.isArray(history?.revisions) ? history.revisions : [];
      } catch (error) {
        if (agents.profileId !== profileId) return;
        agents.notice = ChatState.profileRequestErrorText(error);
      } finally {
        if (agents.profileId === profileId && agents.mode === 'detail') { agents.busy = false; renderAgentsTab(); }
      }
    };
    const startEdit = (detail = null) => {
      Object.assign(agents, { mode: 'edit', profileId: detail?.id || null, form: ChatState.profileFormFromBody(detail?.head?.body || null),
        baseRevision: detail?.headRevision ?? null, errors: [], notice: null, keptForm: null, busy: false, diff: null });
      renderAgentsTab();
    };
    const collectPendingChips = () => {
      for (const [field, input] of chipInputs) {
        const value = input.value.trim();
        if (value && !agents.form[field].includes(value)) agents.form[field] = [...agents.form[field], value];
        input.value = '';
      }
    };
    const saveDraft = async () => {
      if (agents.busy) return;
      collectPendingChips();
      const checked = ChatState.validateProfileForm(agents.form);
      if (!checked.ok) {
        agents.errors = checked.errors;
        agents.focusField = checked.errors[0]?.field || null;
        renderAgentsTab();
        return;
      }
      agents.errors = [];
      agents.busy = true;
      renderAgentsTab();
      const editingId = agents.profileId;
      try {
        const saved = editingId
          ? await profileApi(profilePath(editingId, '/draft'), { method: 'PUT', body: { body: checked.body, expectedRevision: agents.baseRevision } })
          : await profileApi('/profiles', { method: 'POST', body: { body: checked.body } });
        void refreshCatalog();
        agents.busy = false;
        await openProfile(saved.id, saved.unchanged ? '바뀐 내용이 없어 새 버전을 만들지 않았습니다.'
          : saved.profile?.lifecycle === 'draft' ? '초안 저장됨 · 아직 사용할 수 없음. 사용 시작을 누르면 대화방에서 고를 수 있습니다.'
            : `버전 ${saved.revision} 초안을 저장했습니다. 사용 시작을 눌러야 대화방에 적용됩니다.`);
      } catch (error) {
        agents.busy = false;
        if (error?.code === 'PROFILE_REVISION_CONFLICT' && editingId) {
          // Load the newest saved content, and keep this edit one click away.
          try {
            const latest = await profileApi(profilePath(editingId));
            agents.keptForm = agents.form;
            agents.form = ChatState.profileFormFromBody(latest.head?.body || null);
            agents.baseRevision = latest.headRevision;
            agents.detail = latest;
            agents.notice = ChatState.PROFILE_CONFLICT_TEXT;
            void refreshCatalog();
          } catch (reloadError) { agents.notice = ChatState.profileRequestErrorText(reloadError); }
          renderAgentsTab();
          return;
        }
        agents.notice = ChatState.profileRequestErrorText(error);
        renderAgentsTab();
      }
    };
    const activateHead = async (detail) => {
      if (agents.busy) return;
      agents.busy = true;
      renderAgentsTab();
      try {
        const view = await profileApi(profilePath(detail.id, '/activate'), { method: 'POST',
          body: { revision: detail.headRevision, expectedActiveRevision: detail.activeRevision ?? null } });
        void refreshCatalog();
        agents.busy = false;
        await openProfile(detail.id, `버전 ${view.activeRevision ?? detail.headRevision}을 사용합니다. 대화방에서 이 Agent를 고를 수 있습니다.`);
      } catch (error) { await reloadAfter(error, detail.id); }
    };
    const LIFECYCLE_NOTICES = {
      disable: '사용을 중지했습니다. 새 대화에서 고를 수 없고, 이 Agent를 쓰던 대화방은 다른 Agent를 골라야 보낼 수 있습니다.',
      archive: '보관함으로 옮겼습니다.',
      restore: '복원했습니다.',
    };
    const changeLifecycle = async (detail, action, name) => {
      if (agents.busy) return;
      if (action === 'delete' && !window.confirm(`'${name}' Agent를 삭제할까요? 삭제하면 되돌릴 수 없고, 이 Agent를 쓰던 대화방은 다른 Agent를 골라야 보낼 수 있습니다.`)) return;
      agents.busy = true;
      renderAgentsTab();
      try {
        await profileApi(profilePath(detail.id, '/lifecycle'), { method: 'POST', body: { action } });
        void refreshCatalog();
        agents.busy = false;
        if (action === 'delete') {
          Object.assign(agents, { mode: 'list', profileId: null, detail: null, notice: `${name} Agent를 삭제했습니다.` });
          renderAgentsTab();
        } else await openProfile(detail.id, LIFECYCLE_NOTICES[action]);
      } catch (error) { await reloadAfter(error, detail.id); }
    };
    const showDiff = async (detail, from, to) => {
      try {
        const result = await profileApi(`${profilePath(detail.id, '/diff')}?from=${from}&to=${to}`);
        if (agents.profileId !== detail.id) return;
        agents.diff = { from: result.from, to: result.to, rows: ChatState.profileDiffRows(result.changes) };
      } catch (error) { agents.notice = ChatState.profileRequestErrorText(error); }
      renderAgentsTab();
    };
    // Going back writes the old content as a new draft; nothing is rewritten in place.
    const revertTo = async (detail, revision) => {
      if (agents.busy) return;
      agents.busy = true;
      renderAgentsTab();
      try {
        const old = await profileApi(profilePath(detail.id, `/revisions/${revision}`));
        const saved = await profileApi(profilePath(detail.id, '/draft'), { method: 'PUT', body: { body: old.body, expectedRevision: detail.headRevision } });
        void refreshCatalog();
        agents.busy = false;
        await openProfile(detail.id, saved.unchanged ? '지금 초안과 같은 내용이라 새 버전을 만들지 않았습니다.'
          : `버전 ${revision} 내용으로 새 초안(버전 ${saved.revision})을 만들었습니다. 사용 시작을 눌러야 적용됩니다.`);
      } catch (error) { await reloadAfter(error, detail.id); }
    };

    const noticeLine = () => agents.notice
      ? el('div', { class: 'egd-settings-notice', role: 'status', data: { testid: 'settings-agent-notice' } }, agents.notice) : null;

    const renderAgentList = () => {
      const reported = bridge()?.profileCatalog?.() || { status: 'unavailable', profiles: [] };
      // Without a bridge connection the catalog can only be stale or empty; say so.
      const catalog = reported.status !== 'ready' && !state.codex.connected ? { ...reported, status: 'unavailable' } : reported;
      const archived = catalog.profiles.filter((profile) => profile.lifecycle === 'archived');
      const shown = catalog.profiles.filter((profile) => (profile.lifecycle === 'archived') === agents.showArchived);
      const section = el('section', { class: 'egd-settings-section', 'aria-label': 'Agent 목록' },
        el('div', { class: 'egd-settings-section-head' },
          el('div', {},
            el('div', { class: 'egd-settings-section-title' }, agents.showArchived ? '보관함' : 'Agent'),
            el('div', { class: 'egd-settings-section-sub' }, '대화방에서 고를 담당자를 만들고 고칩니다. 예시는 처음부터 들어 있는 Agent입니다.')),
          el('button', {
            class: 'egd-settings-btn egd-settings-btn-primary', data: { testid: 'settings-agent-create' },
            disabled: catalog.status === 'ready' ? null : 'true', onclick: () => startEdit(null),
          }, 'Agent 만들기')),
        noticeLine());
      if (catalog.status === 'unavailable') {
        section.appendChild(el('div', { class: 'egd-settings-empty', data: { testid: 'settings-agent-unavailable' } },
          el('p', {}, 'Agent 저장소에 연결하지 못했습니다. 코덱스 연결을 확인한 뒤 다시 불러와 주세요.'),
          el('button', { class: 'egd-settings-btn', onclick: () => { void refreshCatalog(); } }, '다시 불러오기')));
      } else if (catalog.status !== 'ready') {
        section.appendChild(el('div', { class: 'egd-settings-empty', role: 'status' }, '불러오는 중…'));
      } else if (!shown.length) {
        section.appendChild(el('div', { class: 'egd-settings-empty' }, agents.showArchived ? '보관한 Agent가 없습니다.' : '아직 Agent가 없습니다. Agent 만들기로 첫 담당자를 만들어 보세요.'));
      }
      for (const profile of catalog.status === 'ready' ? shown : []) {
        const status = ChatState.profileStatusView(profile);
        section.appendChild(el('button', {
          class: 'egd-settings-agent-row', type: 'button', data: { testid: 'settings-agent-row', profileId: profile.id, lifecycle: profile.lifecycle },
          onclick: () => openProfile(profile.id),
        },
        codexProfileAvatar(profile.avatar, profile.name, 'egd-settings-agent-avatar'),
        el('span', { class: 'egd-settings-agent-info' },
          el('span', { class: 'egd-settings-agent-name' }, profile.name, status.example ? el('span', { class: 'egd-settings-badge' }, '예시') : null),
          el('span', { class: 'egd-settings-agent-desc' }, profile.role || '역할 미설정'),
          el('span', { class: 'egd-settings-agent-status' }, status.detail ? `${status.label} · ${status.detail}` : status.label)),
        el('span', { class: `egd-settings-status-dot egd-settings-status-dot-${status.usable ? 'ok' : 'off'}`, 'aria-hidden': 'true' })));
      }
      if (catalog.status === 'ready' && (archived.length || agents.showArchived)) {
        section.appendChild(el('button', {
          class: 'egd-settings-link', onclick: () => { agents.showArchived = !agents.showArchived; agents.notice = null; renderAgentsTab(); },
        }, agents.showArchived ? '← Agent 목록으로' : `보관함 보기 (${archived.length})`));
      }
      contentArea.replaceChildren(section);
    };

    const detailRow = (label, value) => el('div', { class: 'egd-settings-detail-row' }, el('dt', {}, label), el('dd', {}, value));
    const chipRow = (items, empty) => items.length
      ? el('span', { class: 'egd-settings-chip-row' }, ...items.map((item) => el('span', { class: 'egd-settings-chip' }, item))) : empty;
    const renderAgentDetail = () => {
      const detail = agents.detail;
      const back = el('button', { class: 'egd-settings-link', onclick: () => { Object.assign(agents, { mode: 'list', profileId: null, notice: null, diff: null }); renderAgentsTab(); } }, '← Agent 목록');
      if (!detail) {
        contentArea.replaceChildren(el('section', { class: 'egd-settings-section' }, back, noticeLine(),
          agents.busy ? el('div', { class: 'egd-settings-empty', role: 'status' }, '불러오는 중…') : null));
        return;
      }
      const status = ChatState.profileStatusView(detail);
      const shownRevision = detail.active || detail.head;
      const body = shownRevision?.body || {};
      const editable = ['draft', 'active', 'disabled'].includes(detail.lifecycle);
      const pendingDraft = editable && (detail.hasDraft || detail.lifecycle !== 'active');
      const tone = ChatState.PROFILE_TONE_OPTIONS.find((option) => option.value === body.personality?.tone)?.label || '담백';
      // AGENT-02 사용 준비: the newest saved version (what 사용 시작 turns on) checked
      // field by field. It never blocks 사용 시작; the missing count sits beside it.
      const readiness = editable ? ChatState.profileReadinessView(detail.head?.body || body) : null;
      const readinessCountId = `${id}-agent-readiness-count`;
      const readinessPanel = readiness ? el('section', {
        class: `egd-settings-readiness${readiness.ready ? ' egd-settings-readiness-ready' : ''}`, 'aria-label': '사용 준비',
        data: { testid: 'settings-agent-readiness', missing: String(readiness.missing) },
      },
      el('div', { class: 'egd-settings-readiness-title' }, readiness.title),
      el('ul', { class: 'egd-settings-readiness-list' }, ...readiness.items.map((item) => el('li', {
        class: `egd-settings-readiness-item egd-settings-readiness-item-${item.done ? 'done' : 'missing'}`,
        data: { testid: 'settings-agent-readiness-item', field: item.key, done: String(item.done) },
      },
      el('span', { class: 'egd-settings-readiness-mark', 'aria-hidden': 'true' }),
      item.done ? el('span', { class: 'egd-settings-readiness-label' }, item.label)
        : el('button', { class: 'egd-settings-link egd-settings-readiness-label', type: 'button', 'aria-label': `${item.label} 채우러 가기`,
          disabled: agents.busy ? 'true' : null, onclick: () => { agents.focusField = item.key; startEdit(detail); } }, item.label),
      el('span', { class: 'egd-settings-readiness-state' }, item.state)))),
      el('div', { class: 'egd-settings-readiness-tools' }, `쓸 수 있는 도구: ${readiness.tools}`)) : null;
      const actions = el('div', { class: 'egd-settings-detail-actions' },
        editable ? el('button', { class: 'egd-settings-btn', disabled: agents.busy ? 'true' : null, onclick: () => startEdit(detail) }, '편집') : null,
        pendingDraft ? el('button', { class: 'egd-settings-btn egd-settings-btn-primary', data: { testid: 'settings-agent-activate' }, disabled: agents.busy ? 'true' : null,
          'aria-describedby': readiness?.countText ? readinessCountId : null,
          onclick: () => activateHead(detail) }, `사용 시작 (버전 ${detail.headRevision})`) : null,
        pendingDraft && readiness?.countText ? el('span', { class: 'egd-settings-readiness-count', id: readinessCountId,
          data: { testid: 'settings-agent-readiness-count' } }, readiness.countText) : null,
        detail.lifecycle === 'active' ? el('button', { class: 'egd-settings-btn', disabled: agents.busy ? 'true' : null, onclick: () => changeLifecycle(detail, 'disable', body.name) }, '사용 중지') : null,
        editable ? el('button', { class: 'egd-settings-btn', disabled: agents.busy ? 'true' : null, onclick: () => changeLifecycle(detail, 'archive', body.name) }, '보관') : null,
        detail.lifecycle === 'archived' ? el('button', { class: 'egd-settings-btn', disabled: agents.busy ? 'true' : null, onclick: () => changeLifecycle(detail, 'restore', body.name) }, '복원') : null,
        el('button', { class: 'egd-settings-btn egd-settings-btn-danger', disabled: agents.busy ? 'true' : null, onclick: () => changeLifecycle(detail, 'delete', body.name) }, '삭제'));
      const section = el('section', { class: 'egd-settings-section egd-settings-agent-detail', data: { testid: 'settings-agent-detail', profileId: detail.id } },
        back,
        el('div', { class: 'egd-settings-detail-head' },
          codexProfileAvatar(body.avatar, body.name, 'egd-settings-detail-avatar'),
          el('div', { class: 'egd-settings-agent-info' },
            el('div', { class: 'egd-settings-detail-name' }, body.name || 'Agent', status.example ? el('span', { class: 'egd-settings-badge' }, '예시') : null),
            el('div', { class: 'egd-settings-agent-desc' }, body.role || '역할 미설정'),
            el('div', { class: 'egd-settings-agent-status' }, status.detail ? `${status.label} · ${status.detail}` : status.label))),
        noticeLine(),
        readinessPanel,
        detail.hasDraft && detail.activeRevision ? el('div', { class: 'egd-settings-callout' },
          `저장했지만 아직 쓰지 않은 초안이 있습니다 (버전 ${detail.headRevision}).`,
          el('button', { class: 'egd-settings-link', onclick: () => showDiff(detail, detail.activeRevision, detail.headRevision) }, '사용 중인 버전과 차이 보기')) : null,
        actions,
        el('div', { class: 'egd-settings-subtitle' }, detail.active ? `사용 중인 버전 ${detail.activeRevision} 내용` : `초안 버전 ${detail.headRevision} 내용`),
        el('dl', { class: 'egd-settings-detail-list' },
          detailRow('말투', tone),
          detailRow('성격 특징', chipRow(body.personality?.traits || [], '없음')),
          detailRow('말투 메모', body.personality?.speechNotes || '없음'),
          detailRow('맡길 일', (body.expertise || []).length ? el('ul', { class: 'egd-settings-plain-list' }, ...body.expertise.map((item) => el('li', {}, item))) : '없음'),
          detailRow('지침', body.instructions ? el('div', { class: 'egd-settings-instructions' }, body.instructions) : '없음'),
          detailRow('선호 도구 (표시용)', chipRow(body.toolPreferences || [], '없음')),
          detailRow('쓸 수 있는 도구', ChatState.publicToolCeiling(body.toolCeiling)
            ? el('span', { data: { testid: 'settings-agent-ceiling-summary' } }, ChatState.toolCeilingSummary(body.toolCeiling),
              ...ChatState.toolCeilingNotes(body.toolCeiling).map((note) => el('span', { class: 'egd-settings-ceiling-note' }, note)))
            : el('span', { data: { testid: 'settings-agent-ceiling-summary' } }, ChatState.TOOL_CEILING_OFF_TEXT))));
      if (agents.diff) {
        section.appendChild(el('div', { class: 'egd-settings-diff', data: { testid: 'settings-agent-diff' } },
          el('div', { class: 'egd-settings-subtitle' }, `버전 ${agents.diff.from} → 버전 ${agents.diff.to} 바뀐 점`,
            el('button', { class: 'egd-settings-link', onclick: () => { agents.diff = null; renderAgentsTab(); } }, '닫기')),
          agents.diff.rows.length ? el('dl', { class: 'egd-settings-detail-list' }, ...agents.diff.rows.map((row) => detailRow(row.label,
            el('span', { class: 'egd-settings-diff-values' }, el('del', {}, row.before), el('span', { 'aria-hidden': 'true' }, ' → '), el('ins', {}, row.after)))))
            : el('p', { class: 'egd-settings-section-sub' }, '바뀐 내용이 없습니다.')));
      }
      const versions = el('div', { class: 'egd-settings-versions', data: { testid: 'settings-agent-versions' } },
        el('div', { class: 'egd-settings-subtitle' }, '버전 기록'));
      for (const revision of agents.revisions) {
        const compareFrom = detail.activeRevision && detail.activeRevision !== revision.revision ? detail.activeRevision : revision.parentRevision;
        versions.appendChild(el('div', { class: 'egd-settings-version-row' },
          el('span', { class: 'egd-settings-version-name' }, `버전 ${revision.revision}`,
            revision.revision === detail.activeRevision
              ? el('span', { class: 'egd-settings-badge egd-settings-badge-strong' }, detail.lifecycle === 'active' ? '사용 중' : '마지막 사용 버전') : null,
            revision.revision === detail.headRevision && (detail.hasDraft || !detail.activeRevision) ? el('span', { class: 'egd-settings-badge' }, '최신 초안') : null),
          el('span', { class: 'egd-settings-version-time' }, ChatState.formatResetClock(revision.createdAt) || ''),
          compareFrom ? el('button', { class: 'egd-settings-link', onclick: () => showDiff(detail, compareFrom, revision.revision) }, '차이 보기') : null,
          editable && revision.revision !== detail.headRevision ? el('button', {
            class: 'egd-settings-link', disabled: agents.busy ? 'true' : null, onclick: () => revertTo(detail, revision.revision),
          }, '이 버전으로 되돌리기') : null));
      }
      section.appendChild(versions);
      contentArea.replaceChildren(section);
    };

    const renderAgentForm = () => {
      const form = agents.form;
      const errorFor = (field) => agents.errors.find((error) => error.field === field) || null;
      const field = (key, label, control, hint = null) => {
        const error = errorFor(key);
        return el('div', { class: `egd-settings-field${error ? ' egd-settings-field-invalid' : ''}`, data: { field: key } },
          el('label', { class: 'egd-settings-form-label', for: fieldId(key) }, label),
          control,
          hint ? el('div', { class: 'egd-settings-form-hint' }, hint) : null,
          error ? el('div', { class: 'egd-settings-field-error', role: 'alert' }, error.message) : null);
      };
      const textInput = (key, limit, placeholder) => {
        const input = el('input', { class: 'egd-settings-form-input', type: 'text', id: fieldId(key), maxlength: String(limit), placeholder,
          'aria-invalid': errorFor(key) ? 'true' : null });
        input.value = form[key];
        input.addEventListener('input', () => { form[key] = input.value; });
        return input;
      };
      const textArea = (key, limit, placeholder, rows = 3) => {
        const area = el('textarea', { class: 'egd-settings-form-textarea', id: fieldId(key), maxlength: String(limit), placeholder, rows: String(rows),
          'aria-invalid': errorFor(key) ? 'true' : null });
        area.value = form[key];
        const counter = el('div', { class: 'egd-settings-form-count' }, `${Array.from(area.value).length}/${limit}`);
        area.addEventListener('input', () => { form[key] = area.value; counter.textContent = `${Array.from(area.value).length}/${limit}`; });
        return el('div', { class: 'egd-settings-form-area' }, area, counter);
      };
      const chipList = (key, max, itemMax, placeholder) => {
        const input = el('input', { class: 'egd-settings-form-input', type: 'text', id: fieldId(key), maxlength: String(itemMax), placeholder,
          'aria-invalid': errorFor(key) ? 'true' : null });
        chipInputs.set(key, input);
        const add = () => {
          const value = input.value.trim();
          if (!value || form[key].includes(value) || form[key].length >= max) return;
          form[key] = [...form[key], value];
          agents.focusField = key;
          renderAgentsTab();
        };
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); add(); } });
        return el('div', { class: 'egd-settings-chip-editor' },
          form[key].length ? el('div', { class: 'egd-settings-chip-row' }, ...form[key].map((item, index) => el('span', { class: 'egd-settings-chip' }, item,
            el('button', { class: 'egd-settings-chip-remove', 'aria-label': `${item} 빼기`, onclick: () => {
              form[key] = form[key].filter((_, at) => at !== index);
              agents.focusField = key;
              renderAgentsTab();
            } }, '×')))) : null,
          el('div', { class: 'egd-settings-chip-add' }, input,
            el('button', { class: 'egd-settings-btn', disabled: form[key].length >= max ? 'true' : null, onclick: add }, '추가'),
            el('span', { class: 'egd-settings-form-count' }, `${form[key].length}/${max}`)));
      };
      const preview = codexProfileAvatar(form.avatarValue ? { kind: form.avatarKind, value: form.avatarValue, color: form.avatarColor } : null,
        form.name || '?', 'egd-settings-detail-avatar');
      const avatarInput = el('input', { class: 'egd-settings-form-input egd-settings-avatar-input', type: 'text', id: fieldId('avatar'),
        maxlength: form.avatarKind === 'emoji' ? '32' : '2', placeholder: form.avatarKind === 'emoji' ? '🙂' : '이니셜', 'aria-invalid': errorFor('avatar') ? 'true' : null });
      avatarInput.value = form.avatarValue;
      const syncPreview = () => {
        const view = ChatState.profileAvatarView(form.avatarValue.trim() ? { kind: form.avatarKind, value: form.avatarValue.trim(), color: form.avatarColor } : null, form.name || '?');
        preview.textContent = view.text;
        preview.className = `egd-profile-avatar egd-profile-avatar-tone-${ChatState.PROFILE_AVATAR_PALETTE.indexOf(form.avatarColor) < 0 ? 0 : ChatState.PROFILE_AVATAR_PALETTE.indexOf(form.avatarColor)} egd-settings-detail-avatar`;
      };
      avatarInput.addEventListener('input', () => { form.avatarValue = avatarInput.value; syncPreview(); });
      const segmented = (key, items, labelText) => el('div', { class: 'egd-settings-segmented', role: 'group', 'aria-label': labelText, id: fieldId(key), tabindex: '-1' },
        ...items.map((item) => el('button', {
          class: `egd-settings-segment${form[key] === item.value ? ' egd-settings-segment-active' : ''}`, 'aria-pressed': String(form[key] === item.value),
          onclick: () => { form[key] = item.value; agents.focusField = null; renderAgentsTab(); },
        }, item.label)));
      const swatches = el('div', { class: 'egd-settings-swatches', role: 'group', 'aria-label': '아바타 색', id: fieldId('avatarColor'), tabindex: '-1' },
        ...ChatState.PROFILE_AVATAR_PALETTE.map((color, index) => el('button', {
          class: `egd-settings-swatch egd-profile-avatar-tone-${index}${form.avatarColor === color ? ' egd-settings-swatch-active' : ''}`,
          'aria-pressed': String(form.avatarColor === color), 'aria-label': `색 ${index + 1}`,
          onclick: () => { form.avatarColor = color; renderAgentsTab(); },
        })));
      const nameInput = textInput('name', ChatState.PROFILE_FORM_LIMITS.name, '예: 자료 정리 담당');
      nameInput.addEventListener('input', syncPreview);
      const limits = ChatState.PROFILE_FORM_LIMITS;
      // AGENT-04: '이 Agent가 쓸 수 있는 도구'. Off saves toolCeiling null (today's
      // behavior); on saves the five picks. '묻지 않고 실행' is shown as pending.
      const ceilingOn = form.toolCeilingOn === true;
      const ceilingPick = (axis, value) => {
        form.toolCeiling = { ...form.toolCeiling, [axis]: value };
        agents.focusField = `ceiling-${axis}`;
        renderAgentsTab();
      };
      const ceilingAxisRow = ({ axis, label, options }) => el('div', { class: 'egd-settings-ceiling-row', data: { axis } },
        el('span', { class: 'egd-settings-ceiling-axis', id: fieldId(`ceiling-${axis}-label`) }, label),
        el('div', { class: 'egd-settings-segmented', role: 'group', 'aria-labelledby': fieldId(`ceiling-${axis}-label`), id: fieldId(`ceiling-${axis}`), tabindex: '-1' },
          ...options.map((option) => {
            const active = form.toolCeiling[axis] === option.value;
            return el('button', {
              class: `egd-settings-segment${active ? ' egd-settings-segment-active' : ''}${option.pending ? ' egd-settings-segment-pending' : ''}`,
              type: 'button', 'aria-pressed': String(active), disabled: option.pending ? 'true' : null,
              title: option.pending ? '준비 중입니다. 지금은 실행 전에 묻습니다.' : null,
              data: { testid: 'settings-agent-ceiling-option', axis, value: option.value },
              onclick: () => ceilingPick(axis, option.value),
            }, option.pending ? `${option.label} · 준비 중` : option.label);
          })));
      const ceilingNotes = ceilingOn ? ChatState.toolCeilingNotes(form.toolCeiling) : [];
      const presetId = ceilingOn ? ChatState.toolCeilingPresetId(form.toolCeiling) : null;
      const ceilingSection = el('div', {
        class: `egd-settings-field egd-settings-ceiling${errorFor('toolCeiling') ? ' egd-settings-field-invalid' : ''}`,
        role: 'group', 'aria-labelledby': fieldId('ceiling-title'), data: { field: 'toolCeiling', testid: 'settings-agent-ceiling', on: String(ceilingOn) },
      },
      el('div', { class: 'egd-settings-form-label', id: fieldId('ceiling-title') }, '이 Agent가 쓸 수 있는 도구'),
      el('button', {
        class: `egd-settings-switch${ceilingOn ? ' egd-settings-switch-on' : ''}`, type: 'button', role: 'switch',
        'aria-checked': String(ceilingOn), id: fieldId('toolCeiling'), data: { testid: 'settings-agent-ceiling-switch' },
        onclick: () => { form.toolCeilingOn = !ceilingOn; agents.focusField = 'toolCeiling'; renderAgentsTab(); },
      }, el('span', { class: 'egd-settings-switch-track', 'aria-hidden': 'true' }, el('span', { class: 'egd-settings-switch-thumb' })),
      el('span', { class: 'egd-settings-switch-label' }, '도구 제한 사용')),
      ceilingOn
        ? el('div', { class: 'egd-settings-ceiling-body' },
          el('div', { class: 'egd-settings-ceiling-presets' },
            el('span', { class: 'egd-settings-ceiling-axis' }, '빠르게 고르기'),
            ...ChatState.PROFILE_TOOL_CEILING_PRESETS.map((preset) => el('button', {
              class: `egd-settings-btn${presetId === preset.id ? ' egd-settings-btn-selected' : ''}`, type: 'button',
              'aria-pressed': String(presetId === preset.id), data: { testid: 'settings-agent-ceiling-preset', preset: preset.id },
              onclick: () => { form.toolCeiling = { ...preset.ceiling }; agents.focusField = 'toolCeiling'; renderAgentsTab(); },
            }, preset.label))),
          ...ChatState.PROFILE_TOOL_CEILING_AXES.map(ceilingAxisRow),
          ...ceilingNotes.map((note) => el('div', { class: 'egd-settings-ceiling-note', role: 'note', data: { testid: 'settings-agent-ceiling-note' } }, note)))
        : el('div', { class: 'egd-settings-form-hint', data: { testid: 'settings-agent-ceiling-off' } }, ChatState.TOOL_CEILING_OFF_TEXT),
      errorFor('toolCeiling') ? el('div', { class: 'egd-settings-field-error', role: 'alert' }, errorFor('toolCeiling').message) : null);
      const section = el('section', { class: 'egd-settings-section egd-settings-agent-form', data: { testid: 'settings-agent-form' } },
        el('button', { class: 'egd-settings-link', onclick: () => {
          if (agents.profileId) void openProfile(agents.profileId); else { agents.mode = 'list'; renderAgentsTab(); }
        } }, '← 돌아가기'),
        el('div', { class: 'egd-settings-detail-name' }, agents.profileId ? 'Agent 편집' : 'Agent 만들기'),
        agents.errors.length ? el('div', { class: 'egd-settings-error-summary', role: 'alert', data: { testid: 'settings-agent-errors' } },
          el('div', {}, '저장하지 못했습니다. 아래 항목을 확인해 주세요.'),
          el('ul', {}, ...agents.errors.map((error) => el('li', {}, el('button', { class: 'egd-settings-link', onclick: () => document.getElementById(fieldId(error.field))?.focus() }, error.message))))) : null,
        noticeLine(),
        agents.keptForm ? el('button', { class: 'egd-settings-btn', onclick: () => { agents.form = agents.keptForm; agents.keptForm = null; agents.notice = null; renderAgentsTab(); } }, '내 수정 다시 넣기') : null,
        field('name', '담당자 이름 (필수)', nameInput),
        field('avatar', '아바타', el('div', { class: 'egd-settings-avatar-editor' }, preview,
          el('div', { class: 'egd-settings-avatar-controls' },
            segmented('avatarKind', [{ value: 'initial', label: '이니셜' }, { value: 'emoji', label: '이모지' }], '아바타 종류'),
            avatarInput, swatches)), '비워 두면 이름의 첫 글자를 씁니다.'),
        errorFor('avatarColor') ? el('div', { class: 'egd-settings-field-error', role: 'alert' }, errorFor('avatarColor').message) : null,
        field('role', '역할 한 줄', textInput('role', limits.role, '예: 회의 자료를 읽고 요점을 정리합니다')),
        field('tone', '말투', segmented('tone', ChatState.PROFILE_TONE_OPTIONS, '말투')),
        field('traits', `성격 특징 (최대 ${limits.traits}개)`, chipList('traits', limits.traits, limits.traitLength, '예: 꼼꼼함')),
        field('speechNotes', '말투 메모', textArea('speechNotes', limits.speechNotes, '예: 결론을 먼저 말하고 근거는 짧게', 2)),
        field('expertise', `맡길 일 (최대 ${limits.expertise}개)`, chipList('expertise', limits.expertise, limits.expertiseLength, '예: 주간 보고 초안 쓰기')),
        field('instructions', '지침', textArea('instructions', limits.instructions, '이 Agent가 늘 지켜야 할 내용을 적어 주세요.', 6)),
        field('toolPreferences', '선호 도구 (표시용)', chipList('toolPreferences', limits.toolPreferences, limits.toolLength, '예: browser'),
          '표시용입니다. 실제로 쓸 수 있는 도구는 아래에서 정합니다.'),
        ceilingSection,
        el('div', { class: 'egd-settings-form-actions' },
          el('button', { class: 'egd-settings-btn', onclick: () => {
            if (agents.profileId) void openProfile(agents.profileId); else { agents.mode = 'list'; agents.notice = null; renderAgentsTab(); }
          } }, '취소'),
          el('button', { class: 'egd-settings-btn egd-settings-btn-primary', data: { testid: 'settings-agent-save' },
            disabled: agents.busy ? 'true' : null, onclick: () => { void saveDraft(); } }, agents.busy ? '저장 확인 중…' : '초안 저장')));
      contentArea.replaceChildren(section);
    };

    const renderAgentsTab = () => {
      if (activeTab !== 'agents') return;
      chipInputs.clear();
      if (agents.mode === 'edit' && agents.form) renderAgentForm();
      else if (agents.mode === 'detail') renderAgentDetail();
      else renderAgentList();
      if (agents.focusField) {
        document.getElementById(fieldId(agents.focusField))?.focus();
        agents.focusField = null;
      }
    };

    const tabs = el('div', { class: 'egd-settings-tabs', role: 'tablist' });
    const tabDefs = [
      { id: 'account', label: '계정', render: renderAccountTab },
      { id: 'agents', label: 'Agent 관리', render: renderAgentsTab },
    ];
    const renderTabs = () => {
      tabs.textContent = '';
      for (const t of tabDefs) {
        tabs.appendChild(el('button', {
          class: 'egd-settings-tab' + (activeTab === t.id ? ' egd-settings-tab-active' : ''), role: 'tab',
          'aria-selected': String(activeTab === t.id), data: { testid: `settings-tab-${t.id}` },
          onclick: () => { activeTab = t.id; renderTabs(); t.render(); },
        }, t.label));
      }
    };
    card._settingsShowTab = (tab) => {
      const target = tabDefs.find((t) => t.id === tab);
      if (!target) return;
      activeTab = target.id;
      renderTabs();
      target.render();
    };
    // CHAT-07 [Agent 설정 열기]: the Agent's detail; an open edit form is never discarded.
    card._settingsOpenProfile = (profileId) => {
      if (!ChatState.isProfileId(profileId)) return;
      activeTab = 'agents';
      renderTabs();
      if (agents.mode === 'edit') { renderAgentsTab(); return; }
      void openProfile(profileId);
    };

    // Live account and catalog changes re-render the list views only; an open
    // form is never redrawn under the user's typing.
    let unsubscribeCodex = null;
    let subscribeAttempts = 0;
    let lastCodexSignature = '';
    const onCodexChange = () => {
      const codex = state.codex;
      const auth = codex.authStatus || {};
      const catalog = bridge()?.profileCatalog?.();
      const signature = JSON.stringify([codex.connected, codex.isStartingLogin, auth.isLoggedIn, auth.loginInProgress, auth.accountEmail,
        auth.planType, auth.usage, auth.rateLimits, catalog?.status, catalog?.profiles, codex.inheritedMcp]);
      if (signature === lastCodexSignature) return;
      lastCodexSignature = signature;
      if (activeTab === 'account') renderAccountTab();
      else if (agents.mode === 'list') renderAgentsTab();
    };
    const ensureCodexSubscription = () => {
      if (unsubscribeCodex || (!card.isConnected && subscribeAttempts > 0)) return;
      const api = bridge();
      if (api?.subscribe) { unsubscribeCodex = api.subscribe(onCodexChange); return; }
      if (++subscribeAttempts <= 30) window.setTimeout(ensureCodexSubscription, 1000);
    };
    const shell = el('div', { class: 'egd-settings-shell' },
      el('div', { class: 'egd-settings-header' },
        el('div', { class: 'egd-settings-header-title' }, '상세 설정'),
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
    revealPlacedCanvasCard(card, placement);

    renderTabs();
    (activeTab === 'agents' ? renderAgentsTab : renderAccountTab)();
    if (activeTab === 'agents' && ChatState.isProfileId(options.profileId)) void openProfile(options.profileId);
    ensureCodexSubscription();

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
      unsubscribeCodex?.();
      unsubscribeCodex = null;
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

  // This is the privileged-UI end of the Browser model-tool transport. It
  // deliberately never uses resolveBrowserCard's active/first-card fallback.
  const browserToolRunBindings = new Map();
  const browserToolPendingBindings = new Map();
  const browserToolUserSelections = new Map();
  const browserToolCancelledRuns = new Map();
  // Stop must also cover a first bind still in transit, before any Card key exists.
  const browserToolStoppedRuns = new Set();
  const browserToolRequestReceipts = new Map();
  const browserToolCardLeases = new Map();
  const browserToolActionLeases = new Map();
  const browserToolFixtureAuthorizationByCard = new Map();
  let browserToolFixtureLastAction = null;
  let browserToolAuthorityEpoch = 0;
  function revokeBrowserToolRunImmediately(run, thread) {
    const runId = run?.runId;
    const clientThreadId = run?.clientThreadId || ChatState.clientThreadBinding(thread);
    if (typeof runId !== 'string' || !runId || !clientThreadId) return 0;
    browserToolStoppedRuns.add(JSON.stringify([runId, clientThreadId]));
    const prefix = `${runId}\u0000`;
    const revoked = new Set();
    for (const [key, bound] of browserToolRunBindings) {
      if (!key.startsWith(prefix) || bound.clientThreadId !== clientThreadId) continue;
      browserToolRunBindings.delete(key);
      if (bound.selectionToken) browserToolUserSelections.delete(bound.selectionToken);
      revoked.add(key);
    }
    for (const [key, pending] of browserToolPendingBindings) {
      if (!key.startsWith(prefix) || pending.clientThreadId !== clientThreadId) continue;
      browserToolPendingBindings.delete(key);
      if (pending.selectionToken) browserToolUserSelections.delete(pending.selectionToken);
      revoked.add(key);
    }
    for (const [leaseId, lease] of browserToolActionLeases) {
      if (revoked.has(lease.key)) browserToolActionLeases.delete(leaseId);
    }
    const expiresAt = Date.now() + 60000;
    for (const key of revoked) browserToolCancelledRuns.set(key, expiresAt);
    return revoked.size;
  }
  // BRW-13 [일시중지]: the Stop revocation above, scoped to one Card rather than
  // one run. Every run's binding, pending bind, unused selection and in-flight
  // action lease on this Card ends, and those keys refuse new dispatch. Input
  // already authorized is not recalled. Returns the Chats whose run held it.
  function revokeBrowserToolCard(cardId) {
    const threads = new Set();
    if (typeof cardId !== 'string' || !cardId) return threads;
    const onCard = key => key.includes(`\u0000${cardId}\u0000`);
    const revoked = new Set();
    for (const [key, bound] of browserToolRunBindings) {
      if (!onCard(key) && bound?.binding?.cardId !== cardId) continue;
      browserToolRunBindings.delete(key);
      if (bound.selectionToken) browserToolUserSelections.delete(bound.selectionToken);
      if (bound.clientThreadId) threads.add(bound.clientThreadId);
      revoked.add(key);
    }
    for (const [key, pending] of browserToolPendingBindings) {
      if (!onCard(key)) continue;
      browserToolPendingBindings.delete(key);
      if (pending.selectionToken) browserToolUserSelections.delete(pending.selectionToken);
      if (pending.clientThreadId) threads.add(pending.clientThreadId);
      revoked.add(key);
    }
    for (const [token, selection] of browserToolUserSelections) {
      if (selection.cardId === cardId) browserToolUserSelections.delete(token);
    }
    for (const [leaseId, lease] of browserToolActionLeases) {
      if (!revoked.has(lease.key) && lease.card?.id !== cardId) continue;
      try { lease.projection?.clear(); } catch {}
      browserToolActionLeases.delete(leaseId);
    }
    const expiresAt = Date.now() + 60000;
    for (const key of revoked) browserToolCancelledRuns.set(key, expiresAt);
    return threads;
  }
  // BRW-13 display: the permission a live Agent run holds on this Card, if any.
  function browserToolCardPermission(cardId) {
    let permission = null;
    for (const [key, bound] of browserToolRunBindings) {
      if (bound?.binding?.cardId !== cardId || browserToolCancelledRuns.has(key)) continue;
      if (bound.permission === 'interact') return 'interact';
      if (bound.permission === 'observe') permission = 'observe';
    }
    return permission;
  }
  function registerBrowserToolSelection(threadId, source, permission) {
    const thread = getCodexThreadById(state.codex, threadId);
    const clientThreadId = thread && ChatState.clientThreadBinding(thread);
    if (!['observe', 'interact'].includes(permission) || !source?.browserToolIdentity ||
        !clientThreadId || browserToolUserSelections.size >= 256) return null;
    const card = document.getElementById(source.sourceRef?.viewId);
    if (!card?.isConnected || !card.classList?.contains('egd-browser-card')) return null;
    try {
      const current = card._browserControls?.toolBinding?.();
      if (!current || !browserToolSameUrl(current.url, source.sourceRef.uri) ||
          current.profileId !== source.sourceRef.profileId || current.accountId !== source.sourceRef.accountId ||
          ['cardEpoch', 'userContextId', 'engineAccountKey', 'authorityEpoch'].some(field =>
            current[field] !== source.browserToolIdentity[field])) return null;
    } catch { return null; }
    const token = chatBindingNonce();
    const selected = { ...source, selectedByUser: true, browserToolPermission: permission,
      browserToolSelection: { token, threadId: clientThreadId } };
    browserToolUserSelections.set(token, {
      token, threadId: clientThreadId, localThreadId: threadId,
      sourceId: selected.id, cardId: selected.sourceRef.viewId,
      cardEpoch: selected.browserToolIdentity.cardEpoch,
      profileId: selected.sourceRef.profileId, accountId: selected.sourceRef.accountId,
      selectedUrl: selected.sourceRef.uri, userContextId: selected.browserToolIdentity.userContextId,
      engineAccountKey: selected.browserToolIdentity.engineAccountKey,
      authorityEpoch: selected.browserToolIdentity.authorityEpoch,
      permission, usedRunId: null,
    });
    return selected;
  }
  function browserToolSelectedSources(threadId, candidates = null) {
    const thread = getCodexThreadById(state.codex, threadId);
    const clientThreadId = thread && ChatState.clientThreadBinding(thread);
    return (candidates || thread?.inputSources || []).filter(source => {
      if (source.kind !== 'browser' || source.selectedByUser !== true ||
          !['observe', 'interact'].includes(source.browserToolPermission)) return false;
      const selection = browserToolUserSelections.get(source.browserToolSelection?.token);
      if (!selection || !clientThreadId || selection.localThreadId !== threadId ||
          selection.threadId !== clientThreadId || source.browserToolSelection?.threadId !== clientThreadId ||
          selection.usedRunId ||
          selection.sourceId !== source.id || selection.permission !== source.browserToolPermission) return false;
      const card = document.getElementById(source.sourceRef?.viewId);
      if (!card?.isConnected || !card.classList?.contains('egd-browser-card')) return false;
      try {
        const current = card._browserControls?.toolBinding?.();
        return current && browserToolSameUrl(current.url, source.sourceRef.uri) &&
          current.profileId === source.sourceRef.profileId && current.accountId === source.sourceRef.accountId &&
          current.cardEpoch === source.browserToolIdentity?.cardEpoch &&
          current.userContextId === source.browserToolIdentity?.userContextId &&
          current.engineAccountKey === source.browserToolIdentity?.engineAccountKey &&
          current.authorityEpoch === source.browserToolIdentity?.authorityEpoch;
      } catch { return false; }
    }).map(source => structuredClone(source));
  }
  function browserToolSameUrl(left, right) {
    try { return new URL(left).href === new URL(right).href }
    catch { return false; }
  }
  function browserToolSafeNavigationUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false;
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch { return false; }
  }
  function browserToolFixtureIdentity(cardId) {
    const card = document.getElementById(cardId);
    if (!card?.isConnected || !card.classList?.contains('egd-browser-card')) return null;
    try {
      const binding = card._browserControls?.toolBinding?.();
      return binding?.accountId === '' &&
        /^http:\/\/127\.0\.0\.1:\d+\/egdesk-qa\/[A-Za-z0-9_-]{20,80}$/.test(binding.url)
        ? binding : null;
    } catch { return null; }
  }
  function browserToolFixtureReason(error, phase) {
    const message = String(error?.message || error || '');
    if (/observation is stale|document changed/i.test(message)) return 'stale-observation';
    if (/target.*obscured/i.test(message)) return 'target-obscured';
    if (/target.*(?:changed|unavailable|not found)/i.test(message)) return 'target-changed';
    if (/authority was revoked|lease is missing or expired/i.test(message)) return 'authority-denied';
    if (/already being operated|being operated/i.test(message)) return 'card-busy';
    if (/run was (?:stopped|cancelled)|run binding is missing/i.test(message)) return 'run-ended';
    if (/profile|account epoch|Card generation|context changed/i.test(message)) return 'identity-changed';
    if (/NS_ERROR_[A-Z_]+/.test(message)) return 'gecko-error';
    if (error?.name === 'TypeError' || /TypeError/.test(message)) return 'actor-type-error';
    return phase === 'actor' ? 'actor-exception' : 'ui-rejected';
  }
  function browserToolRecordFixtureAuthorization(lease, reason) {
    const cardId = lease?.card?.id;
    const binding = cardId && browserToolFixtureIdentity(cardId);
    if (binding) browserToolFixtureAuthorizationByCard.set(cardId, {
      requestId: lease.requestId, cardEpoch: binding.cardEpoch,
      authorityEpoch: binding.authorityEpoch, reason,
    });
  }
  // The actor module and chrome overlay can see different JS wrappers for the
  // same Gecko native objects. Require native Node identity and the exact
  // BrowsingContext/document IDs; never accept only a matching Card label.
  function browserToolSameNativeBrowser(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    try { return left.isSameNode?.(right) === true && right.isSameNode?.(left) === true; }
    catch { return false; }
  }
  function browserToolSameNativeContext(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    const id = left?.id;
    const innerWindowId = left?.currentWindowGlobal?.innerWindowId;
    return Number.isSafeInteger(id) && id > 0 && id === right?.id &&
      Number.isSafeInteger(innerWindowId) && innerWindowId > 0 &&
      innerWindowId === right?.currentWindowGlobal?.innerWindowId;
  }
  function browserToolSameNativeWindowGlobal(left, right) {
    if (!left || !right || left.isClosed === true || right.isClosed === true ||
        left.isCurrentGlobal === false || right.isCurrentGlobal === false) return false;
    if (left === right) return true;
    const id = left?.innerWindowId;
    return Number.isSafeInteger(id) && id > 0 && id === right?.innerWindowId &&
      !!left.browsingContext && !!right.browsingContext &&
      browserToolSameNativeContext(left?.browsingContext, right?.browsingContext);
  }
  function browserToolFixtureActionDiagnostic(cardId) {
    const binding = browserToolFixtureIdentity(cardId);
    const recorded = browserToolFixtureLastAction;
    if (!binding || !recorded || recorded.cardId !== cardId ||
        recorded.cardEpoch !== binding.cardEpoch || recorded.authorityEpoch !== binding.authorityEpoch) return null;
    const authorization = browserToolFixtureAuthorizationByCard.get(cardId);
    return { cardId, actionType: recorded.actionType, phase: recorded.phase,
      status: recorded.status, reason: recorded.reason, inputRoute: recorded.inputRoute,
      targetClickObserved: recorded.targetClickObserved,
      authorizationReason: authorization?.requestId === recorded.requestId &&
        authorization.cardEpoch === binding.cardEpoch && authorization.authorityEpoch === binding.authorityEpoch
        ? authorization.reason : null,
      parentReason: recorded.parentReason,
      geckoError: recorded.geckoError, sampledAtMs: recorded.sampledAtMs };
  }
  // Last-observed target geometry is display-only. Never feed this point back
  // into input, hit testing, scrolling, actor guards or reference generation.
  function browserToolDisplayPoint(action, guard) {
    if (!['click', 'fill'].includes(action?.type) || !action.ref || guard?.target?.ref !== action.ref) return null;
    const bounds = guard.target.bounds;
    const width = guard.viewport?.width, height = guard.viewport?.height;
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height, width, height].every(Number.isFinite) ||
        width <= 0 || height <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
    const right = bounds.x + bounds.width, bottom = bounds.y + bounds.height;
    if (!Number.isFinite(right) || !Number.isFinite(bottom) || right <= 0 || bottom <= 0 ||
        bounds.x >= width || bounds.y >= height) return null;
    const x = Math.max(0, Math.min(width, bounds.x + bounds.width / 2)) / width * 100;
    const y = Math.max(0, Math.min(height, bounds.y + bounds.height / 2)) / height * 100;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  function browserToolProjectionCurrent(lease) {
    if (!lease?.authorized || !lease.card?.isConnected || !lease.browser?.isConnected ||
        browserToolActionLeases.get(lease.leaseId) !== lease ||
        browserToolCardLeases.get(lease.cardEpoch) !== lease.requestId ||
        browserToolRunBindings.get(lease.key) !== lease.bound || browserToolCancelledRuns.has(lease.key) ||
        browserToolStoppedRuns.has(JSON.stringify([lease.runId, lease.bound.clientThreadId])) ||
        lease.browser.browsingContext !== lease.browsingContext ||
        lease.browsingContext.currentWindowGlobal !== lease.windowGlobal) return false;
    try {
      const current = lease.card._browserControls.toolBinding();
      return lease.card._browserControls.toolBrowser() === lease.browser &&
        ['cardId', 'cardEpoch', 'profileId', 'accountId', 'userContextId', 'engineAccountKey', 'authorityEpoch']
          .every(field => current[field] === lease.bound.binding[field]);
    } catch { return false; }
  }
  function createBrowserAgentProjection({ card, marker, current, scheduler = window, now = () => Date.now() }) {
    let generation = 0, active = null, frame = 0, timer = 0, disposed = false;
    const hide = () => {
      if (frame) scheduler.cancelAnimationFrame(frame);
      if (timer) scheduler.clearTimeout(timer);
      frame = timer = 0;
      active = null;
      marker.hidden = true;
      delete card.dataset.egdAgentActivity;
    };
    const invalidate = () => { generation++; hide(); };
    const prepare = lease => {
      const epoch = generation;
      let retired = false;
      const valid = () => {
        try {
          return !disposed && epoch === generation && lease.card === card &&
            Number.isSafeInteger(lease.deadlineMs) && now() < lease.deadlineMs && current(lease);
        } catch { return false; }
      };
      return {
        show() {
          if (retired) return;
          retired = true; // One authorization can never resurrect a cleared projection.
          if (!valid()) return;
          hide();
          active = lease;
          card.dataset.egdAgentActivity = 'true';
          const point = lease.displayPoint;
          if (point && [point.x, point.y].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) {
            marker.style.left = `${point.x}%`;
            marker.style.top = `${point.y}%`;
            marker.hidden = false;
          }
          const check = () => {
            if (active !== lease) return;
            frame = 0;
            // Observe existing Stop/revocation state before the next paint;
            // the Stop/input paths themselves do not depend on this display.
            if (!valid()) { invalidate(); return; }
            frame = scheduler.requestAnimationFrame(check);
          };
          frame = scheduler.requestAnimationFrame(check);
          timer = scheduler.setTimeout(() => { if (active === lease) invalidate(); },
            Math.max(0, lease.deadlineMs - now()));
        },
        clear() { retired = true; if (active === lease) invalidate(); },
      };
    };
    return { prepare, invalidate, dispose() { disposed = true; invalidate(); } };
  }
  function browserToolAuthorizePhysicalAction({ browser, browsingContext, windowGlobal,
    leaseId, requestId, deadlineMs, actionType, actionRef, actionUrl }) {
    const lease = browserToolActionLeases.get(leaseId);
    if (!lease) return false;
    const deny = reason => { browserToolRecordFixtureAuthorization(lease, reason); return false; };
    if (lease.authorized) return deny('lease-already-used');
    if (lease.requestId !== requestId) return deny('request-id-mismatch');
    if (lease.deadlineMs !== deadlineMs) return deny('deadline-mismatch');
    if (Date.now() >= deadlineMs) return deny('deadline-expired');
    if (!browserToolSameNativeBrowser(browser, lease.browser)) return deny('browser-identity-mismatch');
    if (!browserToolSameNativeContext(browsingContext, lease.browsingContext)) return deny('browsing-context-identity-mismatch');
    if (!browserToolSameNativeWindowGlobal(windowGlobal, lease.windowGlobal)) return deny('window-global-identity-mismatch');
    if (!browserToolSameNativeWindowGlobal(browsingContext?.currentWindowGlobal, windowGlobal) ||
        !browserToolSameNativeWindowGlobal(lease.browsingContext?.currentWindowGlobal, lease.windowGlobal)) {
      return deny('window-global-not-current');
    }
    if (browserToolRunBindings.get(lease.key) !== lease.bound) return deny('run-binding-changed');
    if (browserToolCancelledRuns.has(lease.key)) return deny('run-cancelled');
    if (browserToolStoppedRuns.has(JSON.stringify([lease.runId, lease.bound.clientThreadId]))) return deny('run-stopped');
    if (browserToolCardLeases.get(lease.cardEpoch) !== requestId) return deny('card-lease-changed');
    if (!lease.card.isConnected) return deny('card-closed');
    if (!browserToolSameNativeBrowser(lease.card._browserControls?.toolBrowser?.(), browser)) {
      return deny('card-browser-mismatch');
    }
    if (lease.bound.permission !== 'interact') return deny('interaction-not-granted');
    if (browserToolUserSelections.get(lease.bound.selectionToken)?.usedRunId !== lease.runId) {
      return deny('selection-run-mismatch');
    }
    if (actionType !== lease.actionType) return deny('action-type-mismatch');
    if (actionRef !== lease.actionRef) return deny('action-ref-mismatch');
    if (actionUrl !== lease.actionUrl) return deny('action-url-mismatch');
    try {
      const current = lease.card._browserControls.toolBinding();
      if (['cardId', 'cardEpoch', 'profileId', 'accountId', 'userContextId', 'engineAccountKey', 'authorityEpoch']
        .some(field => current[field] !== lease.bound.binding[field])) return deny('live-binding-changed');
    } catch { return deny('live-binding-unavailable'); }
    lease.authorized = true;
    browserToolRecordFixtureAuthorization(lease, 'approved');
    // Best-effort projection only: no await, animation gate, input coordinates
    // or success acknowledgement. Display failure cannot change approval.
    try { lease.projection?.show(); } catch { try { lease.projection?.clear(); } catch {} }
    return true;
  }
  // BRW-13: while 대표님 holds a Card, every Agent request for it — a later
  // run's bind included — is refused before any other check; a cancel still
  // cleans up. A hold never grants: only the Card menu's explicit grant does.
  // A Card that cannot answer whether it is held is treated as held.
  function browserToolUserHoldRefusal(request) {
    if (request?.kind === 'cancel') return null;
    let held;
    try { held = document.getElementById(request?.cardId)?._browserControls?.toolUserHold?.(request) === true; }
    catch { held = true; }
    return held ? { requestId: request.requestId, status: 'rejected',
      error: 'The user is operating this Browser Card directly; Agent requests are refused until the user allows control again from the Card' } : null;
  }
  // BRW-13 display-only record of a request that reached the Card. It never
  // feeds authorization, and a display failure never changes the reply.
  function browserToolActivityStart(card, request) {
    try { return card._browserControls.toolActivity?.(request) || null; } catch { return null; }
  }
  function browserToolActivityEnd(activity, response, inputAuthorized) {
    try { activity?.end(response, inputAuthorized === true); } catch {}
  }
  async function browserToolDispatchOnce(request) {
    const requestId = request?.requestId;
    let diagnosticPhase = 'preflight';
    let activity = null, activityLease = null;
    const fail = (error) => {
      const message = String(error?.message || error || 'Browser request rejected').slice(0, 500);
      const binding = request?.kind === 'act' && browserToolFixtureIdentity(request.cardId);
      if (binding) browserToolFixtureLastAction = {
        requestId, cardId: request.cardId, cardEpoch: binding.cardEpoch, authorityEpoch: binding.authorityEpoch,
        actionType: request.action?.type || null, phase: diagnosticPhase, status: 'rejected',
        reason: browserToolFixtureReason(error, diagnosticPhase), inputRoute: null,
        targetClickObserved: null,
        parentReason: message.match(/authority was revoked before input \[([a-z-]+)\]/)?.[1] || null,
        geckoError: message.match(/\bNS_ERROR_[A-Z_]+\b/)?.[0] || null,
        sampledAtMs: Date.now(),
      };
      const rejected = { requestId, status: 'rejected', error: message };
      // Input the parent authorized may have landed: that row stays unknown, not refused.
      browserToolActivityEnd(activity, rejected, activityLease?.authorized === true);
      return rejected;
    };
    try {
      if (request?.version !== 1 || typeof requestId !== 'string' || !requestId ||
          typeof request.runId !== 'string' || !request.runId ||
          typeof request.clientThreadId !== 'string' || !request.clientThreadId ||
          typeof request.cardId !== 'string' || !request.cardId ||
          typeof request.targetCardEpoch !== 'string' || !request.targetCardEpoch ||
          !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= Date.now() ||
          request.deadlineMs > Date.now() + 60000) throw new Error('Invalid or expired Browser tool request');
      const key = `${request.runId}\u0000${request.cardId}\u0000${request.targetCardEpoch}`;
      for (const [cancelledKey, deadline] of browserToolCancelledRuns) {
        if (deadline < Date.now()) browserToolCancelledRuns.delete(cancelledKey);
      }
      if (request.kind === 'cancel') {
        const bound = browserToolRunBindings.get(key);
        if (bound && bound.clientThreadId !== request.clientThreadId) throw new Error('Browser cancel belongs to another Chat');
        browserToolRunBindings.delete(key);
        browserToolPendingBindings.delete(key);
        for (const [leaseId, lease] of browserToolActionLeases) {
          if (lease.key === key) {
            try { lease.projection?.clear(); } catch {}
            browserToolActionLeases.delete(leaseId);
          }
        }
        if (bound?.selectionToken) browserToolUserSelections.delete(bound.selectionToken);
        const pendingSelection = browserToolUserSelections.get(request.selectionToken);
        if (pendingSelection?.threadId === request.clientThreadId &&
            pendingSelection.cardId === request.cardId && pendingSelection.cardEpoch === request.targetCardEpoch) {
          browserToolUserSelections.delete(request.selectionToken);
        }
        browserToolCancelledRuns.set(key, request.deadlineMs);
        return { requestId, status: 'cancelled' };
      }
      if (browserToolStoppedRuns.has(JSON.stringify([request.runId, request.clientThreadId]))) {
        throw new Error('Browser run was stopped');
      }
      if (browserToolCancelledRuns.has(key)) throw new Error('Browser run was cancelled');
      const card = document.getElementById(request.cardId);
      if (!card?.isConnected || !card.classList?.contains('egd-browser-card') ||
          !card._browserControls?.toolBinding) throw new Error('Selected Browser Card is closed');
      if (card._browserControls.toolBinding().cardEpoch !== request.targetCardEpoch) {
        throw new Error('Browser request belongs to a different Card generation');
      }
      if (request.kind === 'bind') {
        const selection = request.selection;
        const current = card._browserControls.toolBinding();
        const selectedByUser = browserToolUserSelections.get(selection?.selectionToken);
        if (browserToolRunBindings.has(key)) throw new Error('Browser run is already bound');
        if (!ChatState.knownCodexAccountKey(current.engineAccountKey)) throw new Error('Current Engine account is unverified');
        if (!selection || selection.cardId !== card.id || selection.profileId !== current.profileId ||
            selection.accountId !== current.accountId || !browserToolSameUrl(selection.selectedUrl, current.url) ||
            selection.cardEpoch !== current.cardEpoch || selection.userContextId !== current.userContextId ||
            selection.engineAccountKey !== current.engineAccountKey || selection.authorityEpoch !== current.authorityEpoch ||
            !['observe', 'interact'].includes(selection.permission) || !selectedByUser ||
            selectedByUser.usedRunId || selectedByUser.threadId !== request.clientThreadId ||
            selection.clientThreadId !== request.clientThreadId ||
            ['cardId', 'cardEpoch', 'profileId', 'accountId', 'selectedUrl', 'userContextId',
              'engineAccountKey', 'authorityEpoch', 'permission', 'sourceId'].some(field =>
              selectedByUser[field] !== selection[field])) {
          throw new Error('Selected Browser Card, profile, account or URL changed');
        }
        const pending = { clientThreadId: request.clientThreadId, selectionToken: selection.selectionToken };
        browserToolPendingBindings.set(key, pending);
        try {
          const live = await card._browserControls.toolObserve(current, { textLimit: 1, elementLimit: 1 });
          if (!browserToolSameUrl(live.url, selection.selectedUrl) || browserToolCancelledRuns.has(key) ||
              browserToolStoppedRuns.has(JSON.stringify([request.runId, request.clientThreadId])) ||
              browserToolPendingBindings.get(key) !== pending ||
              browserToolUserSelections.get(selection.selectionToken) !== selectedByUser || selectedByUser.usedRunId ||
              request.deadlineMs <= Date.now()) throw new Error('Selected Browser document changed before binding');
          selectedByUser.usedRunId = request.runId;
          browserToolRunBindings.set(key, { binding: current, permission: selection.permission,
            clientThreadId: request.clientThreadId, selectionToken: selection.selectionToken });
          return { requestId, status: 'bound', binding: current };
        } finally {
          if (browserToolPendingBindings.get(key) === pending) browserToolPendingBindings.delete(key);
        }
      }
      const authorized = browserToolRunBindings.get(key);
      if (!authorized || authorized.clientThreadId !== request.clientThreadId || !request.binding ||
          ['cardId', 'cardEpoch', 'profileId', 'accountId', 'userContextId', 'engineAccountKey', 'authorityEpoch'].some(field =>
            authorized.binding[field] !== request.binding[field])) throw new Error('Browser run binding is missing or changed');
      const current = card._browserControls.toolBinding();
      if (['cardId', 'cardEpoch', 'profileId', 'accountId', 'userContextId', 'engineAccountKey', 'authorityEpoch'].some(field =>
        authorized.binding[field] !== current[field])) {
        browserToolRunBindings.delete(key);
        throw new Error('Browser profile or account epoch changed');
      }
      if (request.kind === 'observe') {
        if (browserToolCardLeases.has(request.targetCardEpoch)) throw new Error('Browser Card is being operated; observe after it settles');
        activity = browserToolActivityStart(card, request);
        const snapshot = await card._browserControls.toolObserve(authorized.binding, request.options || {});
        if (browserToolRunBindings.get(key) !== authorized) throw new Error('Browser run was cancelled during observation');
        const observed = { requestId, status: 'observed', snapshot };
        browserToolActivityEnd(activity, observed, false);
        return observed;
      }
      if (request.kind !== 'act' || authorized.permission !== 'interact') throw new Error('Browser interaction was not selected');
      if (!['navigate', 'click', 'fill', 'scroll', 'press'].includes(request.action?.type) || !request.guard ||
          request.action.selector || (!['navigate', 'scroll'].includes(request.action.type) && !request.action.ref)) {
        throw new Error('Unsupported or unguarded Browser action');
      }
      if (request.action.type === 'navigate' && !browserToolSafeNavigationUrl(request.action.url)) {
        throw new Error('Browser navigation requires an absolute http(s) URL without credentials');
      }
      if (browserToolCardLeases.has(request.targetCardEpoch)) throw new Error('Browser Card is already being operated');
      browserToolCardLeases.set(request.targetCardEpoch, requestId);
      const browser = card._browserControls.toolBrowser?.();
      const browsingContext = browser?.browsingContext;
      const windowGlobal = browsingContext?.currentWindowGlobal;
      if (!browser || !browsingContext || !windowGlobal) {
        browserToolCardLeases.delete(request.targetCardEpoch);
        throw new Error('Browser actor binding is unavailable');
      }
      const leaseId = chatBindingNonce();
      browserToolFixtureAuthorizationByCard.delete(request.cardId);
      const actionLease = { key, bound: authorized, card, browser,
        browsingContext, windowGlobal, leaseId, requestId, runId: request.runId,
        cardEpoch: request.targetCardEpoch, deadlineMs: request.deadlineMs,
        actionType: request.action.type, actionRef: request.action.ref || null,
        actionUrl: request.action.url || null, authorized: false,
        displayPoint: browserToolDisplayPoint(request.action, request.guard) };
      browserToolActionLeases.set(leaseId, actionLease);
      activityLease = actionLease;
      activity = browserToolActivityStart(card, request);
      let receipt;
      try {
        try { actionLease.projection = card._browserControls.toolPrepareAgentProjection?.(actionLease); } catch {}
        diagnosticPhase = 'actor';
        receipt = await card._browserControls.toolAct(authorized.binding, request.action, request.guard,
          { leaseId, requestId, deadlineMs: request.deadlineMs });
      }
      finally {
        try { actionLease.projection?.clear(); } catch {}
        browserToolActionLeases.delete(leaseId);
        if (browserToolCardLeases.get(request.targetCardEpoch) === requestId) {
          browserToolCardLeases.delete(request.targetCardEpoch);
        }
      }
      diagnosticPhase = 'post-actor';
      if (browserToolRunBindings.get(key) !== authorized) throw new Error('Browser run was cancelled after dispatch; outcome is unknown');
      const fixture = browserToolFixtureIdentity(request.cardId);
      if (fixture) browserToolFixtureLastAction = {
        requestId, cardId: request.cardId, cardEpoch: fixture.cardEpoch, authorityEpoch: fixture.authorityEpoch,
        actionType: request.action.type, phase: 'post-actor', status: 'acted', reason: 'none',
        inputRoute: receipt?.dispatchReceipt?.clickInputRoute || null,
        targetClickObserved: receipt?.dispatchReceipt?.targetClickObserved ?? null,
        parentReason: null, geckoError: null,
        sampledAtMs: Date.now(),
      };
      const acted = { requestId, status: 'acted', receipt };
      browserToolActivityEnd(activity, acted, true);
      return acted;
    } catch (error) { return fail(error); }
  }
  function browserToolDispatch(request) {
    const id = request?.requestId;
    if (typeof id !== 'string' || !id || id.length > 160) return browserToolDispatchOnce(request);
    const held = browserToolUserHoldRefusal(request);
    if (held) return Promise.resolve(held);
    const key = `${request.runId}\u0000${request.cardId}\u0000${request.targetCardEpoch}`;
    if (request.kind !== 'cancel' && browserToolStoppedRuns.has(JSON.stringify([request.runId, request.clientThreadId]))) {
      return Promise.resolve({ requestId: id, status: 'rejected', error: 'Browser run was stopped' });
    }
    if (request.kind !== 'cancel' && browserToolCancelledRuns.has(key)) return Promise.resolve({
      requestId: id, status: 'rejected', error: 'Browser run was cancelled',
    });
    let fingerprint;
    try { fingerprint = JSON.stringify(request); } catch { return browserToolDispatchOnce(null); }
    if (fingerprint.length > 24000) return Promise.resolve({ requestId: id, status: 'rejected', error: 'Browser request exceeds size limit' });
    const previous = browserToolRequestReceipts.get(id);
    if (previous) return previous.fingerprint === fingerprint ? previous.result :
      Promise.resolve({ requestId: id, status: 'rejected', error: 'Browser request ID reused with different payload' });
    if (browserToolRequestReceipts.size >= 512) {
      for (const [oldId, item] of browserToolRequestReceipts) {
        if (item.deadline < Date.now()) browserToolRequestReceipts.delete(oldId);
      }
      if (browserToolRequestReceipts.size >= 512) return Promise.resolve({
        requestId: id, status: 'rejected', error: 'Browser request queue is full',
      });
    }
    const result = browserToolDispatchOnce(request);
    browserToolRequestReceipts.set(id, { fingerprint, result, deadline: request.deadlineMs });
    return result;
  }
  function attachBrowserToolTransport({ source, respond }) {
    if (typeof source?.addEventListener !== 'function' || typeof source?.removeEventListener !== 'function' ||
        typeof respond !== 'function') throw new TypeError('Browser tool transport requires event source and response sender');
    const onRequest = async (event) => {
      let request;
      try { request = JSON.parse(event.data); } catch { return; }
      const key = `${request?.runId}\u0000${request?.cardId}\u0000${request?.targetCardEpoch}`;
      const card = document.getElementById(request?.cardId);
      if (card?._browserControls?.toolBinding) {
        try {
          if (card._browserControls.toolBinding().cardEpoch !== request.targetCardEpoch) return;
        } catch { if (!browserToolRunBindings.has(key)) return; }
      } else if (!browserToolRunBindings.has(key) && !browserToolCancelledRuns.has(key)) return;
      const response = await browserToolDispatch(request);
      try { await respond(response); } catch (error) { console.warn(TAG, 'Browser tool response transport failed', error); }
    };
    source.addEventListener('browser-tool-request', onRequest);
    return () => source.removeEventListener('browser-tool-request', onRequest);
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
    // The first Browser fills the window at the world origin; any other opens in an empty spot.
    const placement = options.firstUse
      ? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, inView: true }
      : resolveCanvasCardPlacement('browser');
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
        top: placement.y + 'px',
        left: placement.x + 'px',
        width: placement.width + 'px',
        height: placement.height + 'px',
        zIndex: String(++cardZ),
      },
    });
    const card = deskWindow.root;
    revealPlacedCanvasCard(card, placement, { kind: 'browser', opener: options.opener });

    const urlInput = el('input', {
      type: 'text',
      class: 'egd-card-url',
      'aria-label': '주소 또는 검색어',
      data: { testid: options.firstUse ? 'first-use-address' : 'browser-address' },
      value: browserVisibleAddress(normalizedUrl),
      placeholder: '주소 또는 검색어 입력',
    });
    if (options.fixedLogicalHeight) card._fixedLogicalHeight = options.fixedLogicalHeight;
    let xulBrowser = null;
    let unregisterBrowserAuthorizer = null;
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
    // A passing note; the persistent Agent badge below is the Card's only status region.
    const agentActivity = el('span', { class: 'egd-browser-agent-activity',
      style: { fontSize: '11px', opacity: '0.8', whiteSpace: 'nowrap', maxWidth: '140px',
        overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: '1' } }, '');
    agentActivity.hidden = true;
    // BRW-13: who acts on this Card. The badge stays while an Agent lease is
    // live and in use, then counts what happened for a while, and opens the
    // timeline. [일시중지] / [돌려주기] sit beside it, outside the status region.
    const agentBadge = el('button', {
      type: 'button', class: 'egd-browser-agent-badge', hidden: true, title: 'Agent 활동 기록 보기',
      'aria-haspopup': 'dialog', 'aria-expanded': 'false', data: { testid: 'browser-agent-badge', mode: 'hidden' },
      onclick: (ev) => { ev.stopPropagation(); toggleAgentTimeline(); },
    });
    const agentBadgeStatus = el('span', { class: 'egd-browser-agent-status', role: 'status' }, agentBadge);
    const agentHandButton = el('button', {
      type: 'button', class: 'egd-browser-agent-hand', hidden: true, data: { testid: 'browser-agent-pause', action: '' },
      onclick: (ev) => {
        ev.stopPropagation();
        if (agentHandButton.dataset.action === 'handback') handBackAgentControl();
        else if (agentHandButton.dataset.action === 'pause') pauseAgentControl();
      },
    });
    let agentActivityTimer = 0;
    const showAgentActivity = (message) => {
      if (agentActivityTimer) window.clearTimeout(agentActivityTimer);
      agentActivity.textContent = message;
      agentActivity.hidden = !message;
      if (message) agentActivityTimer = window.setTimeout(() => { agentActivity.hidden = true; agentActivityTimer = 0; }, 4000);
    };
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
    }, deskIcon('back'));
    const forwardButton = el('button', {
      class: 'egd-card-nav-btn',
      title: '앞으로',
      disabled: true,
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, 'forward');
      },
    }, deskIcon('forward'));
    const reloadButton = el('button', {
      class: 'egd-card-nav-btn egd-card-reload',
      title: '새로고침',
      'aria-label': '새로고침',
      'aria-busy': 'false',
      data: { icon: 'reload' },
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, browserState.loading ? 'stop' : 'reload');
      },
    }, deskIcon('reload'));
    const homeButton = el('button', {
      class: 'egd-card-nav-btn',
      title: '홈',
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, 'home');
      },
    }, deskIcon('home'));
    const duplicateButton = el('button', {
      class: 'egd-card-nav-btn egd-card-duplicate',
      title: '복제',
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, 'duplicate');
      },
    }, deskIcon('duplicate'));
    const menuButton = el('button', {
      class: 'egd-card-menu',
      title: '더보기',
      'aria-label': '더보기',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      onclick: (ev) => {
        ev.stopPropagation();
        browserCardControl(card, 'menu', menuButton, { focusFirst: ev.detail === 0 });
      },
    }, deskIcon('menu'));

    const header = deskWindow.slots.header;
    deskWindow.slots.identity.classList.add('egd-card-page-meta');
    deskWindow.slots.identity.append(pageTitle, pageStatus, agentActivity, agentBadgeStatus, agentHandButton);
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
    if (options.firstUse) card.dataset.testid = 'browser-card';

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

    const agentTargetMarker = el('span', { class: 'egd-browser-agent-target', 'aria-hidden': 'true', hidden: true });
    wrap.appendChild(agentTargetMarker);
    const agentProjection = createBrowserAgentProjection({ card, marker: agentTargetMarker,
      current: browserToolProjectionCurrent });

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
      if (browserState.uri === EGDESK_START_URI) return 'EG-Desk';
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
    const agentComposedParent = (node) => node?.parentElement || node?.getRootNode?.()?.host || null;
    const isAgentVisibleElement = (node) => {
      if (!node?.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = node; current; current = agentComposedParent(current)) {
        if (current.hidden || current.inert || current.getAttribute?.('aria-hidden') === 'true') return false;
        try {
          const style = current.ownerDocument?.defaultView?.getComputedStyle?.(current);
          if (!style) return false;
          if (style?.display === 'none' || ['hidden', 'collapse'].includes(style?.visibility) || Number(style?.opacity) === 0) return false;
        } catch { return false; }
      }
      return true;
    };
    const isAgentSensitiveControl = (node) => {
      if (node?.isContentEditable) return true;
      const tag = String(node?.tagName || '').toLowerCase();
      if (!['input', 'textarea', 'select'].includes(tag)) return false;
      const type = String(node.type || node.getAttribute?.('type') || '').toLowerCase();
      const sensitiveFlag = node.getAttribute?.('data-sensitive');
      const privateFlag = node.getAttribute?.('data-private');
      if (['password', 'hidden'].includes(type) ||
          (sensitiveFlag != null && sensitiveFlag !== 'false') ||
          (privateFlag != null && privateFlag !== 'false')) return true;
      const hints = ['autocomplete', 'name', 'id', 'aria-label', 'placeholder'].map(key =>
        String(node.getAttribute?.(key) || (key === 'id' ? node.id : '') || '')
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()).join(' ');
      if (/password|passwd|passphrase|secret|token|otp|cvv|cvc/.test(hints)) return true;
      return /(?:^|[\s_-])(?:password|passwd|pwd|passphrase|secret|token|otp|pin|ssn|pan|social[\s_-]?security(?:[\s_-]?number)?|primary[\s_-]?account[\s_-]?number|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key|client[\s_-]?secret|one[\s_-]?time|verification[\s_-]?code|auth[\s_-]?code|security[\s_-]?answer|cc[\s_-]?(?:number|csc|exp)|credit[\s_-]?card(?:[\s_-]?number)?|card[\s_-]?number|cvv|cvc)(?:$|[\s_-])/.test(hints);
    };
    const isAgentSensitiveText = (node) => {
      for (let parent = agentComposedParent(node); parent; parent = agentComposedParent(parent)) {
        if (parent.isContentEditable || isAgentSensitiveControl(parent)) return true;
      }
      return false;
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
      if (isAgentSensitiveControl(node)) return 'Sensitive field';
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
        || '';
      return compactAgentText(label, 120);
    };
    const agentElementValue = (node) => {
      if (isAgentSensitiveControl(node)) return '';
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
          if (!parent || !isAgentVisibleElement(parent) || isAgentSensitiveText(node)) return nodeFilter.FILTER_REJECT;
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
      if (['captureInput', 'presentationMetrics'].includes(method) && (!card.isConnected || xulBrowser.browsingContext !== context
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
        const composedParent = (node) => node?.parentElement || node?.getRootNode?.()?.host || null;
        const isVisible = (node) => {
          if (!node || !node.getBoundingClientRect) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          for (let current = node; current; current = composedParent(current)) {
            if (current.hidden || current.inert || current.getAttribute?.('aria-hidden') === 'true') return false;
            const style = content.getComputedStyle(current);
            if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
          }
          return true;
        };
        const isSensitive = (node) => {
          if (node?.isContentEditable) return true;
          const tag = String(node?.tagName || '').toLowerCase();
          if (!['input', 'textarea', 'select'].includes(tag)) return false;
          const type = String(node.type || node.getAttribute?.('type') || '').toLowerCase();
          const sensitiveFlag = node.getAttribute?.('data-sensitive');
          const privateFlag = node.getAttribute?.('data-private');
          if (['password', 'hidden'].includes(type) ||
              (sensitiveFlag != null && sensitiveFlag !== 'false') ||
              (privateFlag != null && privateFlag !== 'false')) return true;
          const hints = ['autocomplete', 'name', 'id', 'aria-label', 'placeholder'].map(key =>
            String(node.getAttribute?.(key) || (key === 'id' ? node.id : '') || '')
              .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()).join(' ');
          if (/password|passwd|passphrase|secret|token|otp|cvv|cvc/.test(hints)) return true;
          return /(?:^|[\\s_-])(?:password|passwd|pwd|passphrase|secret|token|otp|pin|ssn|pan|social[\\s_-]?security(?:[\\s_-]?number)?|primary[\\s_-]?account[\\s_-]?number|api[\\s_-]?key|access[\\s_-]?key|private[\\s_-]?key|client[\\s_-]?secret|one[\\s_-]?time|verification[\\s_-]?code|auth[\\s_-]?code|security[\\s_-]?answer|cc[\\s_-]?(?:number|csc|exp)|credit[\\s_-]?card(?:[\\s_-]?number)?|card[\\s_-]?number|cvv|cvc)(?:$|[\\s_-])/.test(hints);
        };
        const isSensitiveText = (node) => {
          for (let parent = composedParent(node); parent; parent = composedParent(parent)) {
            if (parent.isContentEditable || isSensitive(parent)) return true;
          }
          return false;
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
          if (isSensitive(node)) return 'Sensitive field';
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
              || '',
            120,
          );
        };
        const valueFor = (node) => {
          if (isSensitive(node)) return '';
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
              if (!parent || !isVisible(parent) || isSensitiveText(node)) return filter.FILTER_REJECT;
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
      const isStartPage = browserState.uri === EGDESK_START_URI;
      card.classList.toggle('egd-browser-loading', !!browserState.loading);
      card.dataset.browserLoading = browserState.loading ? 'true' : 'false';
      pageTitle.textContent = browserState.title || browserDisplayHost(browserState.uri);
      pageTitle.title = browserState.title || browserState.uri;
      pageStatus.hidden = isStartPage;
      pageStatus.textContent = isStartPage ? '' : browserState.loading ? 'Loading' : browserState.security;
      pageStatus.title = isStartPage ? '' : browserState.uri;
      securityIcon.hidden = isStartPage;
      securityIcon.replaceChildren(browserSecurityGlyph(browserState.uri));
      securityIcon.title = isStartPage ? '' : browserState.security;
      if (document.activeElement !== urlInput) urlInput.value = browserVisibleAddress(browserState.uri);
      backButton.disabled = !browserState.canGoBack;
      forwardButton.disabled = !browserState.canGoForward;
      const reloadAction = browserState.loading ? 'stop' : 'reload';
      if (reloadButton.dataset.icon !== reloadAction) {
        reloadButton.replaceChildren(deskIcon(reloadAction));
        reloadButton.dataset.icon = reloadAction;
      }
      reloadButton.title = browserState.loading ? '중지' : '새로고침';
      reloadButton.setAttribute('aria-label', reloadButton.title);
      reloadButton.setAttribute('aria-busy', String(!!browserState.loading));
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
    // BRW-04: the location the page actually arrived at (never the requested
    // src), reported for workflow gates. The bridge hears origin + path only;
    // the Codex sign-in card is EG-Desk's own and is not reported.
    const readArrivedBrowserUri = () => {
      try { return xulBrowser?.currentURI?.spec || ''; } catch { return ''; }
    };
    const reportBrowserLocation = (uri) => {
      if (card.dataset.codexRole === 'auth' || !card.isConnected) return;
      try { state.codexBridge?.reportBrowserLocation?.(card.id, uri); } catch {}
    };
    const syncBrowserStateFromBrowser = (options = {}) => {
      reportBrowserLocation(readArrivedBrowserUri());
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
      agentProjection.invalidate();
      const url = normalizeBrowserUri(rawUrl || browserState.uri || browserState.homeUrl);
      browserState.uri = url;
      browserState.security = browserSecurityLabel(url);
      browserState.title = browserDisplayHost(url);
      urlInput.value = browserVisibleAddress(url);
      pushBrowserHistory(url, { replace: navOptions.replaceHistory });
      bindCardSourceRef(card, browserSourceRef(url, navOptions.sourceRef || {}));
      setBrowserLoading(true);
      const loaded = loadBrowserUri(url);
      if (navOptions.markDirty !== false) markAgendaDirty('navigate-browser-card', card);
      syncBrowserChrome();
      return loaded ? getBrowserStateSnapshot() : null;
    };
    const goBrowserBack = () => {
      agentProjection.invalidate();
      if (browserState.historyIndex > 0) {
        browserState.historyIndex -= 1;
        const url = browserState.history[browserState.historyIndex];
        browserState.uri = url;
        browserState.security = browserSecurityLabel(url);
        browserState.title = browserDisplayHost(url);
        urlInput.value = browserVisibleAddress(url);
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
      agentProjection.invalidate();
      if (browserState.historyIndex < browserState.history.length - 1) {
        browserState.historyIndex += 1;
        const url = browserState.history[browserState.historyIndex];
        browserState.uri = url;
        browserState.security = browserSecurityLabel(url);
        browserState.title = browserDisplayHost(url);
        urlInput.value = browserVisibleAddress(url);
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
        agentProjection.invalidate();
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
    const focusBrowserMenuReturn = (anchor, actionResult = null) => {
      const target = [
        actionResult?.querySelector?.('.egd-card-url'),
        anchor,
        card.isConnected ? card.querySelector('.egd-card-url') : null,
        document.querySelector('#egd-dock .egd-dock-btn[data-id="browser"]'),
      ].find(node => node?.isConnected && !node.disabled);
      target?.focus?.();
    };
    const closeBrowserMenu = ({ restoreFocus = false } = {}) => {
      const panel = browserMenuPanel;
      if (!panel) return;
      if (panel._outsideHandler) window.removeEventListener('mousedown', panel._outsideHandler, true);
      if (panel._keydownHandler) panel._anchor?.removeEventListener('keydown', panel._keydownHandler);
      if (panel._focusoutHandler) {
        panel._anchor?.removeEventListener('focusout', panel._focusoutHandler);
        panel.removeEventListener('focusout', panel._focusoutHandler);
      }
      panel._anchor?.setAttribute('aria-expanded', 'false');
      panel.remove();
      browserMenuPanel = null;
      if (restoreFocus) focusBrowserMenuReturn(panel._anchor);
    };
    const selectBrowserForChat = (permission) => {
      const threadId = state.codex.activeThreadId;
      const source = chatInputSourceForView(card);
      if (!threadId || !source || source.kind !== 'browser') return;
      const selectedSource = registerBrowserToolSelection(threadId, source, permission);
      if (!selectedSource && permission === 'interact') {
        boardNotice('Browser 조작 대상을 확인하지 못했습니다. 현재 페이지에서 다시 선택해 주세요.'); return;
      }
      const existing = getCodexThreadById(state.codex, threadId)?.inputSources?.find(item =>
        item.kind === 'browser' && item.sourceRef?.viewId === card.id);
      if (existing) state.codexBridge.removeInputSource(threadId, existing.id);
      state.codexBridge.addInputSources(threadId,
        [selectedSource || { ...source, selectedByUser: true, browserToolPermission: 'observe' }]);
      showAgentActivity(permission === 'interact'
        ? '이번 Chat 조작 대상으로 선택됨' : '이번 Chat 읽기 자료로 선택됨');
    };
    // `regrant`: opened by [돌려주기], it names and focuses '다시 조작 허용' and grants nothing itself.
    const showBrowserMenu = (anchor = menuButton, { focusFirst = false, regrant = false } = {}) => {
      if (browserMenuPanel?.isConnected) {
        closeBrowserMenu();
        return null;
      }
      const anchorRect = anchor.getBoundingClientRect();
      const pos = resolveFloatingMenuPlacement(anchorRect, 166, 224);
      const item = (label, title, action) => el('button', {
        class: 'egd-browser-menu-item',
        role: 'menuitem',
        title,
        onmousedown: (ev) => {
          if (ev.button !== 0) return;
          // macOS can blur to BODY on button mousedown, closing the menu before
          // mouseup/click. Keep this item focused; only click runs its action.
          ev.preventDefault();
          ev.currentTarget.focus();
        },
        onclick: (ev) => {
          ev.stopPropagation();
          closeBrowserMenu();
          const result = action();
          const focused = document.activeElement;
          if (!focused?.isConnected || focused === document.body || focused === document.documentElement) {
            focusBrowserMenuReturn(anchor, result);
          }
        },
      }, label);
      // An explicit pick here is 대표님 handing the Card back, so it also ends a hold.
      const interactItem = item(regrant ? '다시 조작 허용' : 'Chat 조작 허용', `이 Browser만 이번 Chat 실행의 관찰·조작 대상으로 선택합니다. 사이트 계정: ${card._sourceRef?.accountId || '미확인'}(선택 메타데이터, 로그인 증거 아님). 외부 효과는 별도 확인이 필요합니다.`,
        () => { endAgentHold(); return selectBrowserForChat('interact'); });
      const items = [
        item('복제', '현재 URL을 새 Desk Window로 열기', duplicateBrowser),
        item('URL 복사', browserState.uri, () => copyTextToClipboard(browserState.uri)),
        item('Chat에 읽기 첨부', '현재 Browser의 읽기 자료만 다음 Chat에 선택합니다. 기존 조작 허용이 있으면 읽기 전용으로 바뀝니다.',
          () => { endAgentHold(); return selectBrowserForChat('observe'); }),
        interactItem,
        item('홈', browserState.homeUrl, () => navigateBrowser(browserState.homeUrl)),
        item(browserState.loading ? '중지' : '새로고침', browserState.loading ? '로드 중지' : '현재 페이지 새로고침', () => (browserState.loading ? stopBrowser() : reloadBrowser())),
        item(isCardFullscreen(card) ? '창 복귀' : '최대화', 'Desk Window 최대화 전환', () => toggleCardFullscreen(card)),
      ];
      browserMenuPanel = el('div', {
        class: 'egd-browser-menu egd-edge egd-frosted',
        role: 'menu',
        'aria-label': 'Browser 도구',
        style: {
          left: Math.round(pos.left) + 'px',
          top: Math.round(pos.top) + 'px',
        },
      }, ...items);
      const panel = browserMenuPanel;
      panel._anchor = anchor;
      panel._keydownHandler = (ev) => {
        if (browserMenuPanel !== panel) return;
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          closeBrowserMenu({ restoreFocus: true });
          return;
        }
        const current = items.indexOf(document.activeElement);
        let next = -1;
        if (ev.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
        else if (ev.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = items.length - 1;
        if (next < 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        items[next].focus();
      };
      panel._focusoutHandler = (ev) => {
        if (browserMenuPanel !== panel) return;
        if (panel.contains(ev.relatedTarget) || anchor.contains(ev.relatedTarget)) return;
        // Focusout can precede the next focus target, including an item in this
        // detached menu. Recheck after the handoff, and never close a newer menu.
        window.setTimeout(() => {
          if (browserMenuPanel !== panel) return;
          const focused = document.activeElement;
          if (panel.contains(focused) || anchor.contains(focused)) return;
          closeBrowserMenu();
        }, 0);
      };
      panel.addEventListener('keydown', panel._keydownHandler);
      anchor.addEventListener('keydown', panel._keydownHandler);
      panel.addEventListener('focusout', panel._focusoutHandler);
      anchor.addEventListener('focusout', panel._focusoutHandler);
      panel._outsideHandler = (event) => {
        if (browserMenuPanel?.contains(event.target) || anchor.contains(event.target)) return;
        closeBrowserMenu();
      };
      document.documentElement.appendChild(panel);
      anchor.setAttribute('aria-expanded', 'true');
      if (regrant) interactItem.focus();
      else if (focusFirst || document.activeElement !== anchor) items[0]?.focus();
      window.setTimeout(() => {
        if (browserMenuPanel === panel && panel._outsideHandler) {
          window.addEventListener('mousedown', panel._outsideHandler, true);
        }
      }, 0);
      return panel;
    };
    card._browserState = browserState;
    // ---- BRW-13: Agent activity on this Card (display; authority stays in the transport) ----
    const agentControl = { hold: null, inFlight: 0, count: 0, lastActiveAt: 0, timer: 0, popover: null, prior: null };
    const agentBadgeView = (now) => SurfaceState.browserAgentBadge({ hold: !!agentControl.hold,
      permission: browserToolCardPermission(card.id), inFlight: agentControl.inFlight,
      count: agentControl.count, lastActiveAt: agentControl.lastActiveAt, now });
    const refreshAgentControl = () => {
      if (agentControl.timer) { window.clearTimeout(agentControl.timer); agentControl.timer = 0; }
      const now = Date.now();
      let view = agentBadgeView(now);
      // An open timeline keeps its badge until 대표님 closes it.
      if (view.mode === 'hidden' && agentControl.popover && agentControl.count > 0) {
        agentControl.lastActiveAt = now;
        view = agentBadgeView(now);
      }
      if (view.mode === 'operating') agentControl.lastActiveAt = now;
      if (view.mode === 'hidden') agentControl.count = 0;
      if (view.mode === 'hidden') delete card.dataset.egdAgentControl;
      else card.dataset.egdAgentControl = view.mode;
      const focused = document.activeElement;
      agentBadge.hidden = view.mode === 'hidden';
      agentBadge.dataset.mode = view.mode;
      // The status region speaks when the label changes, never on a re-render.
      if (agentBadge.textContent !== view.label) agentBadge.textContent = view.label;
      agentHandButton.hidden = !view.control;
      agentHandButton.dataset.action = view.control || '';
      if (view.control) {
        const handback = view.control === 'handback';
        agentHandButton.dataset.testid = handback ? 'browser-agent-handback' : 'browser-agent-pause';
        const text = handback ? '돌려주기' : '일시중지';
        if (agentHandButton.textContent !== text) agentHandButton.textContent = text;
        agentHandButton.title = handback
          ? '직접 조작을 끝냅니다. 조작 권한은 자동으로 돌아가지 않고, 이어서 여는 메뉴에서 다시 허용할 수 있습니다.'
          : 'Agent의 이 Browser 조작 권한을 거두고 직접 조작합니다';
      }
      if (agentBadge.hidden) closeAgentTimeline({ restoreFocus: !!agentControl.popover?.contains(focused) });
      // Pausing keeps focus on the same button, now [돌려주기]; a control that goes away hands focus on.
      if ((focused === agentHandButton && agentHandButton.hidden) || (focused === agentBadge && agentBadge.hidden)) {
        (agentBadge.hidden ? menuButton : agentBadge).focus();
      }
      if (view.recheckMs > 0 && card.isConnected) {
        agentControl.timer = window.setTimeout(() => { agentControl.timer = 0; refreshAgentControl(); }, view.recheckMs);
      }
      return view;
    };
    const renderAgentTimeline = () => {
      const panel = agentControl.popover;
      if (!panel?.isConnected) return;
      const rows = SurfaceState.browserAgentTimelineRows(browserAgentHistory({ limit: SurfaceState.BROWSER_AGENT_TIMELINE_LIMIT }));
      panel._count.textContent = rows.length ? `최근 ${rows.length}건` : '';
      panel._list.replaceChildren(...(rows.length ? rows.map(row => el('li', {
        class: 'egd-browser-agent-row', data: { testid: 'browser-agent-timeline-row', outcome: row.outcome },
      }, el('time', { class: 'egd-browser-agent-row-time', datetime: row.iso || null }, row.time),
      el('span', { class: 'egd-browser-agent-row-action' }, row.action),
      el('span', { class: 'egd-browser-agent-row-target', title: row.target || null }, row.target || ''),
      el('span', { class: 'egd-browser-agent-row-outcome', data: { outcome: row.outcome } }, row.outcomeLabel)))
        : [el('li', { class: 'egd-browser-agent-row-empty' }, '아직 기록된 Agent 활동이 없습니다')]));
    };
    const closeAgentTimeline = ({ restoreFocus = false } = {}) => {
      const panel = agentControl.popover;
      if (!panel) return;
      agentControl.popover = null;
      window.removeEventListener('mousedown', panel._outside, true);
      panel.remove();
      agentBadge.setAttribute('aria-expanded', 'false');
      agentBadge.removeAttribute('aria-controls');
      if (restoreFocus && card.isConnected) (agentBadge.hidden ? menuButton : agentBadge).focus();
    };
    const openAgentTimeline = () => {
      closeBrowserMenu();
      const count = el('span', { class: 'egd-browser-agent-timeline-count' });
      const list = el('ol', { class: 'egd-browser-agent-timeline-list', 'aria-label': '최근 Agent 활동, 최신순' });
      const close = el('button', {
        type: 'button', class: 'egd-browser-agent-timeline-close', 'aria-label': '활동 기록 닫기',
        onclick: (ev) => { ev.stopPropagation(); closeAgentTimeline({ restoreFocus: true }); },
      }, deskIcon('close'));
      const panel = el('div', {
        id: `${card.id}-agent-timeline`, class: 'egd-browser-agent-timeline egd-edge egd-frosted',
        role: 'dialog', 'aria-label': 'Agent 활동 기록', data: { testid: 'browser-agent-timeline' },
      }, el('div', { class: 'egd-browser-agent-timeline-head' },
        el('strong', { class: 'egd-browser-agent-timeline-title' }, 'Agent 활동'), count, close),
      list,
      el('p', { class: 'egd-browser-agent-timeline-note' },
        '입력한 글자는 길이만 표시합니다. 확인 필요는 결과를 아직 확인하지 못한 행동입니다.'));
      panel._list = list;
      panel._count = count;
      panel.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        ev.stopPropagation();
        closeAgentTimeline({ restoreFocus: true });
      });
      panel.addEventListener('mousedown', ev => ev.stopPropagation());
      panel._outside = (ev) => {
        if (agentControl.popover === panel && !panel.contains(ev.target) && !agentBadge.contains(ev.target)) closeAgentTimeline();
      };
      const rect = agentBadge.getBoundingClientRect();
      const width = 320, margin = 8, viewportW = window.innerWidth || 1280, viewportH = window.innerHeight || 720;
      const top = Math.min(rect.bottom + 6, viewportH - 160 - margin);
      panel.style.left = `${Math.round(Math.max(margin, Math.min(viewportW - width - margin, rect.left)))}px`;
      panel.style.top = `${Math.round(Math.max(margin, top))}px`;
      panel.style.maxHeight = `${Math.round(Math.max(160, Math.min(360, viewportH - top - margin)))}px`;
      document.documentElement.appendChild(panel);
      agentControl.popover = panel;
      agentBadge.setAttribute('aria-expanded', 'true');
      agentBadge.setAttribute('aria-controls', panel.id);
      renderAgentTimeline();
      close.focus();
      window.setTimeout(() => {
        if (agentControl.popover === panel) window.addEventListener('mousedown', panel._outside, true);
      }, 0);
    };
    const toggleAgentTimeline = () => (agentControl.popover
      ? closeAgentTimeline({ restoreFocus: true }) : openAgentTimeline());
    // Model-tool rows go into browserAgent.history with the same envelope as
    // developer rows, sanitized by SurfaceState: no typed text, value or path.
    const recordAgentToolActivity = (request, outcome, startedAtMs) => {
      const endedAtMs = Date.now();
      const summary = SurfaceState.browserAgentActivityRecord(request);
      recordBrowserAgentAction({
        id: `${card.id}-agent-action-${++agentActionSeq}`, cardId: card.id, sequence: agentActionSeq,
        startedAt: new Date(startedAtMs).toISOString(), endedAt: new Date(endedAtMs).toISOString(),
        durationMs: Math.max(0, endedAtMs - startedAtMs), source: 'model-tool', url: browserState.uri,
        ok: outcome === 'confirmed', outcome, action: summary.action, target: summary.target,
      });
      agentControl.count++;
      agentControl.lastActiveAt = endedAtMs;
      refreshAgentControl();
      renderAgentTimeline();
    };
    const startAgentToolActivity = (request) => {
      const startedAtMs = Date.now();
      let ended = false;
      // The handle exists before any display work, so a display failure cannot strand inFlight.
      const activity = {
        end(response, inputAuthorized) {
          if (ended) return;
          ended = true;
          agentControl.inFlight = Math.max(0, agentControl.inFlight - 1);
          const outcome = SurfaceState.browserAgentActivityOutcome({ request, response, inputAuthorized, prior: agentControl.prior });
          if (response?.status === 'observed') agentControl.prior = SurfaceState.browserAgentPriorReading(response.snapshot);
          recordAgentToolActivity(request, outcome, startedAtMs);
        },
      };
      agentControl.inFlight++;
      try { refreshAgentControl(); } catch {}
      return activity;
    };
    // One quiet Chat line per hold for each room whose run met this Card.
    const noticeAgentHold = (clientThreadId) => {
      const hold = agentControl.hold;
      if (!hold || typeof clientThreadId !== 'string' || !clientThreadId || hold.noticed.has(clientThreadId)) return;
      hold.noticed.add(clientThreadId);
      try { state.codexBridge?.noteBrowserUserControl?.(clientThreadId, browserDisplayHost(browserState.uri)); } catch {}
    };
    // [일시중지]: the Stop revocation scoped to this Card; the Agent's next
    // request is refused while 대표님 operates it. Authorized input is not recalled.
    const pauseAgentControl = () => {
      if (agentControl.hold) return;
      const threads = revokeBrowserToolCard(card.id);
      agentProjection.invalidate();
      agentControl.hold = { since: Date.now(), noticed: new Set() };
      for (const clientThreadId of threads) noticeAgentHold(clientThreadId);
      refreshAgentControl();
    };
    // Ending a hold grants nothing; only the menu's explicit '조작 허용' does.
    const endAgentHold = () => {
      if (!agentControl.hold) return false;
      agentControl.hold = null;
      agentControl.lastActiveAt = Date.now();
      refreshAgentControl();
      return true;
    };
    const handBackAgentControl = () => {
      if (!endAgentHold()) return;
      showBrowserMenu(menuButton, { regrant: true });
    };
    const agentUserHold = (request) => {
      if (!agentControl.hold) return false;
      noticeAgentHold(request?.clientThreadId);
      if (request?.kind === 'observe' || request?.kind === 'act') recordAgentToolActivity(request, 'refused', Date.now());
      return true;
    };
    const disposeAgentControl = () => {
      if (agentControl.timer) window.clearTimeout(agentControl.timer);
      agentControl.timer = 0;
      closeAgentTimeline();
    };
    const browserToolBinding = () => {
      if (!card.isConnected || !xulBrowser?.isConnected || !xulBrowser?.browsingContext?.currentWindowGlobal) {
        throw new Error('Selected Browser Card is unavailable');
      }
      if (!unregisterBrowserAuthorizer) {
        if (!ensureBrowserAgentActor()) throw new Error('Browser actor registration failed');
        const { registerBrowserActionAuthorizer } = ChromeUtils.importESModule(
          'chrome://userchrome/content/EGDeskBrowserAgentRuntimeParent.sys.mjs');
        unregisterBrowserAuthorizer = registerBrowserActionAuthorizer(
          xulBrowser, window, browserToolAuthorizePhysicalAction);
      }
      const profileId = card._sourceRef?.profileId || state.sourceRefs.defaultProfileId;
      const accountId = card._sourceRef?.accountId || '';
      const rawContextId = xulBrowser.getAttribute?.('usercontextid');
      const userContextId = rawContextId == null || rawContextId === '' ? 0 : Number(rawContextId);
      const nativeContextId = xulBrowser.browsingContext.originAttributes?.userContextId;
      if (!Number.isSafeInteger(userContextId) || userContextId < 0 ||
          !Number.isSafeInteger(nativeContextId) || nativeContextId !== userContextId) {
        throw new Error('Browser profile container is unverified');
      }
      return { cardId: card.id, cardEpoch: agentBridgeId, profileId, accountId,
        engineAccountKey: ChatState.codexAccountKey(state.codex.authStatus) || null,
        authorityEpoch: browserToolAuthorityEpoch,
        accountStatus: accountId ? 'selected-metadata-unverified' : 'unverified', userContextId,
        url: browserCardState(card)?.uri || '' };
    };
    const assertBrowserToolBinding = (expected) => {
      const current = browserToolBinding();
      if (!expected || ['cardId', 'cardEpoch', 'profileId', 'accountId', 'userContextId', 'engineAccountKey', 'authorityEpoch']
        .some(key => current[key] !== expected[key])) throw new Error('Browser Card, profile or account context changed');
      return current;
    };
    const browserToolObserve = async (expected, options = {}) => {
      assertBrowserToolBinding(expected);
      const context = xulBrowser.browsingContext;
      const windowGlobal = context.currentWindowGlobal;
      showAgentActivity('Agent가 이 Browser를 관찰 중');
      let snapshot;
      try { snapshot = await browserAgentActorRequest('snapshot', { options }); }
      catch (error) { showAgentActivity('Browser 관찰 불가 · 다시 확인 필요'); throw error; }
      assertBrowserToolBinding(expected);
      if (xulBrowser.browsingContext !== context || context.currentWindowGlobal !== windowGlobal) {
        throw new Error('Browser document changed during observation');
      }
      showAgentActivity('이 Browser 관찰 완료');
      return { cardId: card.id, ...snapshot };
    };
    const browserToolAct = async (expected, action, guard, lease) => {
      assertBrowserToolBinding(expected);
      const context = xulBrowser.browsingContext;
      const windowGlobal = context.currentWindowGlobal;
      showAgentActivity('Agent가 이 Browser에서 조작 중');
      // Guarded model input is JSWindowActor-only: the legacy frame-script and
      // chrome-document fallbacks do not enforce document/target revisions.
      let result;
      try {
        result = await browserAgentActorRequest('act', {
          action, options: { guard, lease, settleMs: 150, snapshot: { textLimit: 60, elementLimit: 80 } },
        });
      } catch (error) { showAgentActivity('조작 결과 미확인 · 다시 관찰 필요'); throw error; }
      assertBrowserToolBinding(expected);
      const documentStillCurrent = xulBrowser.browsingContext === context && context.currentWindowGlobal === windowGlobal;
      showAgentActivity(documentStillCurrent && result?.observation?.visibleTextChanged
        ? '이 Browser의 화면 변화 관찰' : '조작 요청 후 결과 확인 필요');
      return { dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: result?.ok === true,
        documentStillCurrent,
        ...(action.type === 'click' && result?.result?.clickDiagnostics?.dispatchScope
          ? { clickInputRoute: result.result.clickDiagnostics.dispatchScope,
            targetClickObserved: result.result.clickDiagnostics.targetClickObserved === true } : {}),
        ...(['scroll', 'press', 'fill'].includes(action.type)
          ? BrowserAgentReceipts.browserToolDispatchReceiptFields(action.type, result?.result?.dispatchDiagnostics) : {}) },
        after: documentStillCurrent ? { cardId: card.id, ...result.after } : null,
        observation: documentStillCurrent ? result.observation : null };
    };
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
      toolBinding: browserToolBinding,
      toolBrowser: () => xulBrowser,
      toolObserve: browserToolObserve,
      toolAct: browserToolAct,
      toolPrepareAgentProjection: agentProjection.prepare,
      toolActivity: startAgentToolActivity,
      toolUserHold: agentUserHold,
      agentControlState: () => ({ mode: card.dataset.egdAgentControl || 'hidden', held: !!agentControl.hold,
        inFlight: agentControl.inFlight, count: agentControl.count }),
      agentPause: pauseAgentControl,
      agentHandBack: handBackAgentControl,
    };
    const presentation = createBrowserPresentationCache({ card, browser: xulBrowser,
      query: () => browserAgentActorRequest('presentationMetrics'),
      changed: () => state.refreshSemanticProjections?.(),
    });
    card._browserPresentation = presentation;
    const onBrowserLoadStart = () => {
      agentProjection.invalidate();
      presentation.invalidate();
      setBrowserLoading(true);
      state.refreshSemanticProjections?.();
    };
    const onBrowserLoadDone = () => {
      agentProjection.invalidate();
      presentation.invalidate();
      setBrowserLoading(false);
      syncBrowserStateFromBrowser({ markDirtyOnLocationChange: true });
      state.refreshSemanticProjections?.();
    };
    const onBrowserPageZoom = () => {
      agentProjection.invalidate();
      presentation.invalidate();
      state.refreshSemanticProjections?.();
    };
    const onBrowserTitle = () => syncBrowserStateFromBrowser({ markDirtyOnLocationChange: false });
    for (const eventName of ['loadstart']) {
      try { xulBrowser.addEventListener(eventName, onBrowserLoadStart, true); } catch {}
    }
    for (const eventName of ['DOMContentLoaded', 'load', 'pageshow']) {
      try { xulBrowser.addEventListener(eventName, onBrowserLoadDone, true); } catch {}
    }
    try { xulBrowser.addEventListener('DOMTitleChanged', onBrowserTitle, true); } catch {}
    // Top-level location changes between loads (redirect landings, route
    // changes) are reported too. Reporting only; the card state keeps its own
    // sync. The progress list holds listeners weakly, so the card keeps it.
    const browserLocationListener = {
      QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
      onLocationChange(webProgress, _request, location) {
        if (webProgress && webProgress.isTopLevel === false) return;
        reportBrowserLocation(location?.spec || '');
      },
      onStateChange() {}, onProgressChange() {}, onStatusChange() {}, onSecurityChange() {}, onContentBlockingEvent() {},
    };
    card._browserLocationListener = browserLocationListener;
    try { xulBrowser.webProgress?.addProgressListener(browserLocationListener, Ci.nsIWebProgress.NOTIFY_LOCATION); } catch {}
    for (const eventName of ['FullZoomChange', 'TextZoomChange']) {
      xulBrowser.addEventListener(eventName, onBrowserPageZoom, true);
    }
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
        urlInput.value = browserVisibleAddress(browserState.uri);
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
        urlInput.value = browserVisibleAddress(browserState.uri);
        return;
      }
      navigateBrowser(url);
    });
    urlInput.addEventListener('focus', () => {
      window.setTimeout(() => urlInput.select?.(), 0);
    });
    urlInput.addEventListener('blur', () => {
      if (!urlInput.value.trim()) urlInput.value = browserVisibleAddress(browserState.uri);
    });

    // Real resize establishes the page viewport; camera changes only its fit.
    let logicalHeight = 0, lastCardSize = '', lastPresentationZoom = null;
    let nominalHeaderHeight = 0, bodyFrameHeight = 0;
    const updateFitScale = () => {
      if (body.clientWidth < 10 || card.clientHeight < 10) return;
      if (!nominalHeaderHeight) {
        nominalHeaderHeight = header.offsetHeight;
        bodyFrameHeight = card.clientHeight - nominalHeaderHeight - body.clientHeight;
        card.setAttribute('data-egd-browser-presentation', 'true');
      }
      const size = `${card.clientWidth},${card.clientHeight}`;
      if (size !== lastCardSize) {
        agentProjection.invalidate();
        // Only a real Card resize may change the logical page viewport. The
        // screen-sized toolbar's extra space is presentation, not page resize.
        const nominalBodyHeight = card.clientHeight - nominalHeaderHeight - bodyFrameHeight;
        const widthScale = Math.max(1, body.clientWidth - 2) / CARD_LOGICAL_W;
        logicalHeight = card._fixedLogicalHeight || Math.max(1, Math.round(nominalBodyHeight / widthScale));
        if (options.firstUse && !card._fixedLogicalHeight) card._fixedLogicalHeight = logicalHeight;
        wrap.style.height = logicalHeight + 'px';
        lastCardSize = size;
        presentation.invalidate();
      }
      const zoom = canvasZoom();
      const inverse = Math.max(1, 1 / zoom);
      if (lastPresentationZoom !== inverse) {
        header.style.setProperty('--egd-browser-ui-scale', String(inverse));
        lastPresentationZoom = inverse;
      }
      // Fit the same mounted page below the attached readable two-row bar.
      // Uniform fitting preserves its aspect and never writes browser zoom.
      const fit = browserPresentationFit({ width: body.clientWidth, height: body.clientHeight,
        logicalWidth: CARD_LOGICAL_W, logicalHeight });
      const transform = `scale(${fit.scale})`;
      if (wrap.style.transform !== transform) wrap.style.transform = transform;
      const left = fit.left + 'px';
      if (wrap.style.left !== left) wrap.style.left = left;
    };
    presentation.layout = updateFitScale;
    deskWindow.onResize(updateFitScale);

    const cleanupCard = () => {
      try { unregisterBrowserAuthorizer?.(); } catch {}
      agentProjection.dispose();
      disposeAgentControl();
      unregisterBrowserAuthorizer = null;
      presentation.dispose();
      delete card._browserPresentation;
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
      for (const eventName of ['FullZoomChange', 'TextZoomChange']) {
        xulBrowser.removeEventListener(eventName, onBrowserPageZoom, true);
      }
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

  function spawnTerminalCard(options = {}) {
    const requestedShellId = typeof options?.shellId === 'string'
      && /^[a-z][a-z0-9-]{0,31}$/.test(options.shellId) ? options.shellId : null;
    const id = `egd-terminal-card-${++cardSeq}`;
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
    revealPlacedCanvasCard(card, placement);

    // ---- Use iframe for terminal.html to isolate keyboard events ----
    const termBrowser = el('iframe', {
      src: requestedShellId ? TERMINAL_HTML_URL + '?shellId=' + encodeURIComponent(requestedShellId) : TERMINAL_HTML_URL,
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
        focusTerminal();
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
    if (browserEl) browserEl.style.background = 'var(--egd-surface)';

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

  // Presentation-only evidence: never creates Agent observations, refs or grants.
  function browserPresentationFont(metrics, renderedWidth) {
    if (metrics?.version !== 1 || metrics.complete !== true ||
        !Number.isFinite(metrics.fontPx) || metrics.fontPx <= 0 || metrics.fontPx > 4096 ||
        !Number.isFinite(metrics.viewportWidth) || metrics.viewportWidth <= 0 || metrics.viewportWidth > 100000 ||
        !Number.isFinite(metrics.viewportHeight) || metrics.viewportHeight <= 0 || metrics.viewportHeight > 100000 ||
        !Number.isInteger(metrics.sampleCount) || metrics.sampleCount < 1 || metrics.sampleCount > 64 ||
        !Number.isFinite(renderedWidth) || renderedWidth <= 0) return null;
    // The actual rendered width already includes content fit AND Desk zoom.
    const projected = metrics.fontPx * renderedWidth / metrics.viewportWidth;
    return Number.isFinite(projected) && projected > 0 ? projected : null;
  }

  function createBrowserPresentationCache({ card, browser, query, changed,
    now = () => Date.now(), setTimer = (fn, ms) => window.setTimeout(fn, ms),
    clearTimer = id => window.clearTimeout(id) }) {
    const maxAge = 30000;
    let cached = null, generation = 0, retryAt = 0, queued = 0, flight = null, disposed = false;
    let queries = 0;
    const identity = () => ({ context: browser.browsingContext,
      global: browser.browsingContext?.currentWindowGlobal, zoom: browser.fullZoom ?? 1 });
    const current = id => !disposed && card.isConnected && browser.isConnected && id.global &&
      browser.browsingContext === id.context && id.context.currentWindowGlobal === id.global &&
      (browser.fullZoom ?? 1) === id.zoom;
    const read = () => {
      if (cached && !current(cached.identity)) {
        generation += 1;
        cached = null;
        retryAt = 0;
      }
      const age = cached ? now() - cached.at : -1;
      return cached && age >= 0 && age < maxAge ? cached.value : null;
    };
    const ensure = () => {
      if (disposed || read() || queued || flight || now() < retryAt || !card.isConnected) return;
      // Coalesce load/pageshow/resize. Camera animation only reuses local data;
      // an expired cache is retried only when a visible readability candidate asks.
      queued = setTimer(() => {
        queued = 0;
        const id = identity(), ticket = generation;
        if (!current(id)) { retryAt = now() + maxAge; return; }
        const pending = { expired: false, timer: 0, deadline: now() + 1200 };
        flight = pending;
        queries += 1;
        const expire = () => {
          if (pending.expired) return;
          pending.expired = true;
          if (flight !== pending) return;
          // sendQuery cannot be cancelled here. Release only its local slot;
          // this token permanently rejects any eventual old-document reply.
          flight = null;
          cached = null;
          retryAt = ticket === generation && current(id) ? now() + maxAge : 0;
          if (!disposed) changed();
        };
        pending.timer = setTimer(expire, 1200);
        Promise.resolve().then(query).then(value => {
          if (now() >= pending.deadline) { expire(); return; }
          if (pending.expired || ticket !== generation || !current(id)) return;
          cached = browserPresentationFont(value, value?.viewportWidth) === null ? null
            : { value: { version: 1, complete: true, fontPx: value.fontPx,
              viewportWidth: value.viewportWidth, viewportHeight: value.viewportHeight,
              sampleCount: value.sampleCount }, identity: id, at: now() };
        }, () => { /* No Agent fallback and no remote retry loop. */ }).finally(() => {
          clearTimer(pending.timer);
          if (flight === pending) flight = null;
          if (disposed || pending.expired) return;
          retryAt = ticket === generation && current(id) ? now() + maxAge : 0;
          changed();
        });
      }, 80);
    };
    const invalidate = () => {
      generation += 1;
      cached = null;
      retryAt = 0;
      if (queued) clearTimer(queued);
      queued = 0;
    };
    return {
      read, ensure, invalidate,
      font: () => browserPresentationFont(read(), browser.getBoundingClientRect().width),
      diagnostics: () => ({ cached: !!read(), pending: !!flight || !!queued, queries }),
      dispose() {
        disposed = true;
        invalidate();
        if (flight) clearTimer(flight.timer);
      },
    };
  }

  function browserPresentationFit({ width, height, logicalWidth, logicalHeight }) {
    const scale = Math.max(0, Math.min(Math.max(1, width - 2) / logicalWidth, height / logicalHeight));
    return { scale, left: Math.max(0, (width - logicalWidth * scale) / 2) };
  }

  // ============ Canvas Pan / Zoom ============
  function installSemanticZoom(viewport, layer) {
    // A projection stays inside its original View's stacking context. The
    // Browser/PTY/Chat nodes remain mounted in their original wrapper.
    viewport.setAttribute('tabindex', '-1');
    viewport.setAttribute('aria-label', 'Canvas');
    const entries = new Map();
    const clusterButtons = new Map();
    const coarsePointer = window.matchMedia?.('(pointer: coarse)');
    const detailWidth = 240;
    const detailHeight = 180;
    const icons = { browser: 'browser', chat: 'chat', file: 'file', terminal: 'terminal', settings: 'settings', ontology: 'ontology', 'input-evidence': 'file' };
    const typeLabels = { browser: '브라우저', chat: '대화', file: '파일', terminal: '터미널', settings: '설정', ontology: '온톨로지', 'input-evidence': '자료' };
    const titles = {
      browser: '.egd-card-page-title', chat: '.egd-chat-card-title', file: '.egd-file-card-title',
      terminal: '.egd-terminal-title', settings: '.egd-settings-title', ontology: '.egd-ontology-title',
      'input-evidence': '.egd-desk-window-identity strong',
    };
    let scheduled = 0;
    const request = () => {
      if (!scheduled) scheduled = window.requestAnimationFrame(() => { scheduled = 0; render(); });
    };
    const kindFor = card => card.dataset.deskWindowKind
      || (card.classList.contains('egd-chat-card') ? 'chat'
        : card.classList.contains('egd-terminal-card') ? 'terminal'
          : card.classList.contains('egd-settings-card') ? 'settings' : 'view');
    const titleFor = entry => {
      const node = entry.titleNode;
      return (node?.textContent || entry.card.getAttribute('aria-label') || entry.card._sourceRef?.path
        || entry.kind).trim() || entry.kind;
    };
    const screenRect = (card, zoom, pan) => {
      // Card creation, movement, resize, and fullscreen all write inline world
      // geometry. Chat alone may have a temporary visible-height cap; its
      // saved inline height stays untouched for persistence and Board layout.
      const x = parsePxNumber(card.style.left, 0);
      const y = parsePxNumber(card.style.top, 0);
      const width = Math.max(1, parsePxNumber(card.style.width, 1));
      const savedHeight = Math.max(1, parsePxNumber(card.style.height, 1));
      const visibleHeight = card.classList.contains('egd-chat-card') && card.style.maxHeight
        ? Math.min(savedHeight, parsePxNumber(card.style.maxHeight, savedHeight)) : savedHeight;
      const world = { x, y, width, height: savedHeight };
      return {
        world, visualWorld: { ...world, height: visibleHeight },
        x: pan.x + x * zoom, y: pan.y + y * zoom,
        width: width * zoom, height: visibleHeight * zoom,
      };
    };
    const place = (node, screenX, screenY, width, height, originX, originY, zoom) => {
      // The parent world layer supplies camera scale. Cancel that scale only
      // for the projection; its box and controls stay in screen CSS pixels.
      const x = (screenX - originX) / zoom;
      const y = (screenY - originY) / zoom;
      const inverse = 1 / zoom;
      const next = `${x.toFixed(2)},${y.toFixed(2)},${width.toFixed(2)},${height.toFixed(2)},${inverse.toFixed(6)}`;
      if (node._egdSemanticPlacement === next) return;
      node._egdSemanticPlacement = next;
      node.style.left = x + 'px';
      node.style.top = y + 'px';
      node.style.width = width + 'px';
      node.style.height = height + 'px';
      node.style.transform = `scale(${inverse})`;
    };
    const authorVisible = entry => {
      if (!entry.visibilityDirty) return entry.authorVisible;
      entry.visibilityDirty = false;
      const { card } = entry;
      const computed = window.getComputedStyle(card);
      entry.authorVisible = !card.hidden && !card.closest('[hidden]')
        && card.style.display !== 'none' && card.style.visibility !== 'hidden' && card.style.opacity !== '0'
        && computed.display !== 'none' && computed.visibility !== 'hidden' && computed.visibility !== 'collapse'
        && card.getAttribute('aria-hidden') !== 'true' && card.getClientRects().length > 0;
      return entry.authorVisible;
    };
    const focusProjection = (entry, { revealHeader = false } = {}) => {
      if (!entry?.card.isConnected) return;
      entry.visibilityDirty = true;
      if (!authorVisible(entry)) return;
      const world = screenRect(entry.card, state.zoom, state.pan).visualWorld;
      let safe = safeViewportRect();
      const zoomFor = region => {
        const fitted = SurfaceState.fitSurfaceCamera(world, region, 0.85);
        const measured = entry.kind === 'browser' ? entry.card._browserPresentation?.font() : null;
        const measuredWorldFont = Number.isFinite(measured) && measured > 0 ? measured / state.zoom : null;
        // An unusually large View can be cropped, but must become readable
        // without changing its saved dimensions or internal Browser viewport.
        return Math.min(ZOOM_MAX, Math.max(
          measuredWorldFont ? 0 : entry.kind === 'browser' ? 0.83 : 0.76,
          10.6 / (measuredWorldFont || entry.bodyFontPx),
          (detailWidth + 1) / world.width, (detailHeight + 1) / world.height,
          fitted.zoom,
        ));
      };
      let zoom = zoomFor(safe);
      let chatFrameHeight = 0;
      let chatZoomSafe = false;
      if (entry.kind === 'chat') {
        const zoomRect = visibleChatZoomRect();
        const style = window.getComputedStyle(entry.card);
        chatFrameHeight = style.boxSizing === 'border-box' ? 0 :
          parsePxNumber(style.borderTopWidth) + parsePxNumber(style.borderBottomWidth) +
          parsePxNumber(style.paddingTop) + parsePxNumber(style.paddingBottom);
        const left = safe.left + (safe.width - world.width * zoom) / 2;
        const top = safe.top + (safe.height - world.height * zoom) / 2;
        if (zoomRect && left < zoomRect.right && left + world.width * zoom > zoomRect.left &&
            top < zoomRect.bottom && top + (world.height + chatFrameHeight) * zoom > zoomRect.top) {
          const bottom = Math.min(safe.bottom, zoomRect.top - CHAT_ZOOM_GAP);
          if (bottom > safe.top && bottom < safe.bottom) {
            safe = { ...safe, bottom, height: bottom - safe.top };
            zoom = zoomFor(safe);
            chatZoomSafe = true;
          }
        }
      }
      const centeredY = safe.top + (safe.height - world.height * zoom) / 2 - world.y * zoom;
      const topPanY = safe.top - world.y * zoom;
      const pan = {
        x: safe.left + (safe.width - world.width * zoom) / 2 - world.x * zoom,
        y: chatZoomSafe
          ? Math.max(topPanY, Math.min(centeredY,
            safe.bottom - (world.height + chatFrameHeight) * zoom - world.y * zoom))
          : revealHeader ? Math.max(centeredY, topPanY) : centeredY,
      };
      focusCanvasCard(entry.card);
      state.setCanvasViewportTarget?.({ pan, zoom });
    };
    const focusCluster = memberIds => {
      const members = memberIds.map(id => Array.from(entries.values()).find(entry => entry.card.id === id))
        .filter(entry => {
          if (!entry?.card.isConnected) return false;
          entry.visibilityDirty = true;
          return authorVisible(entry);
        });
      if (!members.length) return;
      const rects = members.map(entry => screenRect(entry.card, state.zoom, state.pan).visualWorld);
      const left = Math.min(...rects.map(rect => rect.x));
      const top = Math.min(...rects.map(rect => rect.y));
      const right = Math.max(...rects.map(rect => rect.x + rect.width));
      const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
      const camera = SurfaceState.fitSurfaceCamera({ x: left, y: top, width: right - left, height: bottom - top }, safeViewportRect(), 0.9);
      // If all members truly overlap, fitting may not advance the camera.
      camera.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.max(camera.zoom, state.zoomTarget * 1.5)));
      const safe = safeViewportRect();
      camera.pan = {
        x: safe.left + (safe.width - (right - left) * camera.zoom) / 2 - left * camera.zoom,
        y: safe.top + (safe.height - (bottom - top) * camera.zoom) / 2 - top * camera.zoom,
      };
      state.setCanvasViewportTarget?.(camera);
      viewport.focus({ preventScroll: true });
    };
    const tabStopSelector = 'a[href], area[href], button, input, select, textarea, iframe, browser, [tabindex], [contenteditable="true"]';
    const hideOriginalAccessibility = entry => {
      if (!entry.compact) return;
      for (const child of entry.card.children) {
        if (child === entry.proxy) continue;
        if (!entry.ariaChildren.has(child)) entry.ariaChildren.set(child, child.getAttribute('aria-hidden'));
        if (child.getAttribute('aria-hidden') !== 'true') child.setAttribute('aria-hidden', 'true');
      }
    };
    const suppressTabStops = entry => {
      if (!entry.compact) return;
      for (const node of entry.tabStops.keys()) {
        if (!entry.card.contains(node)) entry.tabStops.delete(node);
      }
      for (const node of entry.card.querySelectorAll(tabStopSelector)) {
        if (entry.proxy.contains(node)) continue;
        if (!entry.tabStops.has(node)) entry.tabStops.set(node, node.getAttribute('tabindex'));
        if (node.getAttribute('tabindex') !== '-1') node.setAttribute('tabindex', '-1');
      }
      entry.tabStopsDirty = false;
    };
    const restoreProjectionAccessibility = (entry, allowFocusRestore = false) => {
      if (!entry.compact) return;
      entry.accessibilityObserver?.disconnect();
      for (const [node, previous] of entry.tabStops) {
        if (node.getAttribute('tabindex') !== '-1') continue;
        if (previous == null) node.removeAttribute('tabindex');
        else node.setAttribute('tabindex', previous);
      }
      entry.tabStops.clear();
      for (const [child, previous] of entry.ariaChildren) {
        if (child.getAttribute('aria-hidden') !== 'true') continue;
        if (previous == null) child.removeAttribute('aria-hidden');
        else child.setAttribute('aria-hidden', previous);
      }
      entry.ariaChildren.clear();
      entry.compact = false;
      const focusWasOnProxy = entry.wasProxyFocused || document.activeElement === entry.proxy;
      if (allowFocusRestore && entry.card.isConnected && focusWasOnProxy) {
        const previous = entry.focusBeforeCompact;
        const target = previous?.isConnected && entry.card.contains(previous) ? previous
          : entry.card.querySelector('.egd-card-url, .egd-card-header button, .egd-chat-card-header button, input, button, [tabindex]');
        try { target?.focus({ preventScroll: true }); } catch {}
        if (document.activeElement === entry.proxy) viewport.focus({ preventScroll: true });
      } else if (focusWasOnProxy) viewport.focus({ preventScroll: true });
      entry.focusBeforeCompact = null;
      entry.wasProxyFocused = false;
    };
    const syncProjectionAccessibility = (entry, compact, focusTarget) => {
      if (!compact) { restoreProjectionAccessibility(entry, entry.level === 'detail'); return; }
      if (entry.compact) {
        if (document.activeElement === entry.proxy && entry.proxy.hidden) focusTarget.focus({ preventScroll: true });
        if (entry.tabStopsDirty) {
          hideOriginalAccessibility(entry);
          suppressTabStops(entry);
        }
        return;
      }
      const active = document.activeElement;
      entry.focusBeforeCompact = active !== entry.proxy && entry.card.contains(active) ? active : null;
      if (entry.focusBeforeCompact) focusTarget.focus({ preventScroll: true });
      entry.compact = true;
      entry.tabStops = new Map();
      entry.ariaChildren = new Map();
      hideOriginalAccessibility(entry);
      suppressTabStops(entry);
      const accessibilityObserver = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes' && record.attributeName === 'tabindex'
            && entry.tabStops.has(record.target) && record.target.getAttribute('tabindex') !== '-1') {
            entry.tabStops.set(record.target, record.target.getAttribute('tabindex'));
          }
          if (record.type === 'attributes' && record.attributeName === 'aria-hidden'
            && record.target.parentNode === entry.card && record.target !== entry.proxy
            && record.target.getAttribute('aria-hidden') !== 'true') {
            entry.ariaChildren.set(record.target, record.target.getAttribute('aria-hidden'));
          }
        }
        if (records.some(record => record.type === 'attributes'
          || Array.from(record.addedNodes).some(node => node.nodeType === Node.ELEMENT_NODE))) {
          entry.tabStopsDirty = true;
          request();
        }
      });
      accessibilityObserver.observe(entry.card, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ['tabindex', 'contenteditable', 'href', 'aria-hidden'],
      });
      entry.accessibilityObserver = accessibilityObserver;
    };
    const add = card => {
      if (!card.id || card.dataset.codexRole === 'auth' || entries.has(card)) return;
      const kind = kindFor(card);
      const label = el('span', { class: 'egd-semantic-label' });
      const source = el('span', { class: 'egd-semantic-source', hidden: true });
      const icon = el('span', { class: 'egd-semantic-icon', 'aria-hidden': 'true' }, deskIcon(icons[kind] || 'square'));
      const center = el('span', { class: 'egd-semantic-center' },
        icon,
        el('span', { class: 'egd-semantic-type' }, typeLabels[kind] || '화면'),
        label,
        source,
      );
      const proxy = el('button', {
        type: 'button', class: 'egd-semantic-proxy', data: { kind, lod: 'outline', viewId: card.id },
        onclick: ev => { ev.stopPropagation(); focusProjection(entries.get(card)); },
      }, center);
      proxy.hidden = true;
      proxy.style.position = 'absolute';
      proxy.style.transformOrigin = 'top left';
      proxy.style.zIndex = '1';
      card.appendChild(proxy);
      const titleNode = card.querySelector(titles[kind] || '.egd-desk-window-identity, .egd-card-title, strong');
      const body = card.querySelector('.egd-card-body, .egd-chat-card-body, .egd-settings-content') || card;
      const bodyFontPx = Math.max(1, parsePxNumber(window.getComputedStyle(body).fontSize, 14));
      const entry = {
        card, proxy, label, source, kind, titleNode, bodyFontPx, level: null, rect: null,
        authorVisible: true, visibilityDirty: true, compact: false,
        visualStyle: [card.style.display, card.style.visibility, card.style.opacity].join('|'),
      };
      const geometryObserver = new MutationObserver(records => {
        const visualStyle = [card.style.display, card.style.visibility, card.style.opacity].join('|');
        if (records.some(record => record.attributeName === 'class' || record.attributeName === 'hidden'
          || record.attributeName === 'aria-hidden') || visualStyle !== entry.visualStyle) {
          entry.visibilityDirty = true;
        }
        entry.visualStyle = visualStyle;
        request();
      });
      geometryObserver.observe(card, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] });
      entry.geometryObserver = geometryObserver;
      if (titleNode) {
        const titleObserver = new MutationObserver(request);
        titleObserver.observe(titleNode, { childList: true, characterData: true, subtree: true });
        entry.titleObserver = titleObserver;
      }
      entries.set(card, entry);
    };
    const remove = card => {
      const entry = entries.get(card);
      if (!entry) return;
      entry.geometryObserver.disconnect();
      entry.titleObserver?.disconnect();
      restoreProjectionAccessibility(entry);
      entry.proxy.remove();
      delete card.dataset.egdSemanticLevel;
      entries.delete(card);
    };
    const syncEntries = () => {
      const current = new Set(Array.from(layer.children).filter(node => node.classList?.contains('egd-canvas-card')));
      for (const card of entries.keys()) if (!current.has(card) || !card.isConnected) remove(card);
      for (const card of current) add(card);
    };
    let cancelPendingChatComposerFocus = () => {};
    const focusChatDockIfCompact = card => {
      cancelPendingChatComposerFocus();
      if (!card?.isConnected || !card.classList?.contains('egd-chat-card') || state.panModifier) return false;
      syncEntries();
      const entry = entries.get(card);
      if (!entry) return false;
      entry.visibilityDirty = true;
      if (!authorVisible(entry)) return false;
      const safe = safeViewportRect();
      const resized = fitCodexChatCardToReadableViewport(card, safe, entry.bodyFontPx);
      const zoom = Number.isFinite(state.zoomTarget) ? state.zoomTarget : state.zoom;
      const rect = screenRect(card, zoom, state.panTarget || state.pan);
      const level = SurfaceState.surfaceSemanticLevel({
        width: rect.width, height: rect.height, fontPx: entry.bodyFontPx * zoom,
        previous: entry.level, detailWidth, detailHeight,
      });
      let chatSafeBottom = safe.bottom;
      let chatOuterBottom = rect.y + rect.height;
      const zoomRect = visibleChatZoomRect();
      if (zoomRect) {
        const style = window.getComputedStyle(card);
        const frameHeight = style.boxSizing === 'border-box' ? 0 :
          parsePxNumber(style.borderTopWidth) + parsePxNumber(style.borderBottomWidth) +
          parsePxNumber(style.paddingTop) + parsePxNumber(style.paddingBottom);
        chatOuterBottom += frameHeight * zoom;
        if (rect.x < zoomRect.right && rect.x + rect.width > zoomRect.left &&
            rect.y < zoomRect.bottom && chatOuterBottom > zoomRect.top - CHAT_ZOOM_GAP) {
          chatSafeBottom = Math.min(safe.bottom, zoomRect.top - CHAT_ZOOM_GAP);
        }
      }
      const fullyInSafe = rect.x >= safe.left - 0.5 && rect.y >= safe.top - 0.5 &&
        rect.x + rect.width <= safe.right + 0.5 &&
        chatOuterBottom <= chatSafeBottom + 0.5;
      if (level === 'detail' && fullyInSafe && !resized) return false;
      focusProjection(entry, { revealHeader: true });
      const target = { zoom: state.zoomTarget, pan: { ...state.panTarget } };
      const initialFocus = document.activeElement;
      let frame = 0, checks = 0, stopped = false;
      const cancel = () => {
        if (stopped) return;
        stopped = true;
        if (frame) window.cancelAnimationFrame(frame);
        document.removeEventListener('mousedown', onOtherInput, true);
      };
      const onOtherInput = event => {
        if (!card.contains(event.target)) cancel();
      };
      const check = () => {
        frame = 0;
        if (stopped) return;
        if (!card.isConnected || state.activeEntityId !== card.id || state.panModifier ||
            state.codex.chatCardEntityId !== card.id || state.codex.chatDockMode !== 'canvas' ||
            Math.abs(state.zoomTarget - target.zoom) > 0.001 ||
            Math.abs(state.panTarget.x - target.pan.x) > 0.25 ||
            Math.abs(state.panTarget.y - target.pan.y) > 0.25) { cancel(); return; }
        const settled = Math.abs(state.zoom - target.zoom) < 0.0015 &&
          Math.abs(state.pan.x - target.pan.x) < 0.25 &&
          Math.abs(state.pan.y - target.pan.y) < 0.25;
        if (settled && entry.level === 'detail') {
          const composer = card.querySelector('.egd-codex-input');
          const active = document.activeElement;
          const humanFocusMovedElsewhere = active && active !== initialFocus &&
            active !== viewport && !card.contains(active);
          if (composer?.isConnected && !composer.disabled &&
              !humanFocusMovedElsewhere &&
              (!card.contains(active) || active === composer || active === entry.proxy)) {
            composer.focus({ preventScroll: true });
          }
          cancel();
          return;
        }
        if (++checks >= 180) { cancel(); return; }
        frame = window.requestAnimationFrame(check);
      };
      document.addEventListener('mousedown', onOtherInput, true);
      cancelPendingChatComposerFocus = cancel;
      frame = window.requestAnimationFrame(check);
      return true;
    };
    state.focusChatDockIfCompact = focusChatDockIfCompact;
    const layerObserver = new MutationObserver(() => { syncEntries(); request(); });
    layerObserver.observe(layer, { childList: true });
    const ancestorVisibilityObserver = new MutationObserver(() => {
      for (const entry of entries.values()) entry.visibilityDirty = true;
      request();
    });
    for (const node of [document.documentElement, viewport, layer]) {
      ancestorVisibilityObserver.observe(node, { attributes: true, attributeFilter: ['class', 'hidden'] });
    }
    coarsePointer?.addEventListener?.('change', request);
    const render = () => {
      syncEntries();
      const zoom = state.zoom;
      const pan = state.pan;
      const coarse = coarsePointer?.matches || false;
      const markerSize = coarse ? 44 : 36;
      const visibleMarkers = [];
      const entryById = new Map(Array.from(entries.values()).map(entry => [entry.card.id, entry]));
      for (const entry of entries.values()) {
        const { card, proxy } = entry;
        if (!card.isConnected) continue;
        if (!authorVisible(entry)) {
          entry.inView = false;
          entry.level = null;
          if (!proxy.hidden) proxy.hidden = true;
          if (card.hasAttribute('data-egd-semantic-level')) delete card.dataset.egdSemanticLevel;
          continue;
        }
        if (entry.kind === 'chat') fitCodexChatCardToReadableViewport(card, safeViewportRect(), entry.bodyFontPx);
        if (entry.kind === 'browser') card._browserPresentation?.layout();
        const rect = screenRect(card, zoom, pan);
        entry.rect = rect;
        if (entry.kind === 'browser' && !card._browserState?.loading &&
            rect.width >= detailWidth * .88 && rect.height >= detailHeight * .88 &&
            rect.x + rect.width > 0 && rect.y + rect.height > 0 &&
            rect.x < window.innerWidth && rect.y < window.innerHeight) card._browserPresentation?.ensure();
        const projectedFont = entry.kind === 'browser' ? card._browserPresentation?.font() : null;
        const measuredFont = Number.isFinite(projectedFont) && projectedFont > 0;
        let level = isCardFullscreen(card) ? 'detail' : SurfaceState.surfaceSemanticLevel({
          width: rect.width, height: rect.height, fontPx: measuredFont ? projectedFont : entry.bodyFontPx * zoom, previous: entry.level,
          detailWidth, detailHeight,
        });
        // Browser's two control rows need a tighter readable band than a
        // generic View; keep a small enter/exit gap rather than flickering.
        if (entry.kind === 'browser' && !measuredFont && !isCardFullscreen(card) && level === 'detail'
          && zoom < (entry.level === 'detail' ? 0.76 : 0.82)) {
          level = SurfaceState.surfaceSemanticLevel({
            width: rect.width, height: rect.height, fontPx: 0.1,
            previous: entry.level === 'outline' ? 'outline' : null,
            detailWidth, detailHeight,
          });
        }
        if (level !== entry.level) {
          entry.level = level;
          card.dataset.egdSemanticLevel = level;
          proxy.dataset.lod = level;
        }
        const title = titleFor(entry);
        if (entry.label.textContent !== title) entry.label.textContent = title;
        const sourceText = entry.kind === 'browser' && card._browserState?.uri
          ? browserDisplayHost(card._browserState.uri) : '';
        if (entry.source.textContent !== sourceText) entry.source.textContent = sourceText;
        entry.source.hidden = !sourceText || sourceText === title;
        const accessible = `${title}${sourceText && sourceText !== title ? ` · ${sourceText}` : ''} · ${typeLabels[entry.kind] || '화면'}으로 이동`;
        if (proxy.getAttribute('aria-label') !== accessible) proxy.setAttribute('aria-label', accessible);
        if (level === 'detail') {
          entry.wasProxyFocused = document.activeElement === proxy;
          if (!proxy.hidden) proxy.hidden = true;
          continue;
        }
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const px = level === 'marker' ? cx - markerSize / 2 : rect.x;
        const py = level === 'marker' ? cy - markerSize / 2 : rect.y;
        const pw = level === 'marker' ? markerSize : rect.width;
        const ph = level === 'marker' ? markerSize : rect.height;
        const inView = px + pw >= 0 && py + ph >= 0 && px <= window.innerWidth && py <= window.innerHeight;
        entry.inView = inView;
        if (level === 'outline' && proxy.hidden === inView) proxy.hidden = !inView;
        if (!inView) continue;
        place(proxy, px, py, pw, ph, rect.x, rect.y, zoom);
        if (level === 'marker') visibleMarkers.push({ id: card.id, cx, cy, width: markerSize, height: markerSize });
      }
      const clustered = new Set();
      const currentClusters = new Set();
      for (const memberIds of SurfaceState.surfaceProximityClusters(visibleMarkers, coarse ? 56 : 42)) {
        const key = [...memberIds].sort().join('|');
        currentClusters.add(key);
        memberIds.forEach(id => clustered.add(id));
        let button = clusterButtons.get(key);
        if (!button) {
          button = el('button', { type: 'button', class: 'egd-semantic-cluster', onclick: ev => {
            ev.stopPropagation();
            focusCluster(button._egdMembers || []);
          } }, el('span', { class: 'egd-semantic-count' }));
          button.style.position = 'absolute';
          button.style.transformOrigin = 'top left';
          layer.appendChild(button);
          clusterButtons.set(key, button);
        }
        button._egdMembers = memberIds;
        const memberList = memberIds.join(',');
        if (button.dataset.memberIds !== memberList) button.dataset.memberIds = memberList;
        if (button.dataset.count !== String(memberIds.length)) button.dataset.count = String(memberIds.length);
        if (button.firstChild.textContent !== `${memberIds.length}개`) button.firstChild.textContent = `${memberIds.length}개`;
        const names = memberIds.map(id => entryById.get(id)?.label.textContent || id);
        const accessible = `${names.join(', ')} · ${memberIds.length}개 화면 영역으로 이동`;
        if (button.getAttribute('aria-label') !== accessible) button.setAttribute('aria-label', accessible);
        const clusterZ = String(Math.max(...memberIds.map(id => parsePxNumber(entryById.get(id)?.card.style.zIndex, 0))));
        if (button.style.zIndex !== clusterZ) button.style.zIndex = clusterZ;
        const points = visibleMarkers.filter(marker => memberIds.includes(marker.id));
        const cx = points.reduce((sum, point) => sum + point.cx, 0) / points.length;
        const cy = points.reduce((sum, point) => sum + point.cy, 0) / points.length;
        const clusterWidth = coarse ? 52 : 48;
        const clusterHeight = coarse ? 48 : 44;
        place(button, cx - clusterWidth / 2, cy - clusterHeight / 2,
          clusterWidth, clusterHeight, pan.x, pan.y, zoom);
      }
      for (const [key, button] of clusterButtons) {
        if (currentClusters.has(key)) continue;
        if (document.activeElement === button) viewport.focus({ preventScroll: true });
        button.remove();
        clusterButtons.delete(key);
      }
      for (const entry of entries.values()) {
        if (entry.level !== 'marker') continue;
        const hidden = !entry.inView || clustered.has(entry.card.id);
        if (entry.proxy.hidden !== hidden) entry.proxy.hidden = hidden;
      }
      for (const entry of entries.values()) {
        const cluster = Array.from(clusterButtons.values()).find(button => button._egdMembers?.includes(entry.card.id));
        const focusTarget = !entry.proxy.hidden ? entry.proxy : cluster || viewport;
        syncProjectionAccessibility(entry, entry.level === 'outline' || entry.level === 'marker', focusTarget);
      }
    };
    syncEntries();
    state.renderSemanticProjections = render;
    state.refreshSemanticProjections = request;
    return {
      refresh: request,
      focusChatDockIfCompact,
      snapshot: () => ({
        cards: Array.from(entries.values()).map(entry => ({
          id: entry.card.id, kind: entry.kind, level: entry.level,
          world: entry.rect?.world || null,
          screen: entry.rect && { x: entry.rect.x, y: entry.rect.y, width: entry.rect.width, height: entry.rect.height },
        })),
        clusters: Array.from(clusterButtons.values()).map(button => ({
          memberIds: [...(button._egdMembers || [])], count: Number(button.dataset.count),
        })),
      }),
    };
  }

  function installCanvasPanZoom(viewport, layer) {
    const zoomValue = el('span', { class: 'egd-zoom-value', 'aria-live': 'off' }, '100%');
    const zoomOutButton = el('button', { type: 'button', class: 'egd-zoom-button', 'aria-label': 'Canvas 축소', title: 'Canvas 축소' }, deskIcon('minimize'));
    const zoomInButton = el('button', { type: 'button', class: 'egd-zoom-button', 'aria-label': 'Canvas 확대', title: 'Canvas 확대' }, deskIcon('plus'));
    const zoomFitButton = el('button', { type: 'button', class: 'egd-zoom-button', 'aria-label': '열린 창 전체 보기', title: '열린 창 전체 보기' }, deskIcon('fit'));
    const indicator = el('div', { id: 'egd-zoom-indicator', role: 'group', 'aria-label': 'Canvas 보기', data: { noPan: 'true' } },
      zoomOutButton, zoomValue, zoomInButton, el('span', { class: 'egd-zoom-divider', 'aria-hidden': 'true' }), zoomFitButton);
    for (const eventName of ['mousedown', 'pointerdown', 'wheel']) {
      indicator.addEventListener(eventName, event => {
        event.stopPropagation();
        if (eventName === 'wheel') event.preventDefault();
      }, { passive: false });
    }
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
      zoomValue.textContent = Math.round(state.zoom * 100) + '%';
      syncCardFullscreenLayout();
      viewport.style.setProperty('--egd-camera-pan-x', state.pan.x + 'px');
      viewport.style.setProperty('--egd-camera-pan-y', state.pan.y + 'px');
      viewport.style.setProperty('--egd-camera-zoom', String(state.zoom));
      viewport.style.setProperty('--egd-wood-opacity', String(Math.max(0, Math.min(1, (state.zoom * 100 - 2) / 10))));
      // Far out, Board names leave the shrinking title row and keep their screen size.
      const boardLabel = SurfaceState.boardRegionLabelScale(state.zoom);
      layer.style.setProperty('--egd-board-label-scale', String(boardLabel.scale));
      const boardLabelMode = boardLabel.far ? 'far' : 'near';
      if (layer.dataset.egdBoardLabel !== boardLabelMode) layer.dataset.egdBoardLabel = boardLabelMode;
      state.renderSemanticProjections?.();
      refreshDeskMinimap();
      scheduleViewportBoardSync();
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

      const zoomTolerance = Math.min(0.0015, state.zoomTarget * 0.01);
      const settled = Math.abs(panDx) < 0.25 && Math.abs(panDy) < 0.25 && Math.abs(zoomDelta) < zoomTolerance;
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
      if (SurfaceState.cameraMoveImmediate(options, prefersReducedMotion())) {
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
      if (SurfaceState.cameraMoveImmediate(options, prefersReducedMotion())) {
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
      return !!target.closest('#egd-hud, #egd-codex-activity-panel, #egd-codex-input-panel, #egd-answer-briefing, #egd-zoom-indicator, #egd-dock, #egd-preset-bag, #egd-desk-rail');
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
    const zoomCanvasByFactor = (factor, cx, cy) => {
      let prevZoom = state.zoomTarget;
      let nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prevZoom * factor));
      let anchorX = cx;
      let anchorY = cy;
      if (state.surface.initialBrowserFocus && factor < 1) {
        const restoringBrowser = state.cardFullscreen?.cardId === state.surface.browserCardId;
        enterLocalDesk();
        if (restoringBrowser) {
          // Fullscreen exit fits the saved Browser rect into the Desk. Apply
          // this gesture to that new camera, not the stale fullscreen pose.
          prevZoom = state.zoomTarget;
          nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, prevZoom * factor));
          const safe = safeViewportRect({ avoidHud: false });
          anchorX = safe.left + safe.width / 2;
          anchorY = safe.top + safe.height / 2;
        }
      }
      if (nextZoom === prevZoom) return;
      const ratio = nextZoom / prevZoom;
      state.panTarget.x = anchorX - (anchorX - state.panTarget.x) * ratio;
      state.panTarget.y = anchorY - (anchorY - state.panTarget.y) * ratio;
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
    const zoomCanvasByWheel = (ev) => {
      const unit = normalizeWheelDelta(ev);
      zoomCanvasByFactor(Math.exp(-ev.deltaY * unit * WHEEL_ZOOM_SPEED), ev.clientX, ev.clientY);
    };

    const zoomAtSafeCenter = factor => {
      const safe = safeViewportRect();
      zoomCanvasByFactor(factor, safe.left + safe.width / 2, safe.top + safe.height / 2);
    };
    zoomOutButton.addEventListener('click', () => zoomAtSafeCenter(1 / 1.2));
    zoomInButton.addEventListener('click', () => zoomAtSafeCenter(1.2));
    zoomFitButton.addEventListener('click', () => {
      const cards = Array.from(layer.querySelectorAll(':scope > .egd-canvas-card'))
        .filter(card => card.isConnected && !card.hidden && card.getClientRects().length
          && window.getComputedStyle(card).visibility === 'visible');
      if (!cards.length) {
        setCanvasViewportTarget({ pan: { x: 0, y: 0 }, zoom: 1 });
        return;
      }
      const rects = cards.map(persistentEntityGeometry);
      const left = Math.min(...rects.map(rect => rect.x));
      const top = Math.min(...rects.map(rect => rect.y));
      const right = Math.max(...rects.map(rect => rect.x + rect.width));
      const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
      setCanvasViewportTarget(SurfaceState.fitSurfaceCamera(
        { x: left, y: top, width: right - left, height: bottom - top },
        safeViewportRect({ margin: 32 }), 0.9,
      ));
    });

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
      const closedLabel = finishCanvasLabelEdits();
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
      if (state.activeTool === 'label') {
        // A click while a label is open only closes it; the next click adds one.
        ev.preventDefault();
        if (closedLabel) return;
        const point = viewportToCanvasPoint(ev.clientX, ev.clientY);
        const shape = createCanvasShape('label');
        shape.style.left = `${Math.round(point.x)}px`;
        shape.style.top = `${Math.round(point.y - 12)}px`;
        layer.appendChild(shape);
        setActiveEntity(shape);
        beginCanvasLabelEdit(shape, { created: true });
        return;
      }
      if (state.activeTool === 'pencil') {
        const start = viewportToCanvasPoint(ev.clientX, ev.clientY);
        const shape = createCanvasShape('path');
        shape.classList.add('egd-canvas-shape-drawing');
        updateCanvasPathGeometry(shape, [[start.x, start.y]]);
        layer.appendChild(shape);
        shapeDraw = { shape, start, current: start, points: [[start.x, start.y]],
          clientX: ev.clientX, clientY: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, moved: false };
        setActiveEntity(null);
        ev.preventDefault();
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
        if (shapeDraw.points) {
          // Sample the pen every 2 screen pixels; release simplifies the whole stroke.
          if (Math.hypot(ev.clientX - shapeDraw.lastX, ev.clientY - shapeDraw.lastY) >= 2
              && shapeDraw.points.length < SurfaceState.CANVAS_PATH_MAX_POINTS) {
            shapeDraw.points.push([current.x, current.y]);
            shapeDraw.lastX = ev.clientX;
            shapeDraw.lastY = ev.clientY;
            updateCanvasPathGeometry(shapeDraw.shape, shapeDraw.points);
          }
          return;
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
        const draw = shapeDraw;
        shapeDraw = null;
        if (draw.points) {
          draw.points.push([draw.current.x, draw.current.y]);
          const points = SurfaceState.simplifyCanvasPath(draw.points, 1 / Math.max(0.01, state.zoomTarget));
          if (!draw.moved || points.length < 2) {
            // A pen click without a stroke leaves nothing behind.
            draw.shape._cleanup?.();
            draw.shape.remove();
            return;
          }
          updateCanvasPathGeometry(draw.shape, points);
        } else {
          updateCanvasShapeGeometry(draw.shape, draw.start, draw.current, { defaultSize: !draw.moved });
        }
        draw.shape.classList.remove('egd-canvas-shape-drawing');
        setActiveEntity(draw.shape);
        markAgendaDirty('create-shape', draw.shape);
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

    // Canvas zoom uses the same camera whether the URL field or another
    // in-chrome control has focus. Capture before Firefox's page-zoom keyset.
    const handleCanvasZoomKeydown = (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.isComposing && ev.keyCode !== 229) {
        const zoomOut = ev.key === '-' || ev.key === '_' || ev.code === 'NumpadSubtract';
        const zoomIn = ev.key === '+' || ev.key === '=' || ev.code === 'NumpadAdd';
        if (zoomOut || zoomIn) {
          zoomCanvasByFactor(zoomOut ? 1 / 1.2 : 1.2, window.innerWidth / 2, window.innerHeight / 2);
          ev.preventDefault();
          ev.stopImmediatePropagation();
          return;
        }
      }
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
    };
    // 리셋 단축키: Ctrl/⌘+0
    // (팬 modifier로 Space는 쓰지 않는다 — 터미널/브라우저 카드 안의
    //  스페이스 입력과 충돌. Cmd+드래그가 팬 제스처)
    window.addEventListener('keydown', handleCanvasZoomKeydown, true);
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
      state.refreshSemanticProjections?.();
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
    // Legacy "browser" lifecycle records now resolve to a Desk camera pose.
    state.surface.mode = 'desk';
    document.documentElement.dataset.egdSurfaceMode = 'desk';
    document.getElementById('egd-canvas-viewport')?.setAttribute('data-presentation', 'visible');
    if (!state.surface.recoveryProtected) writeSurfacePref(SURFACE_LIFECYCLE_PREF, { version: 1, mode: 'desk', browserCardId: state.surface.browserCardId });
  }

  function focusInitialBrowserCard(card, { persist = false } = {}) {
    if (!card) return false;
    // Use the existing Card fullscreen presentation on the real Canvas. Its
    // saved rect is restored on zoom-out; the live Browser target is not moved.
    state.surface.browserCardId = card.id;
    setSurfaceMode('desk');
    card.classList.remove('egd-first-use-browser');
    card.dataset.testid = 'browser-card';
    state.surface.initialBrowserFocus = true;
    document.documentElement.classList.add('egd-initial-browser-focus');
    const camera = SurfaceState.fitSurfaceCamera(persistentEntityGeometry(card), safeViewportRect({ margin: 0 }), 1);
    state.setCanvasViewportTarget?.(camera, { immediate: true });
    enterCardFullscreen(card);
    if (!isCardFullscreen(card)) {
      state.surface.initialBrowserFocus = false;
      document.documentElement.classList.remove('egd-initial-browser-focus');
      return false;
    }
    if (persist) persistDeskSession();
    return true;
  }

  // Retained for existing external callers; returning to Desk reveals the same
  // Card and Canvas rather than constructing a second Browser surface.
  function enterLocalDesk() {
    if (!state.surface.initialBrowserFocus) return false;
    if (state.cardFullscreen?.cardId === state.surface.browserCardId) return exitCardFullscreen();
    state.surface.initialBrowserFocus = false;
    document.documentElement.classList.remove('egd-initial-browser-focus');
    scheduleDeskSessionSave();
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
      const mode = SurfaceState.initialSurfaceMode({ lifecycle, deskSession, legacyStore });
      const focusInitialBrowser = SurfaceState.shouldFocusInitialBrowser({ lifecycle, deskSession, legacyStore, recoveryProtected: recovery.protected });
      state.surface.browserCardId = deskSession?.surface?.browserCardId || lifecycle?.browserCardId || null;
      if (focusInitialBrowser) {
        let card = document.getElementById(state.surface.browserCardId) || document.querySelector('.egd-browser-card');
        if (!card) card = spawnBrowserCard(EGDESK_START_URI, { firstUse: true });
        focusInitialBrowserCard(card);
        window.setTimeout(() => {
          if (!card.isConnected || state.surface.browserCardId !== card.id) return;
          const input = card.querySelector('.egd-card-url');
          if (!input) return;
          if (input.value === EGDESK_START_URI) input.value = '';
          input.placeholder = '주소 또는 검색어 입력';
          input.focus();
        }, 0);
      }
      if (!focusInitialBrowser) {
        setSurfaceMode(mode);
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
    syncActiveToolMode();
    document.body.style.background = 'var(--egd-wood)';
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
      const semantic = installSemanticZoom(canvasViewport, canvasLayer);
      installCanvasPanZoom(canvasViewport, canvasLayer);
      installNativeGestureHelperBridge();
      state.codexBridge = installCodexBridge(legacyChatRecords);
      window.__egdesk = {
        state,
        semantic,
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
        browserAgentTools: {
          selectedSources: browserToolSelectedSources,
          dispatch: browserToolDispatch,
          attachTransport: attachBrowserToolTransport,
          authorizePhysicalAction: browserToolAuthorizePhysicalAction,
          fixtureActionDiagnostic: browserToolFixtureActionDiagnostic,
          rootSseReady: () => state.codexBridge?.rootSseReady?.() || {
            sourceReady: false, stable: false, eventSourceReadyState: null,
            browserTransportId: null, sampledAtMs: Date.now(),
          },
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
          viewport: () => ({ ...viewportBoardResolution(), label: viewportBoardLabel().text }),
        },
        shapes: {
          serialize: serializeShapeState,
          restore: restoreShapeFromState,
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
