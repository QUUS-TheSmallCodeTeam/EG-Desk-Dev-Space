// Settings '계정' tab view models (SUB-05, SUB-01): bridge snapshots in, rows
// and confirmation copy out. Pure: no request, no DOM, no credential. The
// screen keeps every actual call (bridge().signOut(), startLogin(),
// refreshAuthStatus(), reconnectNow()) and asks here only what to show.
//
// Sources of truth: /v1/state auth (ChatGPT account, SUB-03), /v1/state
// engines[] rows with profiles[].auth from claude-engine-auth (SUB-08), the
// bridge connection notice (RT-05) and the chat protocol runs (SUB-02). A
// value the bridge did not report reads '확인 안 됨', never a guess.
import { isRunBusy, runsForThread, requestBelongsToThread } from './EGDeskChatState.sys.mjs';

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
  const base = { methodLabel: null, method: null, account: null, planType: null, hint: null };
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
    };
  }
  if (auth?.status === 'signedOut') {
    return { ...base, status: 'signedOut', title: '로그인되어 있지 않습니다', sub: 'Claude 구독이나 API 키로 로그인하면 Claude 엔진을 쓸 수 있습니다.', hint: CLAUDE_LOGIN_HINT, action: 'refresh' };
  }
  return { ...base, status: 'unknown', title: '로그인 상태 확인 안 됨', sub: 'claude 명령이 예상한 형식으로 답하지 않았습니다. 다시 확인하거나 Terminal에서 claude auth status 를 실행해 보세요.', action: 'refresh' };
}
