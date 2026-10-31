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
  assert.equal(max.methodLabel, '구독 · Anthropic 공식 로그인');
  assert.equal(max.planType, 'max');
  assert.equal(max.action, 'refresh');
  assert.equal(max.hint, null);

  const noEmail = View.claudeAccountView([claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', subscriptionType: 'pro' })))], { connected: true });
  assert.equal(noEmail.sub, '계정 이메일 확인 안 됨');

  const apiKey = View.claudeAccountView([claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' })))], { connected: true });
  assert.equal(apiKey.status, 'signedIn');
  assert.equal(apiKey.title, 'Anthropic API key');
  assert.equal(apiKey.method, 'apiKey');
  assert.equal(apiKey.methodLabel, 'Anthropic API 키 · 사용량 과금');
  assert.equal(apiKey.planType, null);
  assert.equal(apiKey.sub, '로그인됨');

  const bedrock = View.claudeAccountView([claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: true, apiProvider: 'bedrock' })))], { connected: true });
  assert.equal(bedrock.title, 'AWS Bedrock');
  assert.equal(bedrock.methodLabel, '외부 클라우드 제공자');

  const out = View.claudeAccountView([claudeRow(claudeAuthFromCliStatus(JSON.stringify({ loggedIn: false, authMethod: 'none' })))], { connected: true });
  assert.equal(out.status, 'signedOut');
  assert.equal(out.title, '로그인되어 있지 않습니다');
  assert.match(out.hint, /claude auth login/);
  assert.match(out.hint, /로그인 정보를 보관하지 않습니다/);
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
  assert.equal(missing.title, 'Claude CLI가 설치되어 있지 않습니다');
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
