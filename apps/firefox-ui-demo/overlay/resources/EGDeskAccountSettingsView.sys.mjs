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
  claudeai: '구독 · Anthropic 공식 로그인',
  apiKey: 'Anthropic API 키 · 사용량 과금',
  gateway: '사용자 지정 게이트웨이',
  external: '외부 클라우드 제공자',
});
const CLAUDE_LOGIN_HINT = 'Terminal에서 claude auth login 을 실행해 Anthropic 공식 로그인을 마친 뒤 다시 확인해 주세요. EG-Desk는 로그인 정보를 보관하지 않습니다.';

/**
 * The Claude account card from the bridge's engines[] row (profiles[].auth is
 * the allow-listed `claude auth status` answer). status: 'disconnected' (no
 * bridge) | 'noReport' | 'notInstalled' | 'signedIn' | 'signedOut' | 'unknown'.
 */
export function claudeAccountView(engines, { connected = false } = {}) {
  const base = { methodLabel: null, method: null, account: null, planType: null, hint: null, billingLabel: null };
  if (connected !== true) {
    return { ...base, status: 'disconnected', title: '연결 안 됨', sub: 'EG-Desk 연결 프로그램에 닿지 않아 Claude 로그인 상태를 확인할 수 없습니다.', action: null };
  }
  const rows = (Array.isArray(engines) ? engines : []).filter(row => object(row) && row.id === 'claude');
  const row = rows.length === 1 ? rows[0] : null;
  if (!row) return { ...base, status: 'noReport', title: 'Claude 보고 없음', sub: '연결 프로그램이 아직 Claude 엔진 상태를 보고하지 않았습니다.', action: 'refresh' };
  if (row.installed === false || row.status === 'notInstalled') {
    return { ...base, status: 'notInstalled', title: 'Claude CLI가 설치되어 있지 않습니다', sub: '이 Mac에 claude 명령을 설치하고 로그인하면 여기에 계정이 보입니다.', action: 'refresh' };
  }
  const profiles = (Array.isArray(row.profiles) ? row.profiles : []).filter(profile => object(profile) && profile.active === true);
  const profile = profiles.length === 1 ? profiles[0] : null;
  const auth = object(profile?.auth) ? profile.auth : null;
  if (auth?.status === 'signedIn') {
    const method = Object.hasOwn(CLAUDE_METHOD_LABELS, auth.method) ? auth.method : null;
    const account = publicEmail(auth.account);
    const label = text(profile.label).slice(0, 80) || 'Claude';
    return {
      status: 'signedIn', title: label, method, account, hint: null, action: 'refresh',
      sub: account || (method === 'claudeai' ? '계정 이메일 확인 안 됨' : '로그인됨'),
      methodLabel: method ? CLAUDE_METHOD_LABELS[method] : '로그인 방식 확인 안 됨',
      planType: method === 'claudeai' && text(auth.planType) ? text(auth.planType).slice(0, 40) : null,
      billingLabel: engineBillingLabel(auth),
    };
  }
  if (auth?.status === 'signedOut') {
    return { ...base, status: 'signedOut', title: '로그인되어 있지 않습니다', sub: 'Claude 구독이나 API 키로 로그인하면 Claude 엔진을 쓸 수 있습니다.', hint: CLAUDE_LOGIN_HINT, action: 'refresh', login: true };
  }
  return { ...base, status: 'unknown', title: '로그인 상태 확인 안 됨', sub: 'claude 명령이 예상한 형식으로 답하지 않았습니다. 다시 확인하거나 Terminal에서 claude auth status 를 실행해 보세요.', action: 'refresh' };
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

/**
 * SUB-13 version badge from the bridge's versionStatus (engine-registry,
 * egdesk-native-capabilities policy). 'supported' and unknown show nothing;
 * the badge explains, it never blocks (D-S6: the Codex connection stays as it is).
 */
export function engineVersionBadge(engines, engineId) {
  if (!Object.hasOwn(ENGINE_NAMES, engineId)) return null;
  const { row } = activeProfile(engines, engineId);
  if (!row || row.installed === false) return null;
  const version = typeof row.version === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(row.version) ? row.version : null;
  const name = ENGINE_NAMES[engineId];
  const which = version ? `${name} ${version}` : `이 ${name}`;
  if (row.versionStatus === 'unsupported') {
    return { engineId, status: 'unsupported', tone: 'danger', label: '지원 버전 아님', version,
      title: `${which}은(는) EG-Desk가 지원하는 최소 버전보다 낮습니다. 대화가 실패할 수 있으니 ${name}를 업데이트해 주세요.` };
  }
  if (row.versionStatus === 'untested') {
    return { engineId, status: 'untested', tone: 'warning', label: '확인 안 된 버전', version,
      title: `${which}은(는) EG-Desk에서 아직 확인하지 않은 버전입니다. 대화는 계속되지만 일부 표시가 다를 수 있습니다.` };
  }
  return null;
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
    label: `Claude ${view.label}`, title: `Claude · ${view.title}`,
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
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, method = 'claudeai', timeoutMs = 15000,
  checkLine = command => Object.hasOwn(CLAUDE_LOGIN_LINES, command?.method) && command?.line === CLAUDE_LOGIN_LINES[command.method] ? command.line : null,
  startedText = '터미널에서 Anthropic 공식 로그인을 마친 뒤 다시 확인을 눌러 주세요. EG-Desk는 로그인 정보를 보관하지 않습니다.' } = {}) {
  let command;
  try { command = await requestCommand(method); } catch (error) {
    return { phase: 'error', text: `로그인 명령을 받지 못했습니다: ${text(error?.message) || '연결 프로그램 오류'}` };
  }
  let line;
  try { line = checkLine(command); } catch { line = null; }
  if (!line) return { phase: 'error', text: '연결 프로그램이 알 수 없는 로그인 명령을 보냈습니다. 터미널에 입력하지 않았습니다.' };
  let card;
  try { card = openTerminal(); } catch { card = null; }
  if (!card) return { phase: 'error', text: '터미널 카드를 열지 못했습니다.' };
  const started = now();
  let api = null;
  while (now() - started < timeoutMs) {
    try { api = terminalApi(card); } catch { api = null; }
    if (typeof api?.write === 'function' && api.isConnected?.() === true) break;
    api = null;
    if (card.isConnected === false) break;
    await sleep(50);
  }
  if (!api) return { phase: 'error', text: `터미널 준비를 확인하지 못했습니다. 터미널에서 ${line} 을 직접 실행해 주세요.` };
  try { await api.write(`${line}\r`); } catch {
    return { phase: 'error', text: `터미널에 입력하지 못했습니다. 터미널에서 ${line} 을 직접 실행해 주세요.` };
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
export function engineProfilesView(engines, engineId, { connected = false } = {}) {
  const name = ENGINE_NAMES[engineId] || engineId;
  const row = connected === true ? (Array.isArray(engines) ? engines : []).find(candidate => object(candidate) && candidate.id === engineId) : null;
  const seen = new Set();
  const rows = (Array.isArray(row?.profiles) ? row.profiles : []).filter(profile => object(profile) && PROFILE_ID.test(profile.id) && profile.id.startsWith(`${engineId}-`) && !seen.has(profile.id) && seen.add(profile.id))
    .map((profile) => {
      const owned = profile.owned === true;
      const notYet = profile.status === 'notYet';
      const active = profile.active === true;
      const auth = active && object(profile.auth) && Object.hasOwn(PROFILE_AUTH_TEXT, profile.auth.status) ? profile.auth.status : 'unknown';
      return {
        id: profile.id, owned, active,
        label: text(profile.label).slice(0, 60) || (owned ? `${name} 계정` : name),
        marker: owned ? ENGINE_PROFILE_MARKERS.owned : ENGINE_PROFILE_MARKERS.shared,
        status: notYet ? 'notYet' : active ? 'active' : 'available',
        authText: notYet ? '준비 중' : active ? `사용 중 · ${PROFILE_AUTH_TEXT[auth]}` : '선택하면 이 로그인으로 새 대화를 시작합니다',
        canActivate: !active && !notYet,
        canRemove: owned && !active,
        canLogin: owned,
      };
    });
  return {
    engineId, rows, canAdd: connected === true && Boolean(row),
    note: engineId === 'codex'
      ? '추가한 ChatGPT 계정은 로그인 폴더만 준비됩니다. 계정별 Codex 실행은 아직 지원하지 않습니다.'
      : '계정을 바꾸면 새 대화부터 적용됩니다. 진행 중인 대화는 시작한 계정에서 끝나고, 다른 계정으로 옮겨지지 않습니다.',
  };
}

const PROFILE_LOGIN_LINE = /^(?:CLAUDE_CONFIG_DIR|CODEX_HOME)='\/[^'\r\n\0]{1,4000}' (?:claude auth login --(?:claudeai|console)|codex login)$/;
/** The login line for an Engine Profile as the bridge sent it, or null if it is not one EG-Desk makes. */
export function engineProfileLoginLine(command) {
  const line = typeof command?.line === 'string' ? command.line : '';
  if (Object.values(CLAUDE_LOGIN_LINES).includes(line) || line === 'codex login') return line;
  if (!PROFILE_LOGIN_LINE.test(line)) return null;
  const envName = line.startsWith('CLAUDE_CONFIG_DIR=') ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const engine = envName === 'CLAUDE_CONFIG_DIR' ? 'claude' : 'codex';
  if (command.env !== envName || command.engine !== engine || !line.includes(engine === 'claude' ? ' claude auth login' : ' codex login')) return null;
  return line;
}

/** Types an Engine Profile's login line into a Terminal card (official CLI login for that folder). */
export function runEngineProfileLoginInTerminal({ requestCommand, ...options } = {}) {
  return runClaudeLoginInTerminal({ ...options, requestCommand, checkLine: engineProfileLoginLine,
    startedText: '터미널에서 공식 로그인을 마친 뒤 다시 확인을 눌러 주세요. 로그인 정보는 이 계정 전용 폴더에만 저장되고 EG-Desk는 읽지 않습니다.' });
}

/** Korean text for a refused profile change (bridge error codes). */
export function engineProfileErrorText(error) {
  const code = text(error?.code);
  return {
    ENGINE_PROFILE_BUSY: '진행 중인 대화가 있어 계정을 바꾸지 않았습니다. 끝난 뒤 다시 선택해 주세요.',
    ENGINE_PROFILE_NOT_YET: 'Codex는 아직 계정을 하나만 쓸 수 있습니다.',
    ENGINE_PROFILE_ACTIVE: '사용 중인 계정은 지울 수 없습니다. 다른 계정을 먼저 선택해 주세요.',
    ENGINE_PROFILE_DEFAULT: '이 컴퓨터 로그인은 지울 수 없습니다.',
    ENGINE_PROFILE_IN_USE: '이 계정으로 진행 중인 대화가 있어 지우지 않았습니다.',
    ENGINE_PROFILE_LIMIT: '이 엔진에는 계정을 더 추가할 수 없습니다.',
    INVALID_PROFILE_LABEL: '이름은 1~60자로 적어 주세요.',
    ENGINE_PROFILES_UNAVAILABLE: '이 컴퓨터에 계정 설정을 저장할 수 없습니다.',
  }[code] || `계정 설정을 바꾸지 못했습니다: ${text(error?.message) || '연결 프로그램 오류'}`;
}

