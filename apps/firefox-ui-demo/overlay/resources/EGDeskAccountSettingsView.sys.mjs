// Settings '계정' tab view models (SUB-05, SUB-01): bridge snapshots in, rows
// and confirmation copy out. Pure: no request, no DOM, no credential. The
// screen keeps every actual call (bridge().signOut(), startLogin(),
// refreshAuthStatus(), reconnectNow()) and asks here only what to show.
//
// Sources of truth: /v1/state auth (ChatGPT account, SUB-03), /v1/state
// engines[] rows with profiles[].auth from claude-engine-auth (SUB-08), the
// bridge connection notice (RT-05) and the chat protocol runs (SUB-02). A
// value the bridge did not report reads '확인 안 됨', never a guess.
import { isRunBusy, runsForThread, requestBelongsToThread, usageRingView } from './EGDeskChatState.sys.mjs';

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const text = value => typeof value === 'string' ? value.trim() : '';
const publicEmail = value => { const email = text(value); return email && email.length <= 320 && EMAIL.test(email) ? email : null; };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const SETTINGS_CONNECTION_STATES = Object.freeze(['online', 'checking', 'offline']);

/**
 * Whether the ChatGPT card may show account rows. `bridgeState` is the
 * EGDeskSurfaceState.bridgeConnectionNotice state ('online' | 'mismatch' |
 * 'reconnecting' | 'offline'): quiet reconnects and the first connection are
 * '확인 중', exhausted reconnects are '연결 끊김'. A stale account from before
 * the break is never shown as current.
 */
export function settingsConnectionView({ connected = false, bridgeState = null } = {}) {
  if (connected === true) return { state: 'online', title: null, sub: null, action: null, actionLabel: null };
  if (bridgeState === 'offline') {
    return {
      state: 'offline', title: '연결이 끊겼습니다',
      sub: '이 컴퓨터의 코덱스 연결 프로그램에 닿지 않습니다. 마지막으로 본 계정은 지금 상태가 아니므로 표시하지 않습니다.',
      action: 'reconnect', actionLabel: '다시 연결',
    };
  }
  return {
    state: 'checking', title: '연결 확인 중…',
    sub: '이 컴퓨터의 코덱스 연결 프로그램에 연결하고 있습니다. 계정과 사용 한도는 연결된 뒤 보여 드립니다.',
    action: null, actionLabel: null,
  };
}

/** ChatGPT account menu rows; nothing while signed out (the card's login button stands alone). */
export function accountMenuItems(auth) {
  if (auth?.isLoggedIn !== true) return [];
  return [
    { id: 'refresh', label: '상태 새로고침', tone: 'default' },
    { id: 'switch', label: '다른 계정으로 로그인', tone: 'default' },
    { id: 'signout', label: '로그아웃', tone: 'danger' },
  ];
}

/**
 * Work a sign-out would interrupt: busy runs and still-unconfirmed sends,
 * per Chat room (helper contract: protocol.runs / protocol.requests).
 */
export function busyRunSummary({ threads = [], protocol = null } = {}) {
  const rows = [];
  const requests = object(protocol?.requests) ? Object.values(protocol.requests) : [];
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (!object(thread)) continue;
    const runs = object(protocol?.runs) ? runsForThread(protocol, thread).filter(isRunBusy).length : 0;
    const pending = requests.filter(request => object(request) && requestBelongsToThread(request, thread)
      && ['submitting', 'unconfirmed'].includes(request.status)).length;
    const count = runs + pending;
    if (count > 0) rows.push({ id: thread.id ?? null, title: text(thread.title) || '제목 없는 대화', count });
  }
  return { count: rows.reduce((sum, row) => sum + row.count, 0), threads: rows };
}

export const ACCOUNT_ACTIONS = Object.freeze(['signout', 'switch']);
// Codex CLI, the IDE extension and EG-Desk share one cached ChatGPT login
// (learn.chatgpt.com/docs/auth), so a sign-out here reaches them too.
const SHARED_LOGIN_LINE = '이 컴퓨터의 코덱스 로그인을 함께 쓰므로 터미널의 codex와 IDE 확장도 같이 로그아웃됩니다.';

function busyLine(busy) {
  const rows = Array.isArray(busy?.threads) ? busy.threads.filter(row => object(row) && text(row.title)) : [];
  const count = Number.isSafeInteger(busy?.count) && busy.count > 0 ? busy.count : rows.reduce((sum, row) => sum + (Number.isSafeInteger(row.count) ? row.count : 0), 0);
  if (count <= 0) return { count: 0, line: '진행 중인 실행은 없습니다.' };
  const names = rows.slice(0, 3).map(row => `'${text(row.title)}'`);
  const more = rows.length > 3 ? ` 외 ${rows.length - 3}개 대화방` : '';
  const where = names.length ? ` (${names.join(', ')}${more})` : '';
  return { count, line: `진행 중인 실행 ${count}개가 중단될 수 있습니다${where}. 끝날 때까지 기다리거나 먼저 중지해 주세요.` };
}

/**
 * The confirmation shown before a sign-out or an account switch: who signs
 * out, what else it reaches, and which running work it would cut. The
 * person decides; nothing switches quietly (HUM-ENGINE-001 settled part).
 */
export function accountActionConfirm(action, { email = null, busy = null } = {}) {
  if (!ACCOUNT_ACTIONS.includes(action)) return null;
  const who = publicEmail(email) ? `${publicEmail(email)} 계정` : '지금 계정';
  const running = busyLine(busy);
  const tone = running.count > 0 ? 'danger' : 'warning';
  if (action === 'signout') {
    return {
      action, tone, busyCount: running.count, title: `${who}에서 로그아웃할까요?`,
      lines: [SHARED_LOGIN_LINE, running.line, '로그아웃한 뒤에는 다시 로그인할 때까지 이 계정의 대화를 이어서 보낼 수 없습니다.'],
      confirmLabel: running.count > 0 ? '그래도 로그아웃' : '로그아웃', cancelLabel: '취소',
    };
  }
  return {
    action, tone, busyCount: running.count, title: '다른 계정으로 로그인할까요?',
    lines: [`${who}에서 먼저 로그아웃한 뒤 ChatGPT 로그인 창을 엽니다. ${SHARED_LOGIN_LINE}`, running.line,
      '진행 중인 실행을 새 계정으로 옮기지 않습니다. 이전 계정의 대화는 그 계정으로 다시 로그인해야 이어집니다.'],
    confirmLabel: running.count > 0 ? '그래도 로그아웃 후 로그인' : '로그아웃 후 로그인', cancelLabel: '취소',
  };
}

/**
 * What the account rows say after the bridge answered a sign-out (and, for a
 * switch, a login start). `auth` is the auth state read back from the bridge;
 * `error` the client's last request error, if any.
 * phase: 'signedOut' (sign-out done, nothing more to do or login still to
 * start) | 'loginStarted' | 'error' | 'unknown' (the bridge still reports a login).
 */
export function accountActionOutcome(action, auth, { error = null, loginStarted = false } = {}) {
  if (!ACCOUNT_ACTIONS.includes(action)) return null;
  const failure = text(error);
  if (failure) {
    return { action, phase: 'error', text: `${action === 'switch' ? '계정을 바꾸지' : '로그아웃하지'} 못했습니다: ${failure}` };
  }
  if (auth?.isLoggedIn !== false) {
    return { action, phase: 'unknown', text: '로그아웃 결과를 확인하지 못했습니다. 상태 새로고침으로 다시 확인해 주세요.' };
  }
  if (action === 'switch') {
    if (loginStarted || auth.loginInProgress === true) {
      return { action, phase: 'loginStarted', text: '로그아웃했습니다. 브라우저 카드에서 새 계정으로 로그인을 마쳐 주세요.' };
    }
    return { action, phase: 'signedOut', text: '로그아웃했습니다. 새 로그인이 시작되지 않았으니 로그인 버튼으로 다시 시작해 주세요.' };
  }
  return { action, phase: 'signedOut', text: '로그아웃했습니다. 터미널의 codex도 다시 로그인해야 합니다.' };
}

// claude-engine-auth public methods → what pays for a turn (D-S1/D-S4).
const CLAUDE_METHOD_LABELS = Object.freeze({
  claudeai: 'Claude 구독',
  apiKey: 'Anthropic API 키',
  gateway: '사용자 지정 게이트웨이',
  external: '외부 클라우드 제공자',
});
const CLAUDE_LOGIN_HINT = '로그인을 눌러 터미널에서 Claude 로그인을 마친 뒤 다시 확인해 주세요. 이 컴퓨터의 Claude와 같은 로그인을 씁니다.';

/**
 * The Claude account card from the bridge's engines[] row (profiles[].auth is
 * the allow-listed `claude auth status` answer). status: 'disconnected' (no
 * bridge) | 'noReport' | 'notInstalled' | 'unavailable' | 'signedIn' | 'signedOut' | 'unknown'.
 */
export function claudeAccountView(engines, { connected = false } = {}) {
  const base = { methodLabel: null, method: null, account: null, planType: null, hint: null, billingLabel: null };
  if (connected !== true) {
    return { ...base, status: 'disconnected', title: '연결 안 됨', sub: 'EG-Desk 연결 프로그램에 닿지 않아 Claude 로그인 상태를 확인할 수 없습니다.', action: null };
  }
  const rows = (Array.isArray(engines) ? engines : []).filter(row => object(row) && row.id === 'claude');
  const row = rows.length === 1 ? rows[0] : null;
  if (!row) return { ...base, status: 'noReport', title: 'Claude 연결 확인 중', sub: '잠시 후 다시 확인해 주세요.', action: 'refresh' };
  if (row.installed === false || row.status === 'notInstalled') {
    return { ...base, status: 'notInstalled', title: 'Claude Code 설치 필요', sub: '이 컴퓨터에 Claude Code를 설치한 뒤 다시 확인해 주세요.', action: 'refresh' };
  }
  const profiles = (Array.isArray(row.profiles) ? row.profiles : []).filter(profile => object(profile) && profile.active === true);
  const profile = profiles.length === 1 ? profiles[0] : null;
  const auth = object(profile?.auth) ? profile.auth : null;
  const versionNotice = engineVersionBadge(engines, 'claude');
  const blocked = versionNotice?.title || (row.status === 'disabled' ? 'Claude 연결이 중지됐습니다. 연결 프로그램을 다시 켠 뒤 확인해 주세요.'
    : row.status === 'decisionPending' ? '아직 이 연결로는 Claude 대화를 시작할 수 없습니다.' : null);
  if (auth?.status === 'signedIn') {
    const method = Object.hasOwn(CLAUDE_METHOD_LABELS, auth.method) ? auth.method : null;
    const account = publicEmail(auth.account);
    const label = text(profile.label).slice(0, 80) || 'Claude';
    return {
      status: blocked ? 'unavailable' : 'signedIn', title: label, method, account, hint: blocked || null, action: 'refresh',
      sub: account || '로그인됨',
      methodLabel: method ? CLAUDE_METHOD_LABELS[method] : null,
      planType: method === 'claudeai' && text(auth.planType) ? text(auth.planType).slice(0, 40) : null,
      billingLabel: engineBillingLabel(auth),
    };
  }
  if (blocked) return { ...base, status: 'unavailable', title: 'Claude를 사용할 수 없습니다', sub: blocked, action: 'refresh' };
  if (auth?.status === 'signedOut') {
    const shared = profile.id === 'claude-default' && profile.owned !== true;
    const owned = profile.owned === true && profile.id !== 'claude-default' && /^claude-[a-z0-9]{1,40}$/.test(profile.id);
    return { ...base, status: 'signedOut', title: '로그인되어 있지 않습니다',
      sub: owned ? `${text(profile.label).slice(0, 60) || 'Claude'} · EG-Desk 전용 로그인` : 'Claude에 로그인하면 대화를 시작할 수 있습니다.',
      hint: owned ? '로그인을 눌러 이 계정 전용 터미널에서 로그인을 마친 뒤 다시 확인해 주세요. 컴퓨터의 공유 로그인은 바뀌지 않습니다.'
        : shared ? CLAUDE_LOGIN_HINT : '사용할 계정을 확인한 뒤 다시 확인을 눌러 주세요.',
      action: 'refresh', login: shared || owned, loginProfileId: shared || owned ? profile.id : null };
  }
  return { ...base, status: 'unknown', title: '로그인 상태 확인 안 됨', sub: '이 계정의 로그인 상태를 다시 확인해 주세요.', action: 'refresh' };
}

const activeProfile = (engines, engineId) => {
  const rows = (Array.isArray(engines) ? engines : []).filter(row => object(row) && row.id === engineId);
  const row = rows.length === 1 ? rows[0] : null;
  const profiles = (Array.isArray(row?.profiles) ? row.profiles : []).filter(profile => object(profile) && profile.active === true);
  return { row, profile: profiles.length === 1 ? profiles[0] : null };
};

/**
 * SUB-15 label: a profile paid by an API key is billed per use. Codex reports
 * the app-server authMode ('apikey'), engines[] rows the public method
 * ('apiKey'). EG-Desk never takes or stores an engine key (D-S4); this only
 * names what the CLI's own login already is.
 */
export function engineBillingLabel(auth) {
  if (!object(auth)) return null;
  return auth.method === 'apiKey' || auth.authMode === 'apikey' || auth.authMode === 'apiKey' ? '종량 과금' : null;
}

/** The Codex profile's billing badge from the live auth or the engines[] row. */
export function codexBillingLabel(auth, engines) {
  return engineBillingLabel(auth) || engineBillingLabel(activeProfile(engines, 'codex').profile?.auth);
}

const ENGINE_NAMES = Object.freeze({ codex: 'Codex', claude: 'Claude' });

/** A compatibility check is not a failed login. Surface only an actionable result. */
export function engineVersionBadge(engines, engineId) {
  if (!Object.hasOwn(ENGINE_NAMES, engineId)) return null;
  const { row } = activeProfile(engines, engineId);
  if (!row || row.installed === false) return null;
  if (engineId === 'claude' && row.status === 'versionUnsupported') {
    const title = row.statusReason === 'belowMinimum' ? '지금 버전으로는 대화를 시작할 수 없습니다. Claude Code를 업데이트한 뒤 다시 확인해 주세요.'
      : row.statusReason === 'versionUnknown' ? 'Claude Code 버전을 읽을 수 없어 대화를 시작할 수 없습니다. 설치 상태를 확인한 뒤 다시 확인해 주세요.'
        : '지금 설치된 Claude Code로는 대화를 시작할 수 없습니다. Claude Code를 업데이트한 뒤 다시 확인해 주세요.';
    return { engineId, status: 'unsupported', tone: 'danger', label: row.statusReason === 'versionUnknown' ? '설치 확인 필요' : '업데이트 필요', title };
  }
  // D-S6: Codex still runs below the recommended minimum; don't imply a gate.
  return engineId === 'codex' && row.versionStatus === 'unsupported'
    ? { engineId, status: 'unsupported', tone: 'warning', label: 'Codex 업데이트 권장', title: '대화는 계속할 수 있지만 일부 기능이 동작하지 않을 수 있습니다.' } : null;
}

/**
 * SUB-03 (Claude): the Claude profile's usage (claude-engine-adapter usage(),
 * engines[].profiles[].usage) in the same ring shape as the ChatGPT one.
 * null while Claude is not signed in; '확인 안 됨' before the first report.
 */
export function claudeUsageView(engines) {
  const { profile } = activeProfile(engines, 'claude');
  if (profile?.auth?.status !== 'signedIn') return null;
  const usage = object(profile.usage) ? profile.usage : null;
  const view = usageRingView({ isLoggedIn: true, usage, rateLimits: null });
  if (!view) return null;
  return {
    ...view,
    windowLabel: typeof usage?.windowLabel === 'string' ? usage.windowLabel : null,
    percentLabel: typeof usage?.percentLabel === 'string' ? usage.percentLabel : null,
    creditsRequired: usage?.creditsRequired === true,
    label: usage?.creditsRequired ? 'Claude 추가 사용량 필요' : `Claude ${view.label}`,
    title: usage?.creditsRequired ? 'Claude를 계속 사용하려면 추가 사용량이 필요합니다.' : `Claude · ${view.title}`,
  };
}

const CLAUDE_KEY_ENV_NAMES = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

/**
 * SUB-15 confirmation (D-S4): an Anthropic key in EG-Desk's environment stops
 * Claude starts until the person chooses. `apiKeyEnv` is the
 * /engines/claude/api-key-env answer (variable names only, never values).
 * Confirm = run on the subscription with the key left out (the helper's
 * 'strip' policy, this helper run only); cancel = keep Claude stopped.
 */
export function claudeApiKeyEnvConfirm(engines, apiKeyEnv = null) {
  const { row } = activeProfile(engines, 'claude');
  const confirmed = apiKeyEnv?.confirmed === true;
  if (confirmed || row?.statusReason !== 'CLAUDE_API_KEY_DETECTED') return null;
  const names = (Array.isArray(apiKeyEnv?.detected) ? apiKeyEnv.detected : []).filter(name => CLAUDE_KEY_ENV_NAMES.includes(name));
  const which = names.length ? names.join(', ') : 'Anthropic API 키 변수';
  return {
    tone: 'warning', billingLabel: '종량제', names,
    title: 'Anthropic API 키가 설정되어 있습니다',
    lines: [
      `EG-Desk 환경에 ${which}가 있습니다. 이 키로 Claude를 실행하면 구독 한도가 아니라 쓴 만큼 요금이 붙는 종량제로 과금됩니다.`,
      'EG-Desk는 이 키를 claude에 넘기지 않습니다. 계속하면 키를 빼고 이 Mac의 Claude 구독 로그인으로만 실행합니다. 이 선택은 EG-Desk 연결 프로그램을 다시 켤 때까지 유지됩니다.',
      'EG-Desk는 API 키를 받거나 저장하지 않습니다.',
    ],
    confirmLabel: '키 빼고 구독으로 실행', cancelLabel: '실행하지 않음',
  };
}

// The two lines claude-engine-auth claudeLoginTerminalCommand() can return;
// nothing else from the bridge is ever typed into a shell.
const CLAUDE_LOGIN_LINES = Object.freeze({ claudeai: 'claude auth login --claudeai', console: 'claude auth login --console' });

/**
 * SUB-08 login button: asks the bridge for the login line
 * (GET /engines/claude/login-command), opens a Terminal card and types the
 * line + Enter there. The person finishes Anthropic's own login in that
 * terminal; the CLI keeps the credential and EG-Desk never sees it.
 * Injected: requestCommand(method) → bridge answer, openTerminal() → card,
 * terminalApi(card) → its terminalAPI or null, sleep(ms), now().
 * Returns { phase: 'started' | 'error', text }.
 */
export async function runClaudeLoginInTerminal({ requestCommand, openTerminal, terminalApi = card => card?._termBrowser?.contentWindow?.terminalAPI ?? null,
  sleep = null, now = Date.now, method = 'claudeai', timeoutMs = 15000, quietMs = 400, readyTimeoutMs = 8000, signinCardMs = 0,
  isCurrent = () => true,
  checkLine = command => Object.hasOwn(CLAUDE_LOGIN_LINES, method) && command?.method === method && command.line === CLAUDE_LOGIN_LINES[method] ? command.line : null,
  startedText = '터미널에서 Anthropic 공식 로그인을 마친 뒤 다시 확인을 눌러 주세요. EG-Desk는 로그인 정보를 보관하지 않습니다.' } = {}) {
  const changed = () => ({ phase: 'error', text: '로그인할 계정이나 연결 상태가 바뀌어 명령을 입력하지 않았습니다. 현재 계정에서 다시 눌러 주세요.' });
  if (!isCurrent()) return changed();
  let command;
  try { command = await requestCommand(method); } catch (error) {
    return { phase: 'error', text: `로그인 명령을 받지 못했습니다: ${text(error?.message) || '연결 프로그램 오류'}` };
  }
  let line;
  try { line = checkLine(command); } catch { line = null; }
  if (!line) return { phase: 'error', text: '연결 프로그램이 알 수 없는 로그인 명령을 보냈습니다. 터미널에 입력하지 않았습니다.' };
  if (!isCurrent()) return changed();
  let card;
  try { card = openTerminal(); } catch { card = null; }
  if (!card) return { phase: 'error', text: '터미널 카드를 열지 못했습니다.' };
  // Firefox system modules do not have a window-global setTimeout. The
  // Terminal's own chrome window supplies the timer while its PTY connects.
  const ownerWindow = card.ownerDocument?.defaultView;
  const wait = sleep || (typeof ownerWindow?.setTimeout === 'function' ? ms => new Promise(resolve => ownerWindow.setTimeout(resolve, ms)) : null);
  const started = now();
  let api = null;
  while (now() - started < timeoutMs) {
    if (!isCurrent()) return changed();
    try { api = terminalApi(card); } catch { api = null; }
    if (typeof api?.write === 'function' && api.isConnected?.() === true) break;
    api = null;
    if (card.isConnected === false || !wait) break;
    try { await wait(50); } catch { break; }
  }
  // c35 / u1: a line typed before the shell's line editor is up is echoed twice (by the tty, then again by the editor). c35 waited for 400 ms of silence after the first output; a real shell
  // proved that wrong: the first output is often a start-up file's warning (e.g. nvm's), followed by silence while the rest of the start-up runs, and the line went in too early.
  // The signal is the editor itself: it switches bracketed paste on when it starts reading a line (see shellReadyToType). Bounded by readyTimeoutMs; a terminal API that reports neither
  // output timing nor the editor is typed to at once, as before.
  if (api && (typeof api.outputIdleMs === 'function' || typeof api.lineEditorReady === 'function') && wait) {
    const readyStarted = now();
    while (now() - readyStarted < readyTimeoutMs) {
      if (!isCurrent()) return changed();
      let idle = null, editor = null;
      try { idle = api.outputIdleMs?.() ?? null; } catch { idle = null; }
      try { editor = api.lineEditorReady?.() ?? null; } catch { editor = null; }
      if (shellReadyToType({ idleMs: idle, editorReady: editor }, { quietMs })) break;
      if (card.isConnected === false) break;
      try { await wait(50); } catch { break; }
    }
  }
  if (!isCurrent()) return changed();
  if (!api) return { phase: 'error', text: `터미널 준비를 확인하지 못했습니다. 터미널에서 ${line} 을 직접 실행해 주세요.` };
  try { await api.write(`${line}\r`); } catch {
    return { phase: 'error', text: `터미널에 입력하지 못했습니다. 터미널에서 ${line} 을 직접 실행해 주세요.` };
  }
  // c36 (flag, capability terminal-open-url): the CLI opens its sign-in page within a second or two; when no Browser Card was opened for this terminal within `signinCardMs`, say so now
  // (the existing "terminal not ready" sentence: the line is to be run by hand) instead of leaving the person with nothing to do for minutes.
  if (signinCardMs > 0 && wait && typeof card._linkedSigninCount === 'function') {
    const typedAt = now();
    let opened = false;
    while (now() - typedAt < signinCardMs) {
      if (!isCurrent()) return changed();
      try { opened = card._linkedSigninCount() > 0; } catch { opened = false; }
      if (opened || card.isConnected === false) break;
      try { await wait(100); } catch { break; }
    }
    if (!opened) return { phase: 'error', text: `터미널 준비를 확인하지 못했습니다. 터미널에서 ${line} 을 직접 실행해 주세요.` };
  }
  return { phase: 'started', text: startedText };
}

// --- SUB-11 Engine Profiles (several ChatGPT / Claude accounts) ---
// Rows come from the /v1/state engines[] row (profiles[]). The shared login
// is the CLI's own (~/.claude, ~/.codex); an added profile has an EG-Desk-owned
// private login folder and logs in through the official CLI in a Terminal
// card. Switching is explicit and refused while a conversation runs; a chat
// keeps the profile it started with.
export const ENGINE_PROFILE_MARKERS = Object.freeze({ shared: '이 컴퓨터 로그인 공유', owned: 'EG-Desk 전용 로그인' });
const PROFILE_AUTH_TEXT = Object.freeze({ signedIn: '로그인됨', signedOut: '로그인 필요', signingIn: '로그인 중', unknown: '확인 안 됨' });
const PROFILE_ID = /^(codex|claude)-[a-z0-9]{1,40}$/;

/**
 * engineProfilesView(engines, engineId, { connected }) → { engineId, rows, canAdd, note }
 * rows: [{ id, label, marker, owned, active, status, authText, canActivate, canRemove, canLogin }]
 */
export const ENGINE_PROFILE_LABEL_ERROR = '계정 이름을 1~60자로 입력해 주세요.';
export function engineProfileLabel(value) {
  const label = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return label && label.length <= 60 && !/[\u0000-\u001f\u007f]/.test(label) ? label : null;
}

export function engineProfilesView(engines, engineId, { connected = false } = {}) {
  const name = ENGINE_NAMES[engineId] || engineId;
  const row = connected === true ? (Array.isArray(engines) ? engines : []).find(candidate => object(candidate) && candidate.id === engineId) : null;
  const seen = new Set();
  const rows = (Array.isArray(row?.profiles) ? row.profiles : []).filter(profile => object(profile) && PROFILE_ID.test(profile.id) && profile.id.startsWith(`${engineId}-`) && !seen.has(profile.id) && seen.add(profile.id))
    .map((profile) => {
      const owned = profile.owned === true;
      const notYet = profile.status === 'notYet';
      const active = profile.active === true;
      const isolatedCodex = engineId === 'codex' && owned;
      const auth = (active || isolatedCodex) && object(profile.auth) && Object.hasOwn(PROFILE_AUTH_TEXT, profile.auth.status) ? profile.auth.status : 'unknown';
      return {
        id: profile.id, owned, active,
        label: text(profile.label).slice(0, 60) || (owned ? `${name} 계정` : name),
        marker: owned ? ENGINE_PROFILE_MARKERS.owned : ENGINE_PROFILE_MARKERS.shared,
        status: notYet ? 'notYet' : active ? 'active' : 'available',
        authText: notYet ? '준비 중' : active ? '선택됨' : isolatedCodex ? PROFILE_AUTH_TEXT[auth] : '선택하면 이 로그인으로 새 대화를 시작합니다',
        canActivate: !active && !notYet && !isolatedCodex,
        canRemove: owned && !active,
        // The active Claude account already owns the bound login action on its card.
        canLogin: owned && !notYet && !(engineId === 'claude' && active),
      };
    });
  return {
    engineId, rows, canAdd: row?.profileAddAndLogin === true,
    addUnavailable: row && row.profileAddAndLogin !== true ? '지금은 이 엔진에 새 계정을 추가해 로그인할 수 없습니다.' : null,
    note: engineId === 'codex'
      ? '추가한 ChatGPT 계정은 Agent별로 선택할 수 있습니다. 이 컴퓨터의 기본 로그인은 바뀌지 않습니다.'
      : '계정을 바꾸면 새 대화부터 적용됩니다. 진행 중인 대화는 시작한 계정에서 끝나고, 다른 계정으로 옮겨지지 않습니다.',
  };
}

const CLAUDE_PROFILE_LOGIN_LINE = /^CLAUDE_CONFIG_DIR='(\/[^'\r\n\0]{1,4000})' claude auth login --(?:claudeai|console)$/;
const CODEX_PROFILE_LOGIN_LINE = /^env -i HOME="\$HOME" PATH="\$PATH" CODEX_HOME='(\/[^'\r\n\0]{1,4000})' codex -c cli_auth_credentials_store=file login$/;
/** The login command must match both the allowlist and the requested account. */
export function engineProfileLoginLine(command, { engineId, profileId } = {}) {
  const line = typeof command?.line === 'string' ? command.line : '';
  if (engineId && command?.engine !== engineId || profileId && command?.profileId !== profileId) return null;
  if (Object.values(CLAUDE_LOGIN_LINES).includes(line)) return !profileId || profileId === 'claude-default' ? line : null;
  if (line === 'codex login') return !profileId || profileId === 'codex-default' ? line : null;
  const codexHome = CODEX_PROFILE_LOGIN_LINE.exec(line)?.[1];
  if (codexHome) {
    if (engineId !== 'codex' || !/^codex-[a-z0-9]{8,32}$/.test(profileId) || command.env !== 'CODEX_HOME') return null;
    return codexHome.endsWith('/engines/' + profileId) ? line : null;
  }
  const claudeHome = CLAUDE_PROFILE_LOGIN_LINE.exec(line)?.[1];
  if (!claudeHome || command.env !== 'CLAUDE_CONFIG_DIR' || command.engine !== 'claude') return null;
  return !profileId || claudeHome.endsWith('/engines/' + profileId) ? line : null;
}

/** Types an Engine Profile's login line into a Terminal card (official CLI login for that folder). */
export function runEngineProfileLoginInTerminal({ requestCommand, engineId, profileId, method = 'claudeai', ...options } = {}) {
  return runClaudeLoginInTerminal({ ...options, method, requestCommand, checkLine: command => {
    const line = engineProfileLoginLine(command, { engineId, profileId });
    return line && (engineId !== 'claude' || Object.hasOwn(CLAUDE_LOGIN_LINES, method) && line.endsWith(CLAUDE_LOGIN_LINES[method])) ? line : null;
  },
    startedText: '터미널에서 공식 로그인을 마친 뒤 다시 확인을 눌러 주세요. 로그인 정보는 이 계정 전용 폴더에만 저장되고 EG-Desk는 읽지 않습니다.' });
}

/** Korean text for a refused profile change (bridge error codes). */
export function engineProfileErrorText(error) {
  const code = text(error?.code);
  return {
    ENGINE_PROFILE_BUSY: '진행 중인 대화가 있어 계정을 바꾸지 않았습니다. 끝난 뒤 다시 선택해 주세요.',
    ENGINE_PROFILE_NOT_YET: '지금은 이 엔진에 새 계정을 추가해 로그인할 수 없습니다.',
    ENGINE_PROFILE_ACTIVE: '사용 중인 계정은 지울 수 없습니다. 다른 계정을 먼저 선택해 주세요.',
    ENGINE_PROFILE_DEFAULT: '이 컴퓨터 로그인은 지울 수 없습니다.',
    ENGINE_PROFILE_IN_USE: '이 계정으로 진행 중인 대화가 있어 지우지 않았습니다.',
    ENGINE_PROFILE_LIMIT: '이 엔진에는 계정을 더 추가할 수 없습니다.',
    INVALID_PROFILE_LABEL: ENGINE_PROFILE_LABEL_ERROR,
    ENGINE_PROFILES_UNAVAILABLE: '이 컴퓨터에 계정 설정을 저장할 수 없습니다.',
  }[code] || `계정 설정을 바꾸지 못했습니다: ${text(error?.message) || '연결 프로그램 오류'}`;
}


// --- 결정 모델 · OpenAI Decisions (DECISION_MODEL_CONTEXT_SETUP.md) ---------
// A section of its own, apart from the engine cards: the key for the decision
// model, its verification result and the mode. The key is typed into a
// password field the screen clears right after POST /decision/credential;
// only the bridge's hint (…끝 4자) is ever shown.
export const DECISION_SECTION_TITLE = '결정 모델 · OpenAI Decisions';
export const DECISION_MODES = Object.freeze([
  Object.freeze({ value: 'off', label: '끔', note: '자동 선별에 OpenAI Decisions를 사용하지 않습니다.' }),
  Object.freeze({ value: 'advisory', label: '기록만', note: '지원되는 요청에서 메시지와 후보 설명을 OpenAI에 보낼 수 있습니다. API 비용이 들 수 있으며, 결과는 해당 실행의 활동 기록에만 남기고 답변 입력에는 붙이지 않습니다.' }),
  Object.freeze({ value: 'on', label: '사용', note: '지원되는 요청에서 메시지와 후보 설명을 OpenAI에 보낼 수 있습니다. API 비용이 들 수 있으며, 선별에 성공하면 허용된 선택 자료를 답변 입력에 붙입니다. Codex DM의 이전 대화 원문을 주제 선별에 보내려면 그 DM의 기억 근거에서 별도로 허용해야 합니다.' }),
]);
export const DECISION_CREDIT_NOTE = 'ChatGPT Pro·Business 요금제의 API 크레딧은 연결한 API 조직의 project key에만 적용됩니다. Plus는 대상이 아닙니다.';
const DECISION_VERIFICATION_TEXT = Object.freeze({
  verified: '확인됨',
  no_credit: '크레딧 없음 · 키는 저장했습니다. 크레딧이 생기면 바로 쓸 수 있습니다.',
  spend_limit_reached: '지출·사용 한도에 도달 · 키는 저장했습니다. OpenAI에서 한도를 올리거나 다음 달 초기화 뒤에 쓸 수 있습니다.',
  rate_limited: '요청 한도에 걸림 · 키는 저장했습니다. 잠시 뒤 다시 시도하세요.',
  invalid_key: '키가 올바르지 않습니다',
  not_verified: 'OpenAI가 키 확인 질문에 통과시키지 않았습니다',
  server_error: 'OpenAI 서버 오류입니다. 잠시 뒤 다시 시도하세요',
  bad_response: 'OpenAI의 답을 해석하지 못했습니다',
  budget_exceeded: '이번 달 로컬 사용 한도에 도달해 확인하지 못했습니다',
  model_unavailable: '이 키로는 결정 모델(gpt-6-luna)을 쓸 수 없습니다',
  unreachable: 'OpenAI에 연결하지 못했습니다',
  timeout: 'OpenAI가 제때 답하지 않았습니다',
});

// Why a new key was not swapped in while a saved key exists (it could be saved on its own).
const DECISION_NOT_REPLACED_TEXT = Object.freeze({
  no_credit: '새 키에 크레딧이 없습니다',
  spend_limit_reached: '새 키가 지출·사용 한도에 막혀 있습니다',
  rate_limited: '새 키가 요청 한도에 걸렸습니다',
});

/** Korean line for a /decision/credential verification status. */
export function decisionVerificationText(status) {
  return DECISION_VERIFICATION_TEXT[status] || DECISION_VERIFICATION_TEXT.unreachable;
}

/**
 * decisionSettingsView(status, { connected }) → what the section shows.
 * status: GET /decision/status (or null while unknown).
 */
export function decisionSettingsView(status, { connected = false } = {}) {
  const known = connected && object(status);
  const configured = known && status.configured === true;
  const mode = known && DECISION_MODES.some(choice => choice.value === status.mode) ? status.mode : null;
  const storeBroken = known && ['unreadable', 'unsupported', 'unavailable'].includes(status.store);
  const hint = configured && typeof status.keyHint === 'string' ? status.keyHint : null;
  const budget = known && object(status.budget) && Number.isSafeInteger(status.budget.inputTokens) ? status.budget : null;
  return {
    scopeNote: '일반 대화나 Board에서 일부 자동 선별에 쓰는 별도 API입니다. 이 설정과 관계없이 자료를 직접 고르거나 로컬 기록을 볼 수 있습니다.',
    invocationNote: '저장된 모드와 키는 실행 기록이 아닙니다. 실제 선별 기록이 있으면 해당 실행의 활동 기록에서 볼 수 있습니다.',
    keyActionNote: '확인 후 저장을 누르면 키 확인을 위해 OpenAI에 요청을 보냅니다.',
    status: !known ? 'unknown' : configured ? 'configured' : 'empty',
    keyLine: !known ? '확인할 수 없음 · 브리지 연결이 준비되면 다시 확인합니다.'
      : configured ? `저장된 키 ${hint || ''}`.trim() : '저장된 키 없음',
    storeNote: storeBroken ? '이 컴퓨터에서는 키를 저장할 수 없습니다.' : null,
    canSave: known && !storeBroken,
    canDelete: configured,
    mode,
    // Without a key only '끔' applies; the choice is kept for when one is saved.
    modeEnabled: known && status.mode !== null && status.mode !== undefined,
    modes: DECISION_MODES.map(choice => ({ ...choice, selected: choice.value === mode })),
    modeNote: !mode ? '저장된 모드를 확인할 수 없습니다.' : DECISION_MODES.find(choice => choice.value === mode).note
      + (mode !== 'off' && !configured ? ' 저장된 키가 없어 지금은 요청하지 않습니다.'
        : mode !== 'off' && budget?.cap != null && budget.inputTokens + (Number.isSafeInteger(budget.estimatedInputTokens) ? budget.estimatedInputTokens : 0) >= budget.cap ? ' 이번 달 설정한 한도에 도달해 새 선별 요청을 보내지 않습니다.' : ''),
    budgetLine: budget ? `이번 달 집계된 입력 ${budget.inputTokens.toLocaleString('en-US')} 토큰${budget.estimatedInputTokens > 0 ? ` + 응답 없이 보낸 요청 ${budget.unmeteredRequests}건 추정 ${budget.estimatedInputTokens.toLocaleString('en-US')}` : ''}${Number.isSafeInteger(budget.cap) ? ` / 상한 ${budget.cap.toLocaleString('en-US')}` : ''}` : null,
    creditNote: DECISION_CREDIT_NOTE,
  };
}

/**
 * decisionCredentialOutcome({ result?, error? }) → { phase: 'done'|'error', text }
 * result: the 200 answer of POST /decision/credential; error: a failed request
 * ({ status, code, verification }).
 */
export function decisionCredentialOutcome({ result = null, error = null } = {}) {
  if (result && !error) {
    const verification = typeof result.verification === 'string' ? result.verification : 'verified';
    // A key alone does nothing while the mode is 끔: say so next to the switch the person has to use.
    const base = decisionVerificationText(verification);
    const modeHint = result.mode === 'off' ? `${/[.。]$/.test(base) ? ' ' : ' · '}모드가 ‘끔’이라 아직 쓰이지 않습니다. 아래에서 ‘사용’을 고르면 쓸 수 있습니다.` : '';
    return { phase: verification === 'verified' ? 'done' : 'warning', verification, text: base + modeHint };
  }
  if (error?.code === 'DECISION_KEY_NOT_REPLACED') {
    const verification = typeof error.verification === 'string' ? error.verification : 'unreachable';
    const why = DECISION_NOT_REPLACED_TEXT[verification] || decisionVerificationText(verification);
    return { phase: 'error', verification, text: `${why} · 새 키로 바꾸지 않았습니다. 지금 쓰는 키는 그대로입니다. 기존 키를 지운 뒤에는 이 키도 저장할 수 있습니다.` };
  }
  if (error?.code === 'DECISION_KEY_REJECTED') {
    const verification = typeof error.verification === 'string' ? error.verification : 'unreachable';
    return { phase: 'error', verification, text: `${decisionVerificationText(verification)} · 키를 저장하지 않았습니다.` };
  }
  if (error?.code === 'DECISION_KEY_INVALID') return { phase: 'error', verification: null, text: 'API 키 형식이 아닙니다. sk-로 시작하는 키를 붙여 넣어 주세요.' };
  if (error?.code === 'DECISION_STORE_UNAVAILABLE' || error?.code === 'DECISION_STORE_FAILED') return { phase: 'error', verification: null, text: '이 컴퓨터에서 키를 저장하지 못했습니다.' };
  return { phase: 'error', verification: null, text: '브리지에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
}

// c36 (flag): after the login line was typed the Claude section waits visibly and the screen checks the engine itself, so a successful sign-in shows at once and a login that ended without
// success shows an error at once. watchClaudeLogin polls `refresh()` every pollMs (the bridge coalesces checks), for at most boundMs:
//   'signedIn' (isSignedIn() true), 'ended' (sessionEnded() true and not signed in: the terminal's session exited or lost its connection), 'changed' (isCurrent() false), 'timeout' (the bound).
// The words of 'ended' are the existing error form (no new copy); a better sentence is a proposal in the report.
export const CLAUDE_LOGIN_WATCH = Object.freeze({ pollMs: 3000, boundMs: 300_000, terminalReadyMs: 5000, signinCardMs: 10_000 });
export const CLAUDE_LOGIN_ENDED_TEXT = 'Claude 상태를 바꾸지 못했습니다: 연결 프로그램 오류';
export async function watchClaudeLogin({ refresh, isSignedIn, sessionEnded, isCurrent = () => true, wait, now = Date.now, pollMs = CLAUDE_LOGIN_WATCH.pollMs, boundMs = CLAUDE_LOGIN_WATCH.boundMs } = {}) {
  const started = now();
  while (now() - started < boundMs) {
    try { await refresh(); } catch { /* a failed check is tried again at the next poll */ }
    // u1: signed in is checked first: once the login worked, the Settings row no longer offers a login (isCurrent turns false) and that is not "the account changed"
    let signed = false;
    try { signed = isSignedIn() === true; } catch { signed = false; }
    if (signed) return 'signedIn';
    if (!isCurrent()) return 'changed';
    let ended = false;
    try { ended = sessionEnded() === true; } catch { ended = false; }
    if (ended) return 'ended';
    try { await wait(pollMs); } catch { return 'changed'; }
  }
  return 'timeout';
}

// u1: may a login line be typed now? `editorReady` is the terminal's report of the shell's line editor (true while it reads a line; false before; null when unknown), `idleMs` the time since
// the shell last printed (null: nothing yet).
//  - editor up (true): yes, once the prompt has settled (PROMPT_SETTLE_MS) - the exact moment, however long the start-up files took.
//  - editor not up (false): the shell may be a slow start-up (wait on) or a shell without bracketed paste (bash 3.2: the editor never reports); only a long silence (NO_EDITOR_IDLE_MS) says it is
//    at its prompt. A start-up silent for longer than that is typed into early, as c35 did for every shell; the caller's bound ends the wait.
//  - unknown (null): c35's rule: some output, then `quietMs` of silence.
export const PROMPT_SETTLE_MS = 120;
export const NO_EDITOR_IDLE_MS = 2500;
export function shellReadyToType({ idleMs = null, editorReady = null } = {}, { quietMs = 400, settleMs = PROMPT_SETTLE_MS, noEditorIdleMs = NO_EDITOR_IDLE_MS } = {}) {
  if (editorReady === true) return idleMs === null || idleMs >= settleMs;
  if (editorReady === false) return idleMs !== null && idleMs >= noEditorIdleMs;
  return idleMs !== null && idleMs >= quietMs;
}
