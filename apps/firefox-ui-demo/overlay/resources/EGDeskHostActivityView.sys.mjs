// CU-01 host-activity view: what is happening on this Mac outside the Desk,
// who holds its mouse and keyboard, and the controls to pause, stop or hand
// back. The bridge's GET /host/activity and SSE 'host.activity' /
// 'host.control' frames (helper/egdesk-host-control.mjs) come in; Korean rows
// and button states go out, plus a small DOM renderer for the Desk window.
// No request, timer or global document here: the surface owns those.
//
// Privacy boundary (CU-01): rows carry app names, bundle ids, pids, counts,
// epochs and times only. Nothing here reads or shows screenshots, window
// titles, typed text, keys or coordinates; unknown row fields are dropped.
export const HOST_ACTIVITY_PATH = '/host/activity';
export const HOST_CONTROL_PATH = '/host/control';
export const HOST_ACTIVITY_ROW_LIMIT = 200;
export const HOST_ACTIONS = Object.freeze(['pause', 'stop', 'stopApp', 'handBack']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 128) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const int = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,255}$/;

export const HOST_CONTROLLER_LABELS = Object.freeze({
  'egdesk-agent': { label: 'EG-Desk Agent가 조작 중', tone: 'agent' },
  'codex-computer-use': { label: 'Codex 컴퓨터 조작 중', tone: 'codex' },
  person: { label: '사람이 사용 중', tone: 'person' },
  none: { label: '조작하는 쪽 없음', tone: 'idle' },
});
const LEASE_LABELS = { ready: '입력권 비어 있음', user: '사람이 사용 중', ai: 'Agent가 입력권을 가짐', unavailable: 'Agent 입력 막힘' };
const LEASE_REASON_LABELS = { monitor: '입력 감시 없음', guard: '입력 게이트 닫힘', stopped: '중지됨' };
export const HOST_GATE_REASON_LABELS = Object.freeze({
  initial: '아직 열지 않음',
  'heartbeat-missing': '관찰 도우미 신호 없음',
  'heartbeat-stale': '관찰 도우미 신호 늦음',
  'heartbeat-replay': '관찰 도우미 신호 이상',
  'unknown-state': '알 수 없는 입력권 상태',
  'stop-request': '중지 요청',
  'emergency-stop': '긴급 중지 키',
  error: '확인 오류',
});
const AGENT_LABELS = {
  idle: '관찰 도우미 대기', starting: '관찰 도우미 시작 중', ready: '관찰 중 · 입력 없음', restarting: '관찰 도우미 다시 시작 중',
  stopped: '관찰 도우미 멈춤', failed: '관찰 도우미 시작 실패', unavailable: '관찰 도우미를 쓸 수 없음', unknown: '관찰 도우미 상태 모름',
};
const AGENT_CODE_LABELS = {
  HOST_AGENT_UNSUPPORTED: '이 컴퓨터는 macOS가 아니라 관찰 도우미를 쓸 수 없습니다.',
  HOST_AGENT_EXECUTABLE: '관찰 도우미(egdesk-helper)가 아직 빌드되지 않았습니다.',
  HOST_AGENT_FAILED: '관찰 도우미가 여러 번 멈춰 다시 시작하지 않습니다.',
};
const COMMAND_PHASES = {
  dispatched: '동작 보냄', 'not-dispatched': '동작 보내지 않음', finished: '동작 끝', preempted: '동작 중단됨',
  unknown: '동작 결과 모름', cleanup: '눌린 키·버튼 정리',
};
export const HOST_ACTION_LABELS = Object.freeze({
  pause: '일시중지 · 내가 쓰기', stop: '모두 중지', stopApp: '이 앱만 중지', handBack: 'Agent에게 돌려주기',
});
export const HOST_ACTIVITY_NOTES = Object.freeze({
  privacy: '화면, 창 제목, 입력한 글자는 저장하거나 보여 주지 않습니다. 앱 이름·번호·횟수와 시각만 표시합니다.',
  codexDisplayOnly: 'Codex가 조작하는 중에 사람이 손대도 자동으로 멈추지 않고 표시만 합니다. 멈추려면 [일시중지]나 [모두 중지]를 누르세요.',
  observeOnly: '지금 관찰 도우미는 입력을 보내지 않고 입력 감시도 없어 EG-Desk Agent의 입력은 계속 막혀 있습니다.',
  chord: '긴급 중지 키 Ctrl+Alt+Shift+.는 입력 모니터링 권한이 필요해 아직 연결되지 않았습니다. 지금은 [모두 중지]를 쓰세요.',
});

function appOf(value) {
  if (!object(value)) return null;
  const bundleId = typeof value.bundleId === 'string' && BUNDLE_ID.test(value.bundleId) ? value.bundleId : null;
  const name = text(value.name) || null;
  const pid = Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null;
  if (!bundleId && !name && !pid) return null;
  return { bundleId, name, pid, ...(Number.isFinite(value.since) ? { since: value.since } : {}) };
}
const appLabel = app => app ? (app.name || app.bundleId || (app.pid ? `pid ${app.pid}` : '알 수 없는 앱')) : '알 수 없는 앱';

// Only the fields each row kind is known to carry; anything else is dropped.
function rowOf(value) {
  if (!object(value) || !Number.isSafeInteger(value.seq) || !Number.isFinite(value.at)) return null;
  const base = { seq: value.seq, at: value.at, kind: value.kind };
  switch (value.kind) {
    case 'front-app': {
      const app = appOf(value.app);
      if (!app) return null;
      return { ...base, app, previous: appOf(value.previous), duringCodex: value.duringCodex === true,
        ...(int(value.returnedAfterMs) !== null ? { returnedAfterMs: value.returnedAfterMs } : {}) };
    }
    case 'service': return { ...base, running: value.running === true, pidCount: int(value.pidCount) ?? 0 };
    case 'codex-computer': return { ...base, runId: text(value.runId), calls: int(value.calls) ?? 0, active: value.active === true };
    case 'control': {
      const event = ['state', 'yielded', 'stopped', 'gate'].includes(value.event) ? value.event : null;
      if (!event) return null;
      return { ...base, event, state: text(value.state, 16) || null, from: text(value.from, 16) || null, epoch: int(value.epoch),
        reason: text(value.reason, 32) || null, scope: value.scope === 'app' ? 'app' : value.scope === 'all' ? 'all' : null,
        app: text(value.app, 256) || null, notDispatched: int(value.notDispatched) ?? 0, inFlight: int(value.inFlight) ?? 0 };
    }
    case 'command': {
      if (!Object.hasOwn(COMMAND_PHASES, value.phase)) return null;
      return { ...base, phase: value.phase, app: text(value.app, 256) || null, code: /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code ?? '') ? value.code : null,
        steps: int(value.steps) };
    }
    default: return null;
  }
}

function controlOf(value) {
  if (!object(value)) return null;
  const lease = object(value.lease) ? {
    state: Object.hasOwn(LEASE_LABELS, value.lease.state) ? value.lease.state : null,
    epoch: int(value.lease.epoch),
    yielded: value.lease.yielded === true,
    held: value.lease.held === true,
    reasons: Array.isArray(value.lease.reasons) ? value.lease.reasons.filter(reason => Object.hasOwn(LEASE_REASON_LABELS, reason)) : [],
    stoppedApps: Array.isArray(value.lease.stoppedApps) ? value.lease.stoppedApps.map(app => text(app, 256)).filter(Boolean).slice(0, 32) : [],
    activeCalls: int(value.lease.activeCalls) ?? 0,
  } : null;
  const gate = object(value.gate) ? {
    state: value.gate.state === 'open' ? 'open' : 'closed',
    epoch: int(value.gate.epoch),
    reason: Object.hasOwn(HOST_GATE_REASON_LABELS, value.gate.reason) ? value.gate.reason : null,
    heartbeatAgeMs: int(value.gate.heartbeatAgeMs),
  } : null;
  const agent = object(value.agent) ? {
    state: Object.hasOwn(AGENT_LABELS, value.agent.state) ? value.agent.state : 'unknown',
    alive: value.agent.alive === true,
    inputMonitor: value.agent.inputMonitor === true,
    code: text(value.agent.code, 64) || null,
  } : null;
  const codex = object(value.codex) ? { active: value.codex.active === true, calls: int(value.codex.calls) ?? 0, runId: text(value.codex.runId) || null } : null;
  return {
    controller: Object.hasOwn(HOST_CONTROLLER_LABELS, value.controller) ? value.controller : 'none',
    target: appOf(value.target),
    lease, gate, agent, codex,
    serviceRunning: object(value.service) ? value.service.running === true ? true : value.service.running === false ? false : null : null,
    at: Number.isFinite(value.at) ? value.at : null,
  };
}

/** A GET /host/activity answer as the view keeps it; null when unusable. */
export function normalizeHostActivity(raw) {
  const control = controlOf(raw);
  if (!control) return null;
  const rows = Array.isArray(raw.rows) ? raw.rows.map(rowOf).filter(Boolean) : [];
  return { ...control, rows: rows.slice(-HOST_ACTIVITY_ROW_LIMIT) };
}

/**
 * Apply one SSE frame. 'host.activity' adds a row (a seq already kept is
 * ignored), 'host.control' replaces the state but keeps the rows. Returns
 * the same object when nothing changed.
 */
export function reduceHostActivityEvent(state, event) {
  if (!object(event)) return state;
  if (event.type === 'host.control') {
    const control = controlOf(event.control);
    if (!control) return state;
    return { ...control, rows: state?.rows ?? [] };
  }
  if (event.type === 'host.activity') {
    const row = rowOf(event.row);
    if (!row || !state) return state;
    if (state.rows.some(kept => kept.seq === row.seq)) return state;
    const rows = [...state.rows, row].sort((a, b) => a.at - b.at || a.seq - b.seq).slice(-HOST_ACTIVITY_ROW_LIMIT);
    return { ...state, rows };
  }
  return state;
}

function rowView(row, formatTime) {
  const time = formatTime(row.at);
  const view = (title, detail = null, tone = 'default') => ({ id: `host-row-${row.seq}`, kind: row.kind, time, title, detail, tone });
  switch (row.kind) {
    case 'front-app': {
      const parts = [];
      if (row.duringCodex) parts.push('Codex 조작 중');
      if (row.returnedAfterMs !== undefined) parts.push(`${Math.max(1, Math.round(row.returnedAfterMs / 1000))}초 만에 원래 앱으로 돌아옴`);
      if (row.previous) parts.push(`이전: ${appLabel(row.previous)}`);
      return view(`앞 앱: ${appLabel(row.app)}`, parts.join(' · ') || null, row.duringCodex ? 'codex' : 'default');
    }
    case 'service': return view(row.running ? 'OpenAI 컴퓨터 조작 서비스 실행' : 'OpenAI 컴퓨터 조작 서비스 종료', null, 'codex');
    case 'codex-computer':
      return view(row.active ? `Codex 컴퓨터 조작 시작 · ${row.calls}번째` : `Codex 컴퓨터 조작 끝 · 모두 ${row.calls}번`, null, 'codex');
    case 'control': {
      const epoch = row.epoch !== null ? `차례 ${row.epoch}` : null;
      if (row.event === 'state') return view(`입력권: ${LEASE_LABELS[row.state] ?? '알 수 없음'}`, epoch, row.state === 'ai' ? 'agent' : 'default');
      if (row.event === 'yielded') return view(row.reason === 'user-request' ? '일시중지 · 사람에게 넘김' : '사람이 손대서 Agent가 양보함', epoch, 'person');
      if (row.event === 'stopped') {
        const what = row.scope === 'app' ? `${row.app ?? '앱'} 중지` : '모든 Agent 입력 중지';
        const detail = [`보내지 않은 동작 ${row.notDispatched}개`, row.inFlight ? `진행 중이던 동작 ${row.inFlight}개 정리` : null, epoch].filter(Boolean).join(' · ');
        return view(what, detail, 'danger');
      }
      const reason = row.reason ? HOST_GATE_REASON_LABELS[row.reason] ?? null : null;
      return view(row.state === 'open' ? '입력 게이트 열림' : '입력 게이트 닫힘', [reason, epoch].filter(Boolean).join(' · ') || null, row.state === 'open' ? 'agent' : 'danger');
    }
    case 'command': {
      const detail = [row.app, row.steps !== null ? `입력 ${row.steps}번` : null, row.code].filter(Boolean).join(' · ');
      return view(COMMAND_PHASES[row.phase], detail || null, ['preempted', 'unknown'].includes(row.phase) ? 'danger' : 'agent');
    }
    default: return view('알 수 없는 기록');
  }
}

/**
 * What the Desk window shows. connected false (bridge away) keeps the last
 * rows but disables every control and says the state is not current.
 */
export function hostActivityView(state, { connected = true, formatTime = at => new Date(at).toLocaleTimeString('ko-KR') } = {}) {
  if (!state) {
    return { status: connected ? 'loading' : 'offline', title: connected ? '불러오는 중…' : '연결이 끊겼습니다',
      controller: null, target: null, lease: null, gate: null, agent: null, rows: [], actions: [], notes: [HOST_ACTIVITY_NOTES.privacy] };
  }
  const { lease, gate, agent } = state;
  const controller = HOST_CONTROLLER_LABELS[state.controller] ?? HOST_CONTROLLER_LABELS.none;
  const leaseView = lease ? {
    label: lease.state ? LEASE_LABELS[lease.state] : '입력권 상태 모름',
    epoch: lease.epoch,
    epochLabel: lease.epoch !== null ? `차례 ${lease.epoch}` : '차례 모름',
    reasons: lease.reasons.map(reason => LEASE_REASON_LABELS[reason]),
    yielded: lease.yielded,
    stoppedApps: lease.stoppedApps,
  } : null;
  const gateView = gate ? {
    open: gate.state === 'open',
    label: gate.state === 'open' ? '입력 게이트 열림' : '입력 게이트 닫힘',
    reason: gate.state === 'open' ? null : gate.reason ? HOST_GATE_REASON_LABELS[gate.reason] : null,
    epoch: gate.epoch,
  } : null;
  const agentView = agent ? {
    label: AGENT_LABELS[agent.state],
    detail: agent.code ? AGENT_CODE_LABELS[agent.code] ?? null : null,
    alive: agent.alive,
  } : null;
  const target = state.target ? {
    label: appLabel(state.target),
    sub: [state.target.bundleId, state.target.pid ? `pid ${state.target.pid}` : null].filter(Boolean).join(' · ') || null,
    bundleId: state.target.bundleId,
  } : null;
  const live = connected === true;
  const stopped = Boolean(lease?.reasons.includes('stopped'));
  const handBackReady = live && lease?.epoch !== null && (lease?.yielded || stopped || gate?.state === 'closed');
  const actions = [
    { id: 'pause', label: HOST_ACTION_LABELS.pause, tone: 'default', enabled: live && Boolean(lease) && !lease.yielded,
      hint: '지금 하던 Agent 동작을 멈추고 사람이 Mac을 씁니다. [Agent에게 돌려주기]를 누를 때까지 Agent는 기다립니다.' },
    { id: 'stopApp', label: HOST_ACTION_LABELS.stopApp, tone: 'default', enabled: live && Boolean(target?.bundleId),
      hint: target ? `${target.label}에 대한 Agent 동작만 멈춥니다.` : '앞 앱을 알 수 없어 쓸 수 없습니다.' },
    { id: 'stop', label: HOST_ACTION_LABELS.stop, tone: 'danger', enabled: live,
      hint: '모든 Agent 입력을 끊고 입력 게이트를 닫습니다. 보내지 않은 동작은 버립니다.' },
    { id: 'handBack', label: HOST_ACTION_LABELS.handBack, tone: 'primary', enabled: Boolean(handBackReady),
      hint: gate?.state === 'closed' && !agent?.alive ? '관찰 도우미가 살아 있어야 입력 게이트를 다시 열 수 있습니다.' : '지금 보이는 차례 번호로 Agent에게 다시 넘깁니다.' },
  ];
  const notes = [HOST_ACTIVITY_NOTES.privacy, HOST_ACTIVITY_NOTES.codexDisplayOnly];
  if (agent && !agent.inputMonitor) notes.push(HOST_ACTIVITY_NOTES.observeOnly);
  notes.push(HOST_ACTIVITY_NOTES.chord);
  const rows = state.rows.map(row => rowView(row, formatTime)).reverse();
  return {
    status: live ? 'live' : 'offline',
    title: live ? null : '연결이 끊겨 지금 상태가 아닙니다',
    controller: { ...controller, id: state.controller },
    target, lease: leaseView, gate: gateView, agent: agentView,
    codex: state.codex?.active ? `Codex 컴퓨터 조작 ${state.codex.calls}번째 진행 중` : null,
    rows, actions, notes,
  };
}

/** The POST /host/control request for one button, with the epochs the screen showed. */
export function hostControlRequest(action, state) {
  if (!HOST_ACTIONS.includes(action) || !state) return null;
  if (action === 'pause' || action === 'stop') return { path: HOST_CONTROL_PATH, body: { action } };
  if (action === 'stopApp') {
    const bundleId = state.target?.bundleId;
    return bundleId ? { path: HOST_CONTROL_PATH, body: { action, target: { bundleId } } } : null;
  }
  if (state.lease?.epoch === null || state.lease?.epoch === undefined) return null;
  return { path: HOST_CONTROL_PATH, body: { action, epoch: state.lease.epoch, gateEpoch: state.gate?.epoch ?? null } };
}

/** Korean text for a failed control request. */
export function hostControlErrorText(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'HOST_CONTROL_STALE_EPOCH') return '그 사이 입력권 상태가 바뀌었습니다. 새 상태를 확인한 뒤 다시 눌러 주세요.';
  if (code === 'HOST_CONTROL_INVALID_TARGET') return '중지할 앱을 알 수 없습니다.';
  return '요청을 보내지 못했습니다. 연결을 확인한 뒤 다시 눌러 주세요.';
}

/** Korean text for a control answer the bridge accepted. */
export function hostControlResultText(action, result) {
  if (action === 'handBack') {
    if (result?.ok === false) return result.code === 'INPUT_HELD' ? '키나 버튼이 눌려 있어 아직 돌려줄 수 없습니다.' : '돌려주지 못했습니다.';
    if (result?.gateCode === 'INPUT_GATE_NO_HEARTBEAT') return '입력권은 돌려줬지만 관찰 도우미 신호가 없어 입력 게이트는 닫혀 있습니다.';
    if (result?.gateCode) return '입력권은 돌려줬지만 입력 게이트는 닫혀 있습니다. 새 상태로 다시 눌러 주세요.';
    return 'Agent에게 돌려줬습니다.';
  }
  if (action === 'pause') return 'Agent를 멈췄습니다. 지금은 사람이 씁니다.';
  if (action === 'stopApp') return `${result?.ack?.app ?? '이 앱'}에 대한 Agent 동작을 멈췄습니다.`;
  return `모든 Agent 입력을 멈췄습니다. 보내지 않은 동작 ${int(result?.ack?.notDispatched) ?? 0}개를 버렸습니다.`;
}

/**
 * createEGDeskHostActivityView({ document }) → { element, update, dispose }.
 * update(view, { onAction, notice, busy }) redraws from hostActivityView();
 * onAction(id) is called for an enabled button. testids: host-activity,
 * host-activity-controller, host-activity-target, host-activity-lease,
 * host-activity-gate, host-activity-agent, host-activity-action-<id>,
 * host-activity-row, host-activity-notice, host-activity-note.
 */
export function createEGDeskHostActivityView({ document } = {}) {
  if (typeof document?.createElement !== 'function') throw new TypeError('A document is required');
  const make = (tag, className = '', value, testid = null) => {
    const node = document.createElement(tag);
    node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    if (testid) node.setAttribute('data-testid', testid);
    return node;
  };
  const element = make('section', 'egd-host-activity', undefined, 'host-activity');
  element.setAttribute('aria-label', 'Desk 밖 조작');
  let listeners = [];
  const clear = () => {
    for (const [node, listener] of listeners) node.removeEventListener('click', listener);
    listeners = [];
    while (element.firstChild) element.removeChild(element.firstChild);
  };
  const fact = (label, value, sub, testid, tone = null) => {
    const node = make('div', 'egd-host-activity-fact', undefined, testid);
    if (tone) node.setAttribute('data-tone', tone);
    node.append(make('span', 'egd-host-activity-fact-label', label), make('strong', 'egd-host-activity-fact-value', value));
    if (sub) node.append(make('span', 'egd-host-activity-fact-sub', sub));
    return node;
  };
  function update(view, { onAction = null, notice = null, busy = false } = {}) {
    clear();
    element.setAttribute('data-state', view?.status ?? 'loading');
    if (view?.title) element.append(make('div', 'egd-host-activity-banner', view.title, 'host-activity-banner'));
    const facts = make('div', 'egd-host-activity-facts');
    if (view?.controller) facts.append(fact('지금 조작', view.controller.label, view.codex, 'host-activity-controller', view.controller.tone));
    facts.append(fact('대상 앱', view?.target?.label ?? '알 수 없음', view?.target?.sub ?? null, 'host-activity-target'));
    if (view?.lease) facts.append(fact('입력권', view.lease.label, [view.lease.epochLabel, ...view.lease.reasons].join(' · '), 'host-activity-lease'));
    if (view?.gate) facts.append(fact('입력 게이트', view.gate.label, [view.gate.reason, view.gate.epoch !== null ? `차례 ${view.gate.epoch}` : null].filter(Boolean).join(' · ') || null, 'host-activity-gate', view.gate.open ? 'agent' : 'danger'));
    if (view?.agent) facts.append(fact('관찰 도우미', view.agent.label, view.agent.detail, 'host-activity-agent'));
    element.append(facts);
    if (view?.actions?.length) {
      const bar = make('div', 'egd-host-activity-actions');
      for (const action of view.actions) {
        const button = make('button', `egd-settings-btn egd-host-activity-action egd-host-activity-action-${action.tone}`, action.label, `host-activity-action-${action.id}`);
        button.setAttribute('type', 'button');
        button.setAttribute('title', action.hint);
        const enabled = action.enabled && !busy && typeof onAction === 'function';
        if (!enabled) button.setAttribute('disabled', 'true');
        button.disabled = !enabled;
        if (enabled) {
          const listener = () => { onAction(action.id); };
          button.addEventListener('click', listener);
          listeners.push([button, listener]);
        }
        bar.append(button);
      }
      element.append(bar);
    }
    if (notice) {
      const node = make('div', 'egd-host-activity-notice', notice.text, 'host-activity-notice');
      node.setAttribute('role', notice.tone === 'error' ? 'alert' : 'status');
      element.append(node);
    }
    const list = make('ol', 'egd-host-activity-rows');
    list.setAttribute('aria-label', '조작 기록');
    for (const row of view?.rows ?? []) {
      const item = make('li', 'egd-host-activity-row', undefined, 'host-activity-row');
      item.setAttribute('data-kind', row.kind);
      item.setAttribute('data-tone', row.tone);
      item.append(make('time', 'egd-host-activity-row-time', row.time), make('span', 'egd-host-activity-row-title', row.title));
      if (row.detail) item.append(make('span', 'egd-host-activity-row-detail', row.detail));
      list.append(item);
    }
    if (!view?.rows?.length) list.append(make('li', 'egd-host-activity-empty', '아직 기록이 없습니다.'));
    element.append(list);
    for (const note of view?.notes ?? []) element.append(make('p', 'egd-host-activity-note', note, 'host-activity-note'));
  }
  return { element, update, dispose: clear };
}
