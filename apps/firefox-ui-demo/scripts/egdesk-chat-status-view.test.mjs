import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as StatusView from '../overlay/resources/EGDeskChatStatusView.sys.mjs';
import * as Chat from '../overlay/resources/EGDeskChatState.sys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');

test('the status line is quiet while nothing asks for attention', () => {
  assert.equal(StatusView.statusRowQuiet({ status: 'ready' }), true, 'no run yet');
  assert.equal(StatusView.statusRowQuiet({ status: 'completed' }), true, 'a finished answer');
  for (const status of ['running', 'submitting', 'unconfirmed', 'preparing-input', 'restoring', 'stopping', 'interrupted', 'failed', 'unavailable']) {
    assert.equal(StatusView.statusRowQuiet({ status }), false, `${status} keeps the line`);
  }
  assert.equal(StatusView.statusRowQuiet({ status: 'ready', bindingHeld: true }), false);
  assert.equal(StatusView.statusRowQuiet({ status: 'ready', unobservedPreviousRun: true }), false);
  assert.equal(StatusView.statusRowQuiet({ status: 'completed', approvals: 1 }), false);
  assert.equal(StatusView.statusRowQuiet({ status: 'completed', questions: 1 }), false);
  assert.equal(StatusView.statusRowQuiet({ status: 'completed', blocked: 2 }), false);
  assert.equal(StatusView.statusRowQuiet({ status: 'completed', scope: { completeness: 'partial' } }), false, 'a partial result is said');
  assert.equal(StatusView.statusRowQuiet({ status: 'completed', scope: { completeness: 'full' } }), true);
});

test("only a run's last answer carries the '…' to its record", () => {
  const answer = { id: 'm2', role: 'assistant', runId: 'run-1' };
  assert.equal(StatusView.answerActivityShown(answer, 'm2'), true);
  assert.equal(StatusView.answerActivityShown(answer, 'm3'), false, 'an earlier answer of the same run');
  assert.equal(StatusView.answerActivityShown({ id: 'm1', role: 'user', runId: 'run-1' }, 'm1'), false);
  assert.equal(StatusView.answerActivityShown({ id: 'm4', role: 'assistant' }, 'm4'), false, 'an answer without a run');
});

test('a waiting run says what it asks and where to answer', () => {
  assert.equal(StatusView.waitingAsk(null), null);
  assert.equal(StatusView.waitingAsk({ pendingApprovals: [], pendingUserInputs: [] }), null);
  const approval = StatusView.waitingAsk({ pendingApprovals: [
    { id: 'a1', itemId: 'item-9', status: 'pending', command: 'npm   run\nbuild', reason: '빌드 확인' },
    { id: 'a2', status: 'pending', command: 'ls' }] });
  assert.deepEqual(approval, { kind: 'approval', detail: '실행 요청 · npm run build', actionLabel: '확인하기', more: 1, activityId: 'item-9' });
  assert.equal(StatusView.waitingMoreText(approval), '외 1건');
  assert.equal(StatusView.waitingAsk({ pendingApprovals: [{ id: 'a', reason: '외부 전송 전 확인' }] }).detail, '외부 전송 전 확인');
  assert.equal(StatusView.waitingAsk({ pendingApprovals: [{ id: 'a', kind: 'fileChange' }] }).detail, '파일 변경을 적용해도 되는지 묻고 있습니다');
  assert.equal(StatusView.waitingAsk({ pendingApprovals: [{ id: 'a', stale: true, command: 'x' }] }), null, 'a stale request is not asked again');
  const question = StatusView.waitingAsk({ pendingUserInputs: [{ userInputId: 'u1', status: 'pending', itemId: 'item-q',
    questions: [{ questionId: 'q1', header: '배포', question: '어느 환경에 올릴까요?' }, { questionId: 'q2', question: '언제?' }] }] });
  assert.deepEqual(question, { kind: 'question', detail: '배포 · 어느 환경에 올릴까요?', actionLabel: '답하기', more: 1, activityId: 'item-q' });
  assert.equal(StatusView.waitingAsk({ pendingUserInputs: [{ userInputId: 'u1', status: 'replySent', questions: [{ question: 'x' }] }] }), null);
  assert.equal(StatusView.waitingAsk({ localHistory: true, pendingApprovals: [{ id: 'a', command: 'x' }] }), null, 'a past run asks nothing now');
  const long = StatusView.waitingAsk({ pendingApprovals: [{ id: 'a', command: '가'.repeat(300) }] });
  assert.equal([...long.detail].length <= 110, true);
  assert.equal(long.detail.endsWith('…'), true);
  assert.equal(StatusView.waitingMoreText(long), '');
});

test('result scope reads apart from the run state', () => {
  assert.equal(StatusView.resultScope({ status: 'completed' }, []), null, 'a single answer keeps its plain wording');
  assert.equal(StatusView.resultScope({ status: 'running' }, ['done', 'blocked']), null, 'only a finished run has a result scope');
  assert.deepEqual(StatusView.resultScope({ status: 'completed' }, ['done', 'done', 'blocked']),
    { completeness: 'partial', done: 2, failed: 1, unfinished: 0, total: 3, text: '부분 · 완료 2 / 실패 1' });
  assert.equal(StatusView.resultScope({ status: 'completed' }, ['done', 'done']).text, '전체 · 완료 2');
  assert.equal(StatusView.resultScope({ status: 'completed' }, ['blocked', 'stopped']).text, '없음 · 완료 0 / 실패 1 / 미완료 1');
  assert.equal(StatusView.resultScope({ status: 'completed' }, ['done', 'stopped']).text, '부분 · 완료 1 / 미완료 1');
});

test('an unconfirmed state names when it was last checked', () => {
  const at = new Date(2026, 10, 14, 3, 12, 40).getTime();
  assert.equal(StatusView.checkedClockText(at), '03:12 확인');
  assert.equal(StatusView.checkedClockText(null), null);
  assert.equal(StatusView.checkedClockText(Number.NaN), null);
  assert.equal(StatusView.uncertainStatusText('연결 끊김 · 실행 상태 확인 필요', at), '연결 끊김 · 실행 상태 확인 필요 · 03:12 확인');
  assert.equal(StatusView.uncertainStatusText('지난 실행 · 현재 상태 미확인', at), '지난 실행 · 현재 상태 미확인 · 03:12 확인');
  assert.equal(StatusView.uncertainStatusText('중지 확인 필요', null), '중지 확인 필요', 'never checked: no time is made up');
  assert.equal(StatusView.uncertainStatusText('응답 중', at), '응답 중', 'a known state carries no check time');
});

test('the task list opens by itself once per new wait on 대표님', () => {
  const first = StatusView.taskAttention({ keys: ['g:t:q1'], seen: [], open: false });
  assert.deepEqual(first, { open: true, opened: true, seen: ['g:t:q1'], changed: true });
  const folded = StatusView.taskAttention({ keys: ['g:t:q1'], seen: first.seen, open: false });
  assert.deepEqual(folded, { open: false, opened: false, seen: ['g:t:q1'], changed: false }, 'folding it keeps it folded');
  const next = StatusView.taskAttention({ keys: ['g:t:q1', 'g:t:q2'], seen: folded.seen, open: false });
  assert.equal(next.opened, true, 'a new wait opens it again');
  const gone = StatusView.taskAttention({ keys: [], seen: next.seen, open: true });
  assert.deepEqual(gone, { open: true, opened: false, seen: [], changed: true }, 'an answered wait never closes the list');
  assert.equal(StatusView.taskAttention({ keys: ['a'], seen: [], open: true }).opened, false, 'already open: nothing to do');
});

// ---- Task list: waits on 대표님 (B12) ----
const graphOf = (tasks, patch = {}) => ({ graphId: 'graph-a', activated: true, cancelRequested: false, tasks, ...patch });
const taskOf = (taskId, status, gates = []) => ({ taskId, status, dependsOn: [], gates });
const scopeOf = graph => ({ accountId: 'acct-a', boardId: 'board-a', graphId: graph.graphId });
const boardOf = (graph, approvals = []) => Chat.taskBoardWithState(Chat.createTaskBoard(), { graph,
  native: { boardId: 'board-a', scope: scopeOf(graph), fenced: false, attempts: [], approvals }, board: { boardId: 'board-a', graphIds: [graph.graphId] } });

test("the task summary tells waits on 대표님 from waits on earlier work", () => {
  const board = boardOf(graphOf([
    taskOf('t1', 'running'),
    taskOf('t2', 'queued', [{ gateId: 'ask', kind: 'userAction', status: 'waiting', label: '견적 금액 확인' }]),
    { ...taskOf('t3', 'approval-required', [{ gateId: 'ok', kind: 'approval', status: 'waiting' }]), approvalRequested: true },
    taskOf('t7', 'approval-required', [{ gateId: 'later', kind: 'approval', status: 'waiting' }]),
    taskOf('t4', 'queued', [{ gateId: 'sso', kind: 'oauth', status: 'waiting', origin: 'https://accounts.example.com', pathPrefix: '/cb' }]),
    taskOf('t5', 'waiting-on-dependency', [{ gateId: 'dep', kind: 'task', status: 'waiting', taskId: 't1' }]),
    taskOf('t6', 'queued', [{ gateId: 'done', kind: 'userAction', status: 'satisfied', label: '끝난 확인' }]),
  ]), [{ approvalId: 'task-approval-1', taskId: 't3', status: 'pending' }]);
  const summary = Chat.taskBoardSummary(board);
  assert.equal(summary.text, '진행 1건 · 대기 6건', 'the plain count keeps its wording');
  assert.equal(summary.mine, 3);
  assert.equal(summary.mineText, '내 확인 3건');
  assert.deepEqual(summary.mineKeys, ['graph-a:t2:ask', 'graph-a:t3:ok', 'graph-a:t4:sso'], 'an approval nobody asked for yet is not 대표님\'s turn');
  const conditions = Chat.taskBoardView(board).groups[0].tasks.flatMap(task => task.conditions.map(condition => [condition.gateId, condition.mine]));
  assert.deepEqual(conditions, [['ask', true], ['ok', true], ['later', false], ['sso', true], ['dep', false], ['done', false]]);
  const none = Chat.taskBoardSummary(boardOf(graphOf([taskOf('t1', 'running'), taskOf('t5', 'waiting-on-dependency', [{ gateId: 'dep', kind: 'task', status: 'waiting', taskId: 't1' }])])));
  assert.deepEqual([none.mine, none.mineText, none.mineKeys], [0, '', []]);
  const cancelled = Chat.taskBoardSummary(boardOf(graphOf([taskOf('t2', 'queued', [{ gateId: 'ask', kind: 'userAction', status: 'waiting' }])], { cancelRequested: true })));
  assert.equal(cancelled.mine, 0, 'a cancelled graph asks nothing');
  const finished = Chat.taskBoardSummary(boardOf(graphOf([taskOf('t2', 'completed', [{ gateId: 'ask', kind: 'userAction', status: 'waiting' }])])));
  assert.equal(finished.mine, 0, 'a finished task asks nothing');
});

test('a login wait offers its sign-in site; nothing else does', () => {
  const login = { gateId: 'sso', kind: 'oauth', status: 'waiting', origin: 'https://accounts.example.com', pathPrefix: '/cb' };
  assert.equal(Chat.taskGateOpenTarget(login), 'https://accounts.example.com');
  assert.equal(Chat.taskGateView(login).openLabel, '로그인 열기');
  for (const gate of [{ ...login, status: 'satisfied' }, { ...login, origin: 'https://accounts.example.com/path?x=1' }, { ...login, origin: 'javascript:alert(1)' },
    { ...login, origin: 'file:///etc' }, { ...login, origin: null }, { gateId: 't', kind: 'terminalExit', status: 'waiting' }]) {
    assert.equal(Chat.taskGateOpenTarget(gate), null);
    assert.equal(Object.hasOwn(Chat.taskGateView(gate), 'openLabel'), false);
  }
});

// ---- DOM wiring, from the production definitions in eg-desk-surface.uc.js ----
const declaration = name => {
  const source = surfaceSource.match(new RegExp(`\\n  function ${name}\\([^]*?\\n  \\}`))?.[0];
  assert.ok(source, `${name} stays directly testable`);
  return source;
};
const node = (tag, props = {}, ...children) => ({ tag, props, children: children.flat().filter(child => child != null && child !== false) });
const textOf = value => (typeof value === 'string' ? value : (value?.children || []).map(textOf).join(''));
const find = (value, test) => (value && typeof value === 'object' ? [...(test(value) ? [value] : []), ...value.children.flatMap(child => find(child, test))] : []);
const byTestId = (value, id) => find(value, item => item.props?.data?.testid === id);
const click = button => button.props.onclick({ stopPropagation() {} });

test('the waiting bubble says what is asked and its button goes to answer it', () => {
  const row = new Function('el', 'codexMessageAvatarFace', `${declaration('codexAgentWorkingRow')}\nreturn codexAgentWorkingRow;`)(
    node, () => ({ toneClass: '', photo: null, text: 'C' }));
  const calls = [];
  const plain = row({ state: 'working', text: 'Agent 작업 중' }, { runId: 'r1', name: 'Codex', onOpen: () => calls.push('open') });
  assert.equal(byTestId(plain, 'chat-agent-working-ask').length, 0, 'a working run asks nothing');
  assert.equal(byTestId(plain, 'chat-agent-working-answer').length, 0);
  const ask = { ...StatusView.waitingAsk({ pendingApprovals: [{ id: 'a1', itemId: 'item-9', command: 'npm run build' }, { id: 'a2', command: 'ls' }] }) };
  ask.moreText = StatusView.waitingMoreText(ask);
  const waiting = row({ state: 'approval', text: '승인을 기다리는 중' },
    { runId: 'r1', name: '검증 담당', onOpen: () => calls.push('open'), ask, onAnswer: () => calls.push('answer') });
  const [line] = byTestId(waiting, 'chat-agent-working-ask');
  assert.equal(line.props.data.kind, 'approval');
  assert.equal(textOf(line), '실행 요청 · npm run build외 1건확인하기');
  const [button] = byTestId(waiting, 'chat-agent-working-answer');
  assert.equal(button.tag, 'button');
  assert.equal(button.props['aria-label'], '검증 담당 · 실행 요청 · npm run build · 확인하기');
  assert.equal(button.props.title, '활동 기록에서 확인하기');
  assert.equal(button.props.data.focusKey, 'agent-working-answer-r1');
  assert.equal(calls.length, 0, 'drawing the bubble opens nothing');
  click(button);
  assert.deepEqual(calls, ['answer']);
  click(byTestId(waiting, 'chat-agent-working-open')[0]);
  assert.deepEqual(calls, ['answer', 'open'], 'the bubble itself still opens the record');
  const question = row({ state: 'question', text: '답변을 기다리는 중' }, { runId: 'r2', onOpen: () => calls.push('open'),
    ask: { kind: 'question', detail: '어느 환경에 올릴까요?', actionLabel: '답하기', moreText: '' } });
  assert.equal(textOf(byTestId(question, 'chat-agent-working-ask')[0]), '어느 환경에 올릴까요?답하기');
  click(byTestId(question, 'chat-agent-working-answer')[0]);
  assert.equal(calls.at(-1), 'open', 'without its own target the button opens the run');
  // The conversation feeds the bubble from the run it belongs to, and focuses that request in the record.
  assert.match(surfaceSource, /const ask = \['approval', 'question'\]\.includes\(row\?\.state\) \? ChatStatusView\.waitingAsk\(run\) : null;/);
  assert.match(surfaceSource, /onAnswer: \(\) => codexBridge\.openActivity\(activeThread\.id, \{ runId: run\.runId \|\| null, activityId: ask\.activityId \}\)/);
  assert.match(surfaceSource, /\.\.\.workingAskProps\(working, workingRun\),/);
  assert.match(surfaceSource, /\.\.\.workingAskProps\(row, roomRuns\.find\(run => run\.runId === row\.runId\)\),/);
});

test("an answer's time line carries the '…' that opens its record", () => {
  const meta = new Function('el', 'codexReadMeta', 'formatMessageTime', `${declaration('codexMessageTimeMeta')}\nreturn codexMessageTimeMeta;`)(
    node, () => null, () => '오전 9:41');
  const message = { id: 'm2', role: 'assistant', runId: 'run-1', createdAt: 1 };
  const plain = meta(message, {});
  assert.equal(plain.props.class, 'egd-codex-message-meta');
  assert.equal(byTestId(plain, 'chat-answer-activity').length, 0);
  let opened = 0;
  const foot = meta(message, {}, () => { opened++; });
  assert.equal(foot.props.class, 'egd-codex-message-meta egd-codex-message-meta-foot');
  const [button] = byTestId(foot, 'chat-answer-activity');
  assert.deepEqual([button.tag, button.props.type, button.props.title, button.props['aria-label'], button.props.data.runId, button.props.data.focusKey],
    ['button', 'button', '이 답변의 실행 내역 보기', '이 답변의 실행 내역 보기', 'run-1', 'answer-activity-m2']);
  assert.equal(textOf(foot), '오전 9:41', 'the mark is drawn, not typed');
  click(button);
  assert.equal(opened, 1);
  assert.ok(meta({ id: 'm3', role: 'assistant', runId: 'run-2' }, {}, () => {}), 'an answer without a time still reaches its record');
  assert.match(surfaceSource, /ChatStatusView\.answerActivityShown\(message, lastAnswerOfRun\.get\(message\.runId\)\)\n\s+\? \(\) => codexBridge\.openActivity\(activeThread\.id, \{ runId: message\.runId \}\) : null\);/);
  assert.match(css, /button\.egd-codex-message-activity:hover \{[^}]*background: var\(--egd-hover\);/);
  assert.match(css, /button\.egd-codex-message-activity:focus-visible \{[^}]*outline: var\(--egd-focus-outline\);/);
});

test('the status line steps aside by state, stays in the page, and keeps a way into the record', () => {
  assert.match(surfaceSource, /quiet: String\(statusQuiet\) \},/);
  assert.match(surfaceSource, /const answerHoldsRecord = !run \|\| activeThread\.messages\.some\(message => message\.role === 'assistant' && message\.runId === run\.runId\);\n\s+const statusQuiet = answerHoldsRecord && ChatStatusView\.statusRowQuiet\(\{/,
    "the line only hides when the run's own answer carries the way into its record");
  assert.match(css, /\.egd-codex-run-status\[data-quiet="true"\] \{ display: none; \}/);
  assert.match(surfaceSource, /ChatStatusView\.uncertainStatusText\(statusText, codex\.bridgeCheckedAt\)/);
  assert.match(surfaceSource, /data: \{ testid: 'chat-run-scope', completeness: resultScope\.completeness \} \}, `결과 범위: \$\{resultScope\.text\}`\)/);
  // B12: the list opens by state, once; drawing never closes it.
  assert.match(surfaceSource, /if \(taskAttention\.changed\) codex\.taskAttentionSeen = taskAttention\.seen;\n\s+if \(taskAttention\.opened\) codex\.taskBoardOpen = true;/);
});

test('a lost connection is one line: state, when it was checked, retry; the rest folds', () => {
  const at = new Date(2026, 10, 14, 3, 12).getTime();
  const offline = { state: 'offline', text: '연결이 끊겼습니다', action: '다시 시도', details: ['오류: TypeError: NetworkError'] };
  const history = '로컬 기록을 확인하지 못했습니다. 기존 채팅과 초안은 유지됩니다.';
  assert.deepEqual(StatusView.connectionLine(offline, { localHistoryError: history, checkedAt: at }), {
    state: 'offline', text: '연결이 끊겼습니다', action: '다시 시도', checked: '03:12 확인',
    details: [history, '오류: TypeError: NetworkError'] }, 'the history failure sits under 자세히, not in a second box');
  assert.deepEqual(StatusView.connectionLine({ state: 'reconnecting', text: '다시 연결 중…', action: null, details: [] }),
    { state: 'reconnecting', text: '다시 연결 중…', action: null, checked: null, details: [] }, 'never checked: no time is made up');
  assert.equal(StatusView.connectionLine({ state: 'online', text: '연결됨', action: null, details: ['응답 시간 30ms'] }, { localHistoryError: history, checkedAt: at }), null,
    'nothing extra while connected');
  assert.equal(StatusView.connectionLine(null), null);
  assert.deepEqual(StatusView.connectionLine(offline, { localHistoryError: '   ' }).details, ['오류: TypeError: NetworkError']);
});

test('the connection notice draws that one line and the conversation drops its second box', () => {
  const state = { codex: { showBridgeDetails: false } };
  const build = new Function('el', 'codexBridgeNotice', 'ChatStatusView', 'state', `${declaration('buildCodexBridgeNotice')}\nreturn buildCodexBridgeNotice;`)(
    node, codex => ({ state: codex.connected ? 'online' : 'offline', text: '연결이 끊겼습니다', action: '다시 시도', details: ['오류: TypeError: NetworkError'] }), StatusView, state);
  const at = new Date(2026, 10, 14, 3, 12).getTime();
  let retried = 0;
  const notice = build({ connected: false, bridgeCheckedAt: at, localHistoryStatus: 'error', localHistoryError: '로컬 기록을 확인하지 못했습니다.' }, { reconnectNow: () => { retried++; } });
  assert.equal(notice.props.data.bridgeState, 'offline');
  const [row, details] = notice.children;
  assert.equal(textOf(row), '연결이 끊겼습니다03:12 확인다시 시도');
  assert.equal(textOf(byTestId(notice, 'chat-bridge-checked')[0]), '03:12 확인');
  const [retry] = byTestId(notice, 'chat-bridge-retry');
  assert.deepEqual([retry.tag, retry.props.type, retry.props.title, retry.props['aria-label']], ['button', 'button', '지금 다시 연결하기', '연결 다시 시도']);
  click(retry);
  assert.equal(retried, 1);
  assert.equal(details.tag, 'details');
  assert.equal(details.props.open, null, "'자세히' starts folded");
  assert.equal(textOf(details), '자세히로컬 기록을 확인하지 못했습니다.\n오류: TypeError: NetworkError');
  assert.equal(build({ connected: true, bridgeCheckedAt: at, localHistoryStatus: 'error', localHistoryError: 'x' }, {}), null);
  // A history failure that is not folded (the bridge answers) keeps its own line.
  assert.match(surfaceSource, /if \(codex\.localHistoryStatus === 'error' && codex\.localHistoryError && !connectionNotice\) conversation\.appendChild\(/);
  // Every observation of the bridge stamps when it was made.
  assert.match(surfaceSource, /if \(Object\.hasOwn\(patch, 'connected'\)\) patch = \{ \.\.\.patch, bridgeCheckedAt: Date\.now\(\) \};/);
  assert.match(css, /\.egd-codex-connection \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.egd-codex-connection-details\[open\] \{[^}]*flex: 1 0 100%;/);
  assert.match(css, /\.egd-codex-connection-details summary:focus-visible \{[^}]*outline: var\(--egd-focus-outline\);/);
});
