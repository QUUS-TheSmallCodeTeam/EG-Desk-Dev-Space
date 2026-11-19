import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as View from '../overlay/resources/EGDeskAccountSettingsView.sys.mjs';
import { createChatProtocolState } from '../overlay/resources/EGDeskChatState.sys.mjs';
import { describeClaudeEngine, publicEngineRow } from '../helper/engine-registry.mjs';
import { claudeAuthFromCliStatus } from '../helper/claude-engine-auth.mjs';
import { readSurfaceSource } from './egdesk-surface-source.mjs';

// Settings '계정' tab (SUB-05) and its account menu (SUB-01): the bridge's
// snapshots become rows, and a sign-out or switch is confirmed first. Nothing
// here contacts a bridge, a CLI or a provider.

test('connection: first contact and quiet reconnects read 확인 중, exhausted reconnects read 연결 끊김', () => {
  assert.equal(View.settingsConnectionView({ connected: true, bridgeState: 'online' }).state, 'online');
  assert.equal(View.settingsConnectionView({ connected: true, bridgeState: 'mismatch' }).state, 'online', 'a build mismatch still has a live account answer');
  const first = View.settingsConnectionView({ connected: false, bridgeState: 'reconnecting' });
  assert.equal(first.state, 'checking');
  assert.equal(first.title, '연결 확인 중…');
  assert.equal(first.action, null);
  assert.equal(View.settingsConnectionView({}).state, 'checking', 'before any answer the card does not say the bridge is gone');
  const gone = View.settingsConnectionView({ connected: false, bridgeState: 'offline' });
  assert.equal(gone.state, 'offline');
  assert.equal(gone.title, '연결이 끊겼습니다');
  assert.equal(gone.action, 'reconnect');
  assert.equal(gone.actionLabel, '다시 연결');
  assert.match(gone.sub, /표시하지 않습니다/, 'a stale account is never presented as current');
});

test('account menu exists only for a signed-in ChatGPT account', () => {
  assert.deepEqual(View.accountMenuItems({ isLoggedIn: false }), []);
  assert.deepEqual(View.accountMenuItems(null), []);
  assert.deepEqual(View.accountMenuItems({ isLoggedIn: true }).map(item => item.id), ['refresh', 'switch', 'signout']);
  assert.equal(View.accountMenuItems({ isLoggedIn: true }).find(item => item.id === 'signout').tone, 'danger');
});

test('busy runs are counted per Chat room from the protocol runs and unconfirmed sends', () => {
  const protocol = createChatProtocolState();
  protocol.runs['c1/r1'] = { conversationId: 'c1', runId: 'r1', status: 'running', localThreadId: 't1' };
  protocol.runs['c1/r0'] = { conversationId: 'c1', runId: 'r0', status: 'completed', localThreadId: 't1' };
  protocol.runs['c2/r2'] = { conversationId: 'c2', runId: 'r2', status: 'queued', localThreadId: 't2' };
  protocol.requests.q1 = { requestId: 'q1', localThreadId: 't3', status: 'submitting' };
  protocol.requests.q2 = { requestId: 'q2', localThreadId: 't3', status: 'failed' };
  const threads = [
    { id: 't1', title: '배포 점검', conversationId: 'c1' },
    { id: 't2', title: '', conversationId: 'c2' },
    { id: 't3', title: '문서 정리' },
    { id: 't4', title: '쉬는 방' },
  ];
  const busy = View.busyRunSummary({ threads, protocol });
  assert.equal(busy.count, 3);
  assert.deepEqual(busy.threads, [
    { id: 't1', title: '배포 점검', count: 1 },
    { id: 't2', title: '제목 없는 대화', count: 1 },
    { id: 't3', title: '문서 정리', count: 1 },
  ]);
  assert.deepEqual(View.busyRunSummary({ threads, protocol: null }), { count: 0, threads: [] });
  assert.deepEqual(View.busyRunSummary(), { count: 0, threads: [] });
});

test('sign-out confirmation names the account, the shared terminal login and the running work', () => {
  const idle = View.accountActionConfirm('signout', { email: 'me@example.com', busy: { count: 0, threads: [] } });
  assert.equal(idle.title, 'me@example.com 계정에서 로그아웃할까요?');
  assert.equal(idle.tone, 'warning');
  assert.equal(idle.busyCount, 0);
  assert.equal(idle.confirmLabel, '로그아웃');
  assert.equal(idle.cancelLabel, '취소');
  assert.match(idle.lines[0], /터미널의 codex/);
  assert.equal(idle.lines[1], '진행 중인 실행은 없습니다.');

  const busy = View.accountActionConfirm('signout', { email: null, busy: { count: 5, threads: [
    { id: 'a', title: '하나', count: 1 }, { id: 'b', title: '둘', count: 2 }, { id: 'c', title: '셋', count: 1 }, { id: 'd', title: '넷', count: 1 }] } });
  assert.equal(busy.title, '지금 계정에서 로그아웃할까요?');
  assert.equal(busy.tone, 'danger');
  assert.equal(busy.busyCount, 5);
  assert.equal(busy.confirmLabel, '그래도 로그아웃');
  assert.match(busy.lines[1], /^진행 중인 실행 5개가 중단될 수 있습니다 \('하나', '둘', '셋' 외 1개 대화방\)\./);

  assert.equal(View.accountActionConfirm('signout', { email: 'not an email' }).title, '지금 계정에서 로그아웃할까요?');
  assert.equal(View.accountActionConfirm('delete'), null);
});

test('switch confirmation says the sign-out comes first and running work is not carried over', () => {
  const view = View.accountActionConfirm('switch', { email: 'me@example.com', busy: { count: 1, threads: [{ id: 'a', title: '하나', count: 1 }] } });
  assert.equal(view.title, '다른 계정으로 로그인할까요?');
  assert.match(view.lines[0], /^me@example\.com 계정에서 먼저 로그아웃한 뒤 ChatGPT 로그인 창을 엽니다\./);
  assert.match(view.lines[1], /진행 중인 실행 1개/);
  assert.match(view.lines[2], /새 계정으로 옮기지 않습니다/);
  assert.equal(view.confirmLabel, '그래도 로그아웃 후 로그인');
  assert.equal(View.accountActionConfirm('switch', {}).confirmLabel, '로그아웃 후 로그인');
});

test('outcome reads the auth state back: signed out, login started, still signed in, or the request error', () => {
  assert.deepEqual(View.accountActionOutcome('signout', { isLoggedIn: false }), { action: 'signout', phase: 'signedOut', text: '로그아웃했습니다. 터미널의 codex도 다시 로그인해야 합니다.' });
  assert.equal(View.accountActionOutcome('signout', { isLoggedIn: true }).phase, 'unknown');
  assert.equal(View.accountActionOutcome('signout', null).phase, 'unknown');
  const failed = View.accountActionOutcome('signout', { isLoggedIn: true }, { error: 'HTTP 500' });
  assert.equal(failed.phase, 'error');
  assert.equal(failed.text, '로그아웃하지 못했습니다: HTTP 500');
  assert.equal(View.accountActionOutcome('switch', { isLoggedIn: false }, { error: 'HTTP 500' }).text, '계정을 바꾸지 못했습니다: HTTP 500');
  assert.equal(View.accountActionOutcome('switch', { isLoggedIn: false, loginInProgress: true }).phase, 'loginStarted');
  assert.equal(View.accountActionOutcome('switch', { isLoggedIn: false }, { loginStarted: true }).phase, 'loginStarted');
  const notStarted = View.accountActionOutcome('switch', { isLoggedIn: false, loginInProgress: false });
  assert.equal(notStarted.phase, 'signedOut');
  assert.match(notStarted.text, /로그인 버튼으로 다시 시작/);
  assert.equal(View.accountActionOutcome('other', { isLoggedIn: false }), null);
});

const claudeRow = (auth, extra = {}) => publicEngineRow(describeClaudeEngine({ version: '2.1.300', versionStatus: 'untested', installed: true, auth, ...extra }, { minVersion: '2.1.205' }));

test('Claude card shows the CLI-reported subscription, API key or signed-out state, never a guess', () => {
  const max = View.claudeAccountView([claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com', subscriptionType: 'max' })))], { connected: true });
  assert.equal(max.status, 'signedIn');
  assert.equal(max.title, 'Claude Max');
  assert.equal(max.sub, 'me@example.com');
  assert.equal(max.account, 'me@example.com');
  assert.equal(max.method, 'claudeai');
  assert.equal(max.methodLabel, 'Claude 구독');
  assert.equal(max.planType, 'max');
  assert.equal(max.action, 'refresh');
  assert.equal(max.hint, null);

  const noEmail = View.claudeAccountView([claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', subscriptionType: 'pro' })))], { connected: true });
  assert.equal(noEmail.sub, '로그인됨');

  const apiKey = View.claudeAccountView([claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' })))], { connected: true });
  assert.equal(apiKey.status, 'signedIn');
  assert.equal(apiKey.title, 'Anthropic API key');
  assert.equal(apiKey.method, 'apiKey');
  assert.equal(apiKey.methodLabel, 'Anthropic API 키');
  assert.equal(apiKey.billingLabel, '종량 과금');
  assert.equal(apiKey.planType, null);
  assert.equal(apiKey.sub, '로그인됨');

  const bedrock = View.claudeAccountView([claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: true, apiProvider: 'bedrock' })))], { connected: true });
  assert.equal(bedrock.title, 'AWS Bedrock');
  assert.equal(bedrock.methodLabel, '외부 클라우드 제공자');

  const out = View.claudeAccountView([claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: false, authMethod: 'none' })))], { connected: true });
  assert.equal(out.status, 'signedOut');
  assert.equal(out.title, '로그인되어 있지 않습니다');
  assert.match(out.hint, /터미널에서 Claude 로그인을 마친 뒤 다시 확인/);
  assert.match(out.hint, /이 컴퓨터의 Claude와 같은 로그인/);
  assert.equal(out.methodLabel, null);

  const unknown = View.claudeAccountView([claudeRow({ status: 'unknown', method: null, label: null, account: null, planType: null })], { connected: true });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.title, '로그인 상태 확인 안 됨');
});

test('Claude card distinguishes no bridge, no report and no CLI', () => {
  const signedIn = claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', email: 'me@example.com', subscriptionType: 'max' })));
  const disconnected = View.claudeAccountView([signedIn], { connected: false });
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(disconnected.title, '연결 안 됨');
  assert.equal(disconnected.account, null, 'the last-seen account is not shown while the bridge is unreachable');
  assert.equal(disconnected.action, null);
  assert.equal(View.claudeAccountView([], { connected: true }).status, 'noReport');
  assert.equal(View.claudeAccountView(null, { connected: true }).status, 'noReport');
  assert.equal(View.claudeAccountView([signedIn, signedIn], { connected: true }).status, 'noReport', 'two Claude rows are not resolved by picking one');
  const missing = View.claudeAccountView([publicEngineRow(describeClaudeEngine({ installed: false }, { minVersion: '2.1.205' }))], { connected: true });
  assert.equal(missing.status, 'notInstalled');
  assert.equal(missing.title, 'Claude Code 설치 필요');
  assert.equal(View.claudeAccountView([{ ...signedIn, profiles: [] }], { connected: true }).status, 'unknown');
});

test('the Settings card wires the account menu, the confirmation and the Claude card to the view models', () => {
  const source = readSurfaceSource();
  const start = source.indexOf('  function spawnSettingsCard(');
  const end = source.indexOf('\n  function resolveBrowserCard(', start);
  assert.ok(start >= 0 && end > start);
  const settings = source.slice(start, end);
  assert.ok(/AccountSettingsView = ChromeUtils\.importESModule\('chrome:\/\/userchrome\/content\/EGDeskAccountSettingsView\.sys\.mjs'\)/.test(source), 'the Settings zone imports the view module');
  assert.match(settings, /AccountSettingsView\.settingsConnectionView\(\{ connected: codex\.connected, bridgeState: codexBridgeNotice\(codex\)\.state \}\)/);
  assert.match(settings, /AccountSettingsView\.accountMenuItems\(auth\)/);
  assert.match(settings, /AccountSettingsView\.busyRunSummary\(\{ threads: state\.codex\.threads, protocol: state\.codex\.chatProtocol \}\)/);
  assert.match(settings, /AccountSettingsView\.accountActionConfirm\(/);
  assert.match(settings, /AccountSettingsView\.accountActionOutcome\(/);
  assert.match(settings, /AccountSettingsView\.claudeAccountView\(codex\.engines, \{ connected: codex\.connected \}\)/);
  assert.match(settings, /await bridge\(\)\?\.signOut\(\)/, 'sign-out goes through the real /auth/signout client');
  assert.match(settings, /await bridge\(\)\?\.startLogin\(\)/, 'switch continues into the real /auth/start client');
  assert.match(settings, /await bridge\(\)\?\.refreshAuthStatus\(\)/, 'the account is read back after the action');
  for (const testid of ['settings-account-menu', 'settings-account-confirm', 'settings-account-confirm-ok', 'settings-account-confirm-cancel',
    'settings-account-result', 'settings-claude-account', 'settings-claude-refresh']) {
    assert.ok(settings.includes(`'${testid}'`), `testid ${testid}`);
  }
  assert.doesNotMatch(settings, /onclick: \(\) => bridge\(\)\?\.signOut\(\)/, 'no sign-out button without the confirmation');
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  for (const rule of ['.egd-settings-account-menu', '.egd-settings-account-confirm', '.egd-settings-account-result']) {
    assert.ok(css.includes(rule), `CSS rule ${rule}`);
  }
});

// SUB-13 / SUB-03 (Claude) / SUB-15 / SUB-08 view models.
import { usageDisplay } from '../helper/codex-account-usage.mjs';
import { claudeLoginTerminalCommand } from '../helper/claude-engine-auth.mjs';
import { describeCodexEngine } from '../helper/codex-engine-adapter.mjs';

const claudeEngine = (check = {}, live = { minVersion: '2.1.205' }) => publicEngineRow(describeClaudeEngine({
  installed: true, version: '2.1.300', versionStatus: 'supported',
  auth: { status: 'signedIn', method: 'claudeai', account: 'me@example.com', label: 'Claude Max' }, ...check }, live));

test('an unlisted CLI is not an account warning; only a real action is visible (SUB-13)', () => {
  const codex = versionStatus => publicEngineRow(describeCodexEngine({ ready: true, version: '0.162.1', versionStatus, auth: { isLoggedIn: true } }));
  for (const status of ['supported', 'untested', null]) assert.equal(View.engineVersionBadge([codex(status)], 'codex'), null);
  assert.equal(View.engineVersionBadge([codex('unsupported')], 'codex').label, 'Codex 업데이트 권장');
  assert.equal(View.engineVersionBadge([claudeEngine({ versionStatus: 'untested' })], 'claude'), null);
  const blocked = [claudeEngine({ version: '2.1.204', versionStatus: 'unsupported' }), claudeEngine({ version: null }),
    claudeEngine({ versionStatus: 'untested' }, { minVersion: '2.1.205', gateFailure: 'CLAUDE_CAPABILITIES_MISSING' })];
  for (const [index, row] of blocked.entries()) {
    const view = View.claudeAccountView([row], { connected: true });
    assert.equal(view.status, 'unavailable'); assert.equal(view.account, 'me@example.com');
    assert.match(view.hint, index === 1 ? /설치 상태를 확인/ : /업데이트/); assert.equal(view.action, 'refresh');
    assert.doesNotMatch(view.hint, /CAPABILITIES|엔진|CLI|예상한 형식/);
    assert.ok(!view.login); assert.equal(View.claudeAccountView([row], { connected: false }).account, null);
  }
  assert.equal(View.engineVersionBadge([claudeEngine({ installed: false, version: null })], 'claude'), null);
});

test('Claude usage comes from the engines[] profile usage in the ChatGPT ring shape (SUB-03)', () => {
  const now = Date.now();
  assert.equal(View.claudeUsageView([claudeEngine({ auth: { status: 'signedOut' } })]), null, 'nothing while signed out');
  const unknown = View.claudeUsageView([claudeEngine()]);
  assert.deepEqual([unknown.level, unknown.percent, unknown.text], ['unknown', null, '확인 안 됨'], 'never an invented 0%');
  const row = claudeEngine();
  const rate = { primary: { usedPercent: 81, windowMinutes: 10080, resetsAt: now + 86_400_000 }, secondary: { usedPercent: 12, windowMinutes: 300, resetsAt: now + 3_600_000 }, observedAt: now };
  row.profiles[0].usage = { ...usageDisplay(rate, now), windows: [], creditsRequired: false, autoResume: false };
  const warn = View.claudeUsageView([row]);
  assert.deepEqual([warn.level, warn.percent, warn.percentLabel, warn.windowLabel], ['warn', 81, '81% 사용', '주간 한도']);
  assert.match(warn.title, /^Claude · 주간 한도 · 81% 사용/);
  const hit = claudeEngine();
  hit.profiles[0].usage = usageDisplay({ ...rate, reachedType: 'rate_limit_reached', usageAllowed: false }, now);
  assert.deepEqual([View.claudeUsageView([hit]).level, View.claudeUsageView([hit]).text], ['limit', '한도']);
});

test('API key profiles read 종량 과금 and the env-key confirmation shows names only (SUB-15, D-S4)', () => {
  assert.equal(View.engineBillingLabel({ method: 'apiKey' }), '종량 과금');
  assert.equal(View.engineBillingLabel({ method: 'claudeai' }), null);
  assert.equal(View.codexBillingLabel({ isLoggedIn: false, authMode: 'apikey' }, []), '종량 과금');
  const codexApiKey = publicEngineRow(describeCodexEngine({ ready: true, auth: { isLoggedIn: false, authMode: 'apikey' } }));
  assert.equal(View.codexBillingLabel({}, [codexApiKey]), '종량 과금', 'from the engines[] Codex profile');
  assert.equal(View.codexBillingLabel({ isLoggedIn: true, authMode: 'chatgpt' }, []), null);
  assert.equal(View.claudeAccountView([claudeEngine({ auth: { status: 'signedIn', method: 'apiKey' } })], { connected: true }).billingLabel, '종량 과금');

  const plain = claudeEngine();
  assert.equal(View.claudeApiKeyEnvConfirm([plain]), null, 'no key, no question');
  const keyed = publicEngineRow(describeClaudeEngine({ installed: true, version: '2.1.300', versionStatus: 'supported',
    auth: { status: 'signedIn', method: 'claudeai' } }, { minVersion: '2.1.205', apiKeyEnv: { detected: ['ANTHROPIC_API_KEY'], confirmed: false } }));
  assert.equal(keyed.statusReason, 'CLAUDE_API_KEY_DETECTED');
  const ask = View.claudeApiKeyEnvConfirm([keyed], { detected: ['ANTHROPIC_API_KEY', 'sk-ant-secret-value'], confirmed: false });
  assert.deepEqual(ask.names, ['ANTHROPIC_API_KEY'], 'only the known variable names, never a value');
  assert.doesNotMatch(ask.lines.join(' '), /sk-ant/);
  assert.match(ask.lines[0], /종량제/);
  assert.match(ask.lines[1], /넘기지 않습니다/);
  assert.deepEqual([ask.confirmLabel, ask.cancelLabel], ['키 빼고 구독으로 실행', '실행하지 않음']);
  assert.equal(View.claudeApiKeyEnvConfirm([keyed], { detected: ['ANTHROPIC_API_KEY'], confirmed: true }), null);
});

test('Terminal login types only the helper login line and reports a stuck terminal (SUB-08)', async () => {
  const typed = [];
  const card = { isConnected: true, _termBrowser: { contentWindow: { terminalAPI: { isConnected: () => true, write: data => typed.push(data) } } } };
  const ok = await View.runClaudeLoginInTerminal({ requestCommand: async method => claudeLoginTerminalCommand(method), openTerminal: () => card });
  assert.equal(ok.phase, 'started');
  assert.deepEqual(typed, ['claude auth login --claudeai\r']);
  let opened = 0;
  const odd = await View.runClaudeLoginInTerminal({ requestCommand: async () => ({ method: 'claudeai', line: 'claude auth login --claudeai; rm -rf ~' }), openTerminal: () => { opened++; return card; } });
  assert.equal(odd.phase, 'error');
  assert.equal(opened, 0, 'an unexpected line never reaches a terminal');
  const failed = await View.runClaudeLoginInTerminal({ requestCommand: async () => { throw new Error('404 Not Found'); }, openTerminal: () => card });
  assert.match(failed.text, /로그인 명령을 받지 못했습니다: 404/);
  let clock = 0;
  const stuck = await View.runClaudeLoginInTerminal({ requestCommand: async () => claudeLoginTerminalCommand(), openTerminal: () => ({ isConnected: true }),
    terminalApi: () => null, sleep: async () => { clock += 1000; }, now: () => clock, timeoutMs: 3000 });
  assert.equal(stuck.phase, 'error');
  assert.match(stuck.text, /claude auth login --claudeai 을 직접 실행/);
});

test('login waits for an asynchronously connected Terminal using its Firefox window timer', async () => {
  let ready = false, waits = 0;
  const writes = [];
  const card = { isConnected: true, ownerDocument: { defaultView: { setTimeout(callback, ms) {
    assert.equal(ms, 50); waits++; ready = true; queueMicrotask(callback);
  } } }, _termBrowser: { contentWindow: { terminalAPI: { isConnected: () => ready, write: line => writes.push(line) } } } };
  const result = await View.runClaudeLoginInTerminal({ requestCommand: async () => claudeLoginTerminalCommand('claudeai'), openTerminal: () => card, timeoutMs: 150 });
  assert.deepEqual([result.phase, waits, writes], ['started', 1, ['claude auth login --claudeai\r']]);
});

test('changing the displayed account while its Terminal connects writes nothing; subscription cannot change to console', async () => {
  const id = 'claude-ab123456', line = `CLAUDE_CONFIG_DIR='/sample/engines/${id}' claude auth login --claudeai`;
  const command = { engine: 'claude', profileId: id, env: 'CLAUDE_CONFIG_DIR', line };
  let current = true, opened = 0, written = 0;
  const opts = { engineId: 'claude', profileId: id, requestCommand: async () => command, isCurrent: () => current,
    openTerminal: () => { opened++; return {}; }, terminalApi: () => ({ isConnected: () => !current, write: () => { written++; } }), sleep: async () => { current = false; } };
  assert.equal((await View.runEngineProfileLoginInTerminal(opts)).phase, 'error');
  assert.deepEqual([opened, written], [1, 0]);
  current = true;
  for (const wrong of [{ ...command, line: line.replace('--claudeai', '--console') }, { ...command, profileId: 'claude-other' }]) {
    assert.equal((await View.runEngineProfileLoginInTerminal({ ...opts, requestCommand: async () => wrong })).phase, 'error');
  }
  assert.deepEqual([opened, written], [1, 0]);
});

test('the bridge client calls the Claude routes and the Settings card uses them', () => {
  const source = readSurfaceSource();
  assert.match(source, /fetchJson\('\/engines\/claude\/refresh', \{ method: 'POST', signal: token\.signal \}\)/);
  assert.match(source, /fetchJson\(`\/engines\/claude\/login-command\?method=\$\{encodeURIComponent\(method\)\}`\)/);
  assert.match(source, /fetchJson\('\/engines\/claude\/api-key-env'/);
  const start = source.indexOf('  function spawnSettingsCard(');
  const settings = source.slice(start, source.indexOf('\n  function resolveBrowserCard(', start));
  assert.match(settings, /AccountSettingsView\.runClaudeLoginInTerminal\(/);
  assert.match(settings, /openTerminal: \(\) => spawnTerminalCard\(\)/);
  assert.match(settings, /await api\.refreshClaudeEngine\(\)/);
  assert.match(settings, /api\.claudeApiKeyEnv\(action === 'keyConfirm'\)/);
  assert.doesNotMatch(settings, /settings-claude-refresh' \}, onclick: \(\) => bridge\(\)\?\.refreshAuthStatus\(\)/, 'the Claude check is no longer the generic state read');
});

test('decision model section: unknown offline, key hint only, Korean verification, mode choices', async () => {
  const View = await import('../overlay/resources/EGDeskAccountSettingsView.sys.mjs');
  const offline = View.decisionSettingsView({ configured: true, keyHint: '…WXYZ', mode: 'on' }, { connected: false });
  assert.equal(offline.status, 'unknown');
  assert.equal(offline.canSave, false);
  assert.equal(offline.modeEnabled, false);
  assert.equal(offline.mode, 'off');
  const empty = View.decisionSettingsView({ configured: false, store: 'missing', keyHint: null, mode: 'off', budget: { month: '2026-11', inputTokens: 0, cap: null } }, { connected: true });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.keyLine, '저장된 키 없음');
  assert.equal(empty.canSave, true);
  assert.equal(empty.canDelete, false);
  assert.deepEqual(empty.modes.map(m => [m.label, m.selected]), [['끔', true], ['기록만', false], ['사용', false]]);
  assert.equal(empty.budgetLine, '이번 달 입력 0 토큰');
  assert.match(empty.creditNote, /Pro·Business.*API 조직의 project key/);
  const saved = View.decisionSettingsView({ configured: true, store: 'loaded', keyHint: '…WXYZ', mode: 'advisory' }, { connected: true });
  assert.equal(saved.keyLine, '저장된 키 …WXYZ');
  assert.equal(saved.canDelete, true);
  assert.equal(saved.mode, 'advisory');
  assert.equal(saved.modes.find(m => m.selected).label, '기록만');
  assert.match(View.decisionSettingsView({ configured: false, mode: 'on' }, { connected: true }).modeNote, /키를 저장하면 적용됩니다/);
  assert.equal(View.decisionSettingsView({ configured: false, store: 'unavailable', mode: 'off' }, { connected: true }).canSave, false);
  assert.equal(View.decisionVerificationText('verified'), '확인됨');
  assert.match(View.decisionVerificationText('no_credit'), /^크레딧 없음/);
  assert.equal(View.decisionVerificationText('invalid_key'), '키가 올바르지 않습니다');
  assert.match(View.decisionVerificationText('model_unavailable'), /쓸 수 없습니다/);
  assert.match(View.decisionVerificationText('unreachable'), /연결하지 못했습니다/);
  assert.match(View.decisionVerificationText('something-else'), /연결하지 못했습니다/);
  assert.deepEqual(View.decisionCredentialOutcome({ result: { verification: 'verified' } }), { phase: 'done', verification: 'verified', text: '확인됨' });
  assert.equal(View.decisionCredentialOutcome({ result: { verification: 'no_credit' } }).phase, 'warning');
  const rejected = View.decisionCredentialOutcome({ error: { code: 'DECISION_KEY_REJECTED', verification: 'invalid_key' } });
  assert.equal(rejected.phase, 'error');
  assert.match(rejected.text, /키가 올바르지 않습니다 · 키를 저장하지 않았습니다/);
  assert.match(View.decisionCredentialOutcome({ error: { code: 'DECISION_KEY_INVALID' } }).text, /형식/);
  assert.match(View.decisionCredentialOutcome({ error: new Error('x') }).text, /브리지/);
})

test('SUB-11 profile list: label, shared/owned marker, remove only for owned inactive, Codex extras 준비 중', () => {
  const engines = [
    { id: 'claude', profiles: [
      { id: 'claude-default', label: 'Claude', owned: false, active: true, auth: { status: 'signedIn' } },
      { id: 'claude-ab12', label: '회사', owned: true, active: false },
      { id: 'claude-ab12', label: '중복', owned: true },
      { id: 'codex-zz', label: '남의 것', owned: true }] },
    { id: 'codex', profiles: [
      { id: 'codex-default', label: 'ChatGPT', owned: false, active: true },
      { id: 'codex-cd34', label: '개인', owned: true, status: 'notYet' }] },
  ];
  const claude = View.engineProfilesView(engines, 'claude', { connected: true });
  assert.deepEqual(claude.rows.map(row => [row.id, row.label, row.marker, row.canRemove]), [
    ['claude-default', 'Claude', View.ENGINE_PROFILE_MARKERS.shared, false],
    ['claude-ab12', '회사', View.ENGINE_PROFILE_MARKERS.owned, true]]);
  assert.equal(claude.canAdd, true);
  const codex = View.engineProfilesView(engines, 'codex', { connected: true });
  assert.equal(codex.rows[1].authText, '준비 중');
  assert.equal(codex.rows[1].canActivate, false);
  assert.equal(View.engineProfilesView(engines, 'claude', { connected: false }).rows.length, 0);
});

test('SUB-11 profile login line: only the official CLI login for a private folder is accepted', () => {
  const line = "CLAUDE_CONFIG_DIR='/Users/a/profiles/claude-ab12' claude auth login --claudeai";
  assert.equal(View.engineProfileLoginLine({ line, env: 'CLAUDE_CONFIG_DIR', engine: 'claude' }), line);
  assert.equal(View.engineProfileLoginLine({ line: `${line}; rm -rf ~`, env: 'CLAUDE_CONFIG_DIR', engine: 'claude' }), null);
  assert.equal(View.engineProfileLoginLine({ line, env: 'CODEX_HOME', engine: 'claude' }), null);
  assert.match(View.engineProfileErrorText({ code: 'ENGINE_PROFILE_DEFAULT' }), /지울 수 없습니다/);
});

test('SUB-11 profile login types the line into a terminal', async () => {
  const line = "CLAUDE_CONFIG_DIR='/Users/a/p/claude-ab12' claude auth login --claudeai";
  const written = [];
  const result = await View.runEngineProfileLoginInTerminal({
    requestCommand: async () => ({ line, env: 'CLAUDE_CONFIG_DIR', engine: 'claude' }),
    openTerminal: () => ({}), terminalApi: () => ({ isConnected: () => true, write: async value => { written.push(value); } }), sleep: async () => {} });
  assert.equal(result.phase, 'started');
  assert.deepEqual(written, [`${line}\r`]);
});

test('available owned Codex profiles display their own auth and never globally activate', () => {
  const codex = View.engineProfilesView([{ id: 'codex', profiles: [
    { id: 'codex-default', active: true, auth: { status: 'signedOut' } },
    { id: 'codex-12345678', owned: true, status: 'available', auth: { status: 'signedIn' } },
    { id: 'codex-87654321', owned: true, status: 'notYet' },
  ] }], 'codex', { connected: true });
  assert.deepEqual(codex.rows.map(r => [r.authText, r.canActivate, r.canLogin]), [
    ['선택됨', false, false], ['로그인됨', false, true], ['준비 중', false, false],
  ]);
});

test('isolated Codex terminal allowlist verifies slot metadata and the command home', async () => {
  const profileId = 'codex-12345678', engineId = 'codex';
  const line = `env -i HOME="$HOME" PATH="$PATH" CODEX_HOME='/tmp/settings/engines/${profileId}' codex -c cli_auth_credentials_store=file login`;
  const command = { line, env: 'CODEX_HOME', engine: engineId, profileId };
  const expected = { engineId, profileId };
  assert.equal(View.engineProfileLoginLine(command, expected), line);
  assert.equal(View.engineProfileLoginLine(command), null);
  for (const wrong of [
    { ...command, profileId: 'codex-87654321' }, { ...command, line: line.replace(profileId, 'codex-87654321') },
    { ...command, line: 'codex login' }, { ...command, line: `${line}; echo wrong` }, { ...command, line: `${line}\n` },
  ]) assert.equal(View.engineProfileLoginLine(wrong, expected), null);
  const written = [];
  const result = await View.runEngineProfileLoginInTerminal({ ...expected, requestCommand: async () => command,
    openTerminal: () => ({}), terminalApi: () => ({ isConnected: () => true, write: async value => { written.push(value); } }) });
  assert.equal(result.phase, 'started');
  assert.deepEqual(written, [`${line}\r`]);
});
