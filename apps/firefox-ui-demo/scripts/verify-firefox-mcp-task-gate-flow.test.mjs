import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import childProcess from 'node:child_process';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { prepareRunOutputDesk } from './verify-firefox-mcp-chat-run-outputs-flow.mjs';
import { TASK_GATE_SELECTORS, taskGateRowSelector, assertTaskGateEnvironment, assertQuestionIdentity, assertNoContinue,
  assertDraftRetained, assertNewQuestionCleared, assertCodePointLimit, assertOneAnswer, assertTaskGateEvidence,
  reconciledTaskGateRead, assertTaskGateStaleReconciled,
  observeTaskGate, observeTaskGateDesk, observeTaskGateTarget, observeTaskGateLimit, taskGateLimitReadable, assertTaskGateLimitPaint, readTaskGateLimit,
  observeTaskGateFailurePaint, assertTaskGateFailurePaint,
  assertTaskGateTitleEndPaint, taskGateTitleAtEnd,
  TASK_GATE_DIAGNOSTIC_LIMITS, createTaskGateDiagnostics, readyTaskGateTarget, chooseTaskGateScrollKey,
  TASK_GATE_SETTLEMENT, waitTaskGateTargetSettled, summarizeTaskGateFixture, waitTaskGateFixtureState,
  guardTaskGateTargetBeforeInput, observeTaskGateCamera, waitTaskGateOpenChatCamera,
  parseTaskGateCli, prepareTaskGateViewport,
  runTaskGateFlow, runCli } from './verify-firefox-mcp-task-gate-flow.mjs';

const ENV = { EGDESK_QA_TASK_GATE_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_REAL_TURN: '0',
  EGDESK_QA_FIXTURE_PORT: '49319', EGDESK_QA_FIXTURE_TOKEN: 'owned-task-gate-verifier-unit-token' };
const sha = value => createHash('sha256').update(value).digest('hex');
const cameraState = () => ({ zoom: 1, zoomTarget: 1, pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 },
  codex: { activeThreadId: 'local-original' } });
const identity = (extra = {}) => ({ graphId: 'graph-original', taskId: 'note', gateId: 'memo', label: '덧붙일 말', response: { kind: 'text', maxLength: 20 }, ...extra });
const ui = (extra = {}) => { const value = { count: 1, threadId: 'local-original', ...identity(),
  question: '덧붙일 말', next: '답변하면 메모를 반영합니다.', value: '답변', choice: null, notice: '',
  limit: 20, counted: 2, limitText: '2 / 20자', continueDisabled: false, ...extra };
  return { ...value, responseKey: extra.responseKey ?? JSON.stringify(['userAction', value.label, value.response]) }; };
const state = (extra = {}) => ({ requests: [], persisted: { answers: [] }, fakeProviderTurns: [], ...extra });
const failurePaint = current => ({ ui: current,
  notice: { count: 1, text: current.notice.trim(), accessibleLabel: `${current.question} · ${current.notice.trim()}`, styleVisible: true,
    fragments: [{ inside: true, clipped: false, hitCount: 3, hits: Array.from({ length: 3 }, () => ({ owned: true })) }] },
  errorQuestion: { count: 1, text: current.question, title: current.question, tabIndex: '0',
    styleVisible: true, inside: true, clipped: false,
    fragments: [{ visible: true, hitCount: 3, hits: Array.from({ length: 3 }, () => ({ owned: true })) }] },
  ...Object.fromEntries(['text', 'continue', 'cancel'].map(key => [key, {
    selector: `${taskGateRowSelector(current)} [data-testid=${JSON.stringify(TASK_GATE_SELECTORS[key])}]`,
    count: 1, visible: true, inside: true, clipped: false, hits: 9, disabled: false }])),
  composer: { selector: '[data-testid="chat-composer"]', count: 1, visible: true, inside: true,
    clipped: false, hits: 9, disabled: false, threadId: current.threadId } });
const post = (ids, status = 200, extra = {}) => ({ sequence: 1, method: 'POST', path: '/tasks/continue',
  delegated: true, status, request: { graphId: ids.graphId, taskId: ids.taskId, gateId: ids.gateId,
    answer: ids.response?.kind === 'choice' ? { choice: 'kakao' } : { textCodePoints: 20 } }, response: {}, ...extra });

function staleEvidence(next) {
  const typed = ui({ ...next, question: next.label, value: '다음 답변', counted: 5, limit: 8, limitText: '5 / 8자', state: 'waiting' });
  const before = state({ controls: [], original: { conversationId: 'native-original' },
    persisted: { answers: [{ ...identity(), textSha256: sha('😀'.repeat(20)), codePoints: 20 }] },
    fakeProviderTurns: [1, 2, 3].map(turnId => ({ turnId, conversationId: 'native-original' })) });
  const pending = post(next, null, { delegated: false });
  const accepted = { ...structuredClone(before), requests: [pending], held: { sequence: 1 }, pauseBroadcast: true,
    controls: [{ action: 'accept-held', result: { status: 200, graphId: next.graphId } }],
    fakeProviderTurns: [...before.fakeProviderTurns, { turnId: 4, conversationId: 'native-original' }],
    persisted: { answers: [...before.persisted.answers, { graphId: next.graphId, taskId: next.taskId, gateId: next.gateId,
      textSha256: sha(typed.value), codePoints: 5 }] } };
  const read = { sequence: 2, method: 'GET', path: '/tasks/state', query: `?graphId=${next.graphId}`, delegated: true, status: 200,
    response: { graph: { graphId: next.graphId, tasks: [{ taskId: next.taskId, gates: [{ gateId: next.gateId,
      kind: 'userAction', label: next.label, response: next.response, status: 'satisfied' }] }] } } };
  const after = { ...structuredClone(accepted), held: null, requests: [post(next, 409, { response: { code: 'TASK_GATE_STALE' } }), read] };
  return { identity: next, before, accepted, after, typed,
    ui: { ...typed, state: 'satisfied', value: '', choice: null, inputCount: 0, continueCount: 0, continueDisabled: true, notice: '' } };
}

// Assertion inputs ONLY. They are not fixture handler responses, a native
// browser run, screenshot evidence, or proof that Harvey's UI is implemented.
function evidence() {
  const choice = identity({ taskId: 'send', gateId: 'how', label: '어떻게 보낼까요?', response: { kind: 'choice',
    options: [{ id: 'email', label: '메일로' }, { id: 'kakao', label: '카카오톡으로' }] } });
  const text = identity(), next = identity({ graphId: 'graph-next', taskId: 'next-note', gateId: 'next-memo', label: '새 질문: 덧붙일 말', response: { kind: 'text', maxLength: 8 } });
  const value = '😀'.repeat(20), textUi = ui({ value, counted: 20, limitText: '20 / 20자' });
  const rejectedTyped = ui({ value: 'pw: hunter2', counted: 11 }), rejectedUi = { ...rejectedTyped, notice: '해당 값을 빼고 다시 답해 주세요.' };
  const nextUi = ui({ ...next, question: next.label, value: '', limit: 8, counted: 0, limitText: '0 / 8자' });
  const before = state(), chosen = state({ requests: [post(choice)] });
  const rejected = state({ requests: [post(text, 400, { response: { code: 'TASK_GATE_ANSWER_PRIVATE' } })] });
  const written = state({ requests: [post(text)], persisted: { answers: [{ ...text, codePoints: 20, textSha256: sha(value) }] } });
  const held = state({ requests: [post(choice, null, { delegated: false })], held: { sequence: 1 } });
  return { nativeInputs: true, domInjection: false, conversationId: 'native-original', threadId: 'local-original', clientThreadId: 'wire-original',
    fixture: { providerTurns: 0, nativeProcessSpawns: 0, original: { conversationId: 'native-original', clientThreadId: 'wire-original' },
      fakeProviderTurns: Array.from({ length: 4 }, () => ({ conversationId: 'native-original' })),
      plans: [{ graphId: choice.graphId, origin: { conversationId: 'native-original' }, questions: [choice, text] },
        { graphId: next.graphId, origin: { conversationId: 'native-original' }, questions: [next] }],
      frames: [{ type: 'task.graph', graphId: choice.graphId }, { type: 'task.graph', graphId: next.graphId }] },
    noPosts: ['choice-select', 'choice-enter', 'choice-cancel', 'typing', 'text-enter', 'oversize', 'same-question-refresh']
      .map(stage => ({ stage, before: state(), after: state() })),
    choice: { identity: choice, before, after: chosen, ui: ui({ ...choice, question: choice.label, choice: 'kakao', value: '' }) },
    rejected: { identity: text, before, after: rejected, typed: rejectedTyped, ui: rejectedUi, refreshed: structuredClone(rejectedUi) },
    errorPaint: { initial: failurePaint(rejectedUi), beforeCapture: failurePaint(rejectedUi) },
    text: { identity: text, before, after: written, ui: textUi, value },
    previousQuestion: rejectedUi, newQuestion: nextUi,
    stale: staleEvidence(next),
    duplicate: { whileHeld: held, afterAttempt: structuredClone(held), disabled: true } };
}

test('verifier import launches no browser, listener, provider or process and checks strict exclusive environment', async t => {
  const spies = [t.mock.method(net.Server.prototype, 'listen', () => assert.fail('no listener')),
    ...['spawn', 'spawnSync', 'execFile', 'execFileSync'].map(name => t.mock.method(childProcess, name, () => assert.fail('no browser/process')))];
  await import(`./verify-firefox-mcp-task-gate-flow.mjs?inert=${Date.now()}`);
  assert.equal(assertTaskGateEnvironment(ENV), true);
  for (const patch of [{ EGDESK_QA_TASK_GATE_FIXTURE: '0' }, { EGDESK_QA_REAL_TURN: '1' }, { EGDESK_QA_FIXTURE_TOKEN: '' },
    { EGDESK_QA_FIXTURE_PORT: '39218' }, { EGDESK_QA_FIXTURE_PORT: '65536' }, { EGDESK_QA_FIXTURE_PORT: undefined },
    { EGDESK_QA_PORTABLE_TRANSFER_FIXTURE: '1' }, { EGDESK_QA_CLAUDE_FIXTURE: '1' }]) assert.throws(() => assertTaskGateEnvironment({ ...ENV, ...patch }));
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

test('selector contract binds exact original graph/task/gate, safely escapes values and leaves identifiers out of human labels', () => {
  assert.ok(Object.isFrozen(TASK_GATE_SELECTORS));
  const selector = taskGateRowSelector(identity());
  for (const part of ['data-graph-id="graph-original"', 'data-task-id="note"', 'data-gate-id="memo"']) assert.ok(selector.includes(part));
  assert.ok(taskGateRowSelector(identity({ gateId: 'quote"gate' })).includes('quote\\"gate'));
  for (const bad of [null, {}, identity({ taskId: '' }), identity({ graphId: 'x'.repeat(257) })]) assert.throws(() => taskGateRowSelector(bad));
  assert.equal(assertQuestionIdentity(ui(), identity(), 'local-original'), true);
  for (const patch of [{ count: 2 }, { threadId: 'other' }, { graphId: 'other' }, { gateId: 'other' }, { question: 'other' },
    { responseKey: '' }, { next: '' }, { next: 'graphId를 계속합니다' }]) assert.throws(() => assertQuestionIdentity(ui(patch), identity(), 'local-original'));
});

test('select/type/Enter/cancel checks count attempted POSTs, not merely accepted responses or new records', () => {
  const before = state();
  assert.equal(assertNoContinue(before, state({ requests: [{ method: 'GET', path: '/tasks/state' }] }), 'refresh'), true);
  for (const status of [null, 200, 400, 409, 500]) assert.throws(() => assertNoContinue(before, state({ requests: [post(identity(), status)] }), 'input'));
  assert.throws(() => assertNoContinue(before, state({ persisted: { answers: [{}] } }), 'input'));
  assert.throws(() => assertNoContinue(before, state({ fakeProviderTurns: [{}] }), 'input'));
});

test('same-question error/refresh preserves exact answer and notice but requires the complete binding', () => {
  const before = ui({ notice: '다시 확인해 주세요.' });
  assert.equal(assertDraftRetained(before, structuredClone(before), { notice: true }), true);
  for (const key of ['threadId', 'graphId', 'taskId', 'gateId', 'responseKey', 'value', 'choice', 'notice']) {
    assert.throws(() => assertDraftRetained(before, { ...before, [key]: 'changed' }, { notice: true }));
  }
});

test('new question must actually change identity and start with no answer or stale notice', () => {
  const before = ui({ notice: 'old error' }), after = ui({ graphId: 'new', responseKey: 'new', value: '', notice: '' });
  assert.equal(assertNewQuestionCleared(before, after), true);
  for (const patch of [{ value: 'old answer' }, { choice: 'email' }, { notice: 'old error' }, { graphId: before.graphId, responseKey: before.responseKey }]) {
    assert.throws(() => assertNewQuestionCleared(before, { ...after, ...patch }));
  }
});

test('limit evidence requires exact native value and normalized code points; guessed UTF-16/truncated values fail', () => {
  const raw = ' e\u0301😀\r\n ', valid = ui({ value: raw, counted: 2, limitText: '2 / 20자' });
  assert.equal(assertCodePointLimit(valid, raw, 20), true);
  for (const patch of [{ value: raw.trim() }, { counted: raw.length }, { limit: 500 }, { limitText: '제한 있음' }]) {
    assert.throws(() => assertCodePointLimit({ ...valid, ...patch }, raw, 20));
  }
  const over = ui({ value: '😀'.repeat(21), counted: 21, limitText: '21 / 20자', continueDisabled: true });
  assert.equal(assertCodePointLimit(over, over.value, 20, { invalid: true }), true);
  assert.throws(() => assertCodePointLimit({ ...over, continueDisabled: false, notice: '' }, over.value, 20, { invalid: true }));
});

test('visible counter numbers must match actual NFC/code-point input and the independent question contract', () => {
  const raw = '😀'.repeat(21), actual = ui({ value: raw, counted: 21, limitText: '21 / 20자 · 입력 후 계속을 누르세요.' });
  assert.equal(assertCodePointLimit(actual, raw, identity().response.maxLength), true);
  for (const limitText of ['0 / 20자', '20 / 20자', '42 / 20자', '21 / 200자', 'counter 21 / 20', '20자 제한']) {
    assert.throws(() => assertCodePointLimit({ ...actual, limitText }, raw, identity().response.maxLength));
  }
  assert.throws(() => assertCodePointLimit({ ...actual, limit: 200, limitText: '21 / 200자' }, raw, identity().response.maxLength), /VISIBLE maximum/);
  const decomposed = ' e\u0301😀\r\n ';
  assert.equal(assertCodePointLimit(ui({ value: decomposed, counted: 2, limitText: '2 / 20자' }), decomposed, 20), true);
});

test('one explicit continue must have one production-handler receipt for the original identity', () => {
  const before = state(), after = state({ requests: [post(identity())] });
  assert.ok(assertOneAnswer(before, after, identity()));
  for (const row of [post(identity(), null), post(identity(), 500), post(identity(), 200, { delegated: false }), post(identity({ taskId: 'foreign' }))]) {
    assert.throws(() => assertOneAnswer(before, state({ requests: [row] }), identity()));
  }
  assert.throws(() => assertOneAnswer(before, state({ requests: [post(identity()), post(identity())] }), identity()));
});

test('complete assertion sample is valid but remains only a unit sample, not native UI evidence', () => {
  assert.equal(assertTaskGateEvidence(evidence()), true);
});

test('Task R3 real-stale contract is rejected UI POST then exact GET reconciliation, not a lasting error or accepted UI answer', () => {
  const proof = evidence().stale;
  assert.equal(proof.ui.notice, '', 'automatic reconciliation may already remove the transient error');
  assert.equal(assertTaskGateStaleReconciled(proof, 'local-original'), true);
  assert.equal(reconciledTaskGateRead(proof.after, proof.identity, 1)?.sequence, 2);
  for (const corrupt of [
    value => { value.after.requests[0].status = 200; },
    value => { value.after.requests[0].response.code = 'OTHER_ERROR'; },
    value => { value.after.requests[0].delegated = false; },
    value => { value.after.requests.push(post(value.identity, 200, { sequence: 3 })); },
    value => { value.accepted.controls = []; },
    value => { value.accepted.controls[0].result.status = 409; },
    value => { value.accepted.controls[0].result.graphId = 'unrelated'; },
    value => { value.accepted.held.sequence = 99; },
    value => { value.accepted.requests[0].status = 200; },
    value => { value.after.pauseBroadcast = false; },
  ]) { const changed = structuredClone(proof); corrupt(changed); assert.throws(() => assertTaskGateStaleReconciled(changed, 'local-original')); }
});

test('stale reconciliation refuses missing, older, foreign, nondelegated or still-waiting read receipts and editable UI', () => {
  const proof = evidence().stale;
  for (const corrupt of [
    value => { value.after.requests.pop(); },
    value => { value.after.requests[1].sequence = 1; },
    value => { value.after.requests[1].query = '?graphId=foreign'; },
    value => { value.after.requests[1].query += '&graphId=foreign'; },
    value => { value.after.requests[1].status = 500; },
    value => { value.after.requests[1].delegated = false; },
    value => { value.after.requests[1].response.graph.graphId = 'foreign'; },
    value => { value.after.requests[1].response.graph.tasks[0].taskId = 'foreign'; },
    value => { value.after.requests[1].response.graph.tasks[0].gates[0].gateId = 'foreign'; },
    value => { value.after.requests[1].response.graph.tasks[0].gates[0].status = 'waiting'; },
    value => { value.after.requests[1].response.graph.tasks[0].gates[0].response.maxLength = 500; },
    value => { value.ui.state = 'waiting'; value.ui.notice = 'still an error'; },
    value => { value.ui.inputCount = 1; },
    value => { value.ui.continueCount = 1; },
    value => { value.ui.threadId = 'foreign'; },
    value => { value.ui.responseKey = 'different-question'; },
  ]) { const changed = structuredClone(proof); corrupt(changed); assert.throws(() => assertTaskGateStaleReconciled(changed, 'local-original')); }
});

test('independent acceptance writes one matching answer; stale rejection cannot write, send or resume again', () => {
  const proof = evidence().stale;
  for (const corrupt of [
    value => { value.accepted.persisted.answers.pop(); },
    value => { value.accepted.persisted.answers[0].textSha256 = 'changed-old-answer'; },
    value => { value.accepted.persisted.answers.at(-1).gateId = 'foreign'; },
    value => { value.accepted.persisted.answers.at(-1).textSha256 = 'other-input'; },
    value => { value.after.persisted.answers.push({ ...value.after.persisted.answers.at(-1) }); },
    value => { value.after.fakeProviderTurns.push({ turnId: 5, conversationId: 'native-original' }); },
    value => { value.accepted.fakeProviderTurns.at(-1).conversationId = 'other-room'; },
    value => { value.after.requests.push({ method: 'POST', path: '/chat/send', sequence: 3 }); },
  ]) { const changed = structuredClone(proof); corrupt(changed); assert.throws(() => assertTaskGateStaleReconciled(changed, 'local-original')); }
});

test('full validator rejects missing stages, lost drafts, wrong original thread, fake receipts and duplicate submits', () => {
  const corruptions = [
    proof => { proof.nativeInputs = false; }, proof => { proof.domInjection = true; },
    proof => { proof.fixture.providerTurns = 1; }, proof => { proof.fixture.nativeProcessSpawns = 1; },
    proof => { proof.clientThreadId = 'different'; }, proof => { proof.fixture.fakeProviderTurns[1].conversationId = 'different'; },
    proof => { proof.fixture.plans[1].origin.conversationId = 'different'; }, proof => { proof.fixture.frames = []; },
    proof => { proof.noPosts.pop(); }, proof => { proof.noPosts[0].after.requests.push(post(identity(), 400)); },
    proof => { proof.choice.after.requests[0].delegated = false; }, proof => { proof.rejected.ui.value = ''; },
    proof => { proof.rejected.refreshed.notice = ''; }, proof => { proof.text.ui.counted = 40; },
    proof => { proof.text.after.persisted.answers[0].textSha256 = 'not-original'; }, proof => { proof.newQuestion.notice = 'old'; },
    proof => { proof.stale.ui.value = 'not cleared'; }, proof => { proof.stale.after.requests[0].response.code = 'fake'; },
    proof => { proof.duplicate.afterAttempt.requests.push(post(identity())); }, proof => { proof.duplicate.disabled = false; },
    proof => { proof.duplicate.whileHeld.held = null; proof.duplicate.afterAttempt.held = null; },
    proof => { proof.choice.ui.choice = 'email'; }, proof => { proof.choice.ui.responseKey = '["wrong-question"]'; },
    proof => { delete proof.errorPaint; }, proof => { proof.errorPaint.initial.continue.clipped = true; },
    proof => { proof.errorPaint.beforeCapture.cancel.hits = 8; }, proof => { proof.errorPaint.initial.notice.fragments = []; },
    proof => { proof.errorPaint.initial.errorQuestion.text = '다른 질문'; },
    proof => { proof.errorPaint.beforeCapture.notice.accessibleLabel = '질문이 빠진 오류'; },
  ];
  for (const corrupt of corruptions) { const proof = evidence(); corrupt(proof); assert.throws(() => assertTaskGateEvidence(proof)); }
});

test('observation is bounded read-only chrome source; no input or DOM/state mutation occurs during reads', async () => {
  const sources = [], harness = { evaluateChrome(source) { sources.push(source); return Promise.resolve({ count: 0 }); } };
  await observeTaskGate(harness, identity());
  await observeTaskGateDesk(harness);
  await observeTaskGateTarget(harness, '[data-testid="chat-task-answer-continue"]');
  await observeTaskGateLimit(harness, identity());
  await observeTaskGateFailurePaint(harness, identity());
  await observeTaskGateCamera(harness);
  assert.equal(sources.length, 6);
  for (const source of sources) {
    assert.ok(Buffer.byteLength(source) < 12000);
    for (const forbidden of [/dispatchEvent/, /new (?:InputEvent|KeyboardEvent|Event)\(/, /\.value\s*=/, /\.click\(/,
      /innerHTML\s*=/, /__egdesk[^\n]*\s=\s/, /\.style\s*[.=]/, /\.focus\(/, /scrollTop\s*=/,
      /scrollIntoView|scrollTo\(|scrollBy\(/]) assert.doesNotMatch(source, forbidden);
  }
});

function targetDiagnosticDom({ direction = 'PageUp', depth = 3, missing = false, ambiguous = false, foreignList = false,
  outsideBoundClip = false, clientOnlyClip = false } = {}) {
  const box = (left, top, width, height) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height });
  let active, commandFocused, scrollTop = 320;
  const noInput = () => assert.fail('diagnostic DOM is observational only');
  const make = (tag, testId, r, parentElement, extra = {}, attrs = {}) => Object.freeze({
    localName: tag, parentElement, clientLeft: 0, clientTop: 0, clientWidth: r.width, clientHeight: r.height,
    offsetWidth: r.width, offsetHeight: r.height, scrollTop: 0, scrollLeft: 0, scrollWidth: r.width, scrollHeight: r.height,
    disabled: false, overflowX: 'visible', overflowY: 'visible',
    getAttribute: key => ({ id: testId, 'data-testid': testId, ...attrs })[key] ?? null,
    getBoundingClientRect: () => r,
    contains(other) { for (let at = other; at; at = at.parentElement) if (at === this) return true; return false; },
    closest(selector) { for (let at = this; at; at = at.parentElement) if (selector === `[data-testid="${at.getAttribute('data-testid')}"]`) return at; return null; },
    focus: noInput, click: noInput, scrollIntoView: noInput, ...extra,
  });
  let outer = null;
  for (let i = depth; i > 2; i--) outer = make('div', `ancestor-${i}`, box(0, 0, 800, outsideBoundClip && i === depth ? 200 : 600), outer,
    { overflowY: outsideBoundClip && i === depth ? 'hidden' : 'visible' });
  const listBox = box(100, 250, 300, 140);
  const listBase = make('div', 'chat-task-list', listBox, outer,
    { clientLeft: 4, clientTop: 6, clientWidth: 592, clientHeight: 260, offsetWidth: 600, offsetHeight: 280,
      scrollHeight: 900, overflowY: 'auto' });
  const list = Object.freeze(Object.defineProperty({ ...listBase }, 'scrollTop', { get: () => scrollTop }));
  const row = make('section', 'chat-task-condition', box(100, 200, 600, 400), list, {}, {
    'data-graph-id': 'graph-original', 'data-task-id': 'send', 'data-gate-id': 'how',
    'data-response-key': '["userAction","original-question",{}]', class: 'x'.repeat(900),
  });
  const targetBox = clientOnlyClip ? box(158, 251, 14, 14) : direction === 'PageUp' ? box(158, 248, 14, 14) : box(263, 410, 352, 63);
  const target = make(direction === 'PageUp' ? 'input' : 'textarea', direction === 'PageUp' ? 'chat-task-answer-choice' : 'chat-task-answer-text',
    targetBox, row, {}, { type: 'radio', 'data-choice-id': 'email' });
  const other = make('div', 'foreign-scroll-target', box(0, 0, 800, 600), null, { scrollTop: 7 });
  active = target; commandFocused = other;
  const context = { innerWidth: direction === 'PageUp' ? 600 : 800, innerHeight: 600,
    window: { __egdesk: { state: cameraState() } },
    getComputedStyle: element => ({ display: 'block', visibility: 'visible', overflowX: element.overflowX, overflowY: element.overflowY }),
    document: Object.freeze({
      get activeElement() { return active; },
      commandDispatcher: Object.freeze({ get focusedElement() { return commandFocused; } }),
      querySelectorAll: selector => selector === '[data-testid="chat-task-list"]' ? foreignList ? [other, list] : [list]
        : missing ? [] : ambiguous ? [target, other] : [target],
      elementFromPoint: () => direction === 'PageUp' ? target : other,
    }) };
  return { target, list, other, h: { evaluateChrome: source => vm.runInNewContext(`(${source})()`, context) },
    advance() { scrollTop += direction === 'PageUp' ? -100 : 100; active = list; commandFocused = list; } };
}

test('ready diagnostics preserve 600/800 full-box failures and record exact identity, scaled client bounds, scroll and both focus sources', async () => {
  for (const direction of ['PageUp', 'PageDown']) {
    const f = targetDiagnosticDom({ direction }), proof = await observeTaskGateTarget(f.h, 'exact-original-target');
    assert.equal(proof.scrollDirection, direction); assert.equal(proof.clipped, true); assert.equal(proof.inside, true);
    assert.equal(proof.hits, direction === 'PageUp' ? 9 : 0);
    assert.deepEqual(Object.keys(proof.rect).sort(), ['bottom', 'height', 'left', 'right', 'top', 'width', 'x', 'y']);
    const d = proof.diagnostics, list = d.ancestors[1];
    assert.equal(d.target.identity.choiceId, 'email'); assert.equal(d.rowIdentity.graphId, 'graph-original');
    assert.equal(d.rowIdentity.taskId, 'send'); assert.equal(d.rowIdentity.gateId, 'how');
    assert.equal(d.rowIdentity.responseKey, '["userAction","original-question",{}]');
    assert.equal(d.rowIdentity.className.length, TASK_GATE_DIAGNOSTIC_LIMITS.identityChars);
    assert.equal(d.rowIdentity.truncated[0], 'className');
    assert.equal(list.identity.testId, 'chat-task-list'); assert.equal(list.overflowY, 'auto');
    assert.equal(list.clipsTargetBorderY, true); assert.equal(list.clipsTargetClientY, true);
    assert.deepEqual(JSON.parse(JSON.stringify(list.clientRect)), { left: 102, top: 253, right: 398, bottom: 383, width: 296, height: 130 });
    assert.deepEqual([list.scrollTop, list.clientHeight, list.scrollHeight, list.scaleY], [320, 260, 900, .5]);
    assert.equal(d.focusedElement.identity.testId, d.target.identity.testId);
    assert.equal(d.commandFocusedElement.identity.testId, 'foreign-scroll-target');
    assert.equal(d.scrollTarget.count, 1); assert.equal(d.scrollTarget.isClosestList, true);
    assert.equal(d.scrollTarget.element.active, false); assert.equal(d.scrollTarget.element.containsActive, true);
  }
});

test('client clipping is diagnostic only; bounded ancestor capture never truncates the existing clipping predicate', async () => {
  const client = await observeTaskGateTarget(targetDiagnosticDom({ clientOnlyClip: true }).h, 'target');
  assert.equal(client.clipped, false, 'do not introduce a product or acceptance fix');
  assert.equal(client.diagnostics.ancestors[1].clipsTargetClientY, true);
  const depth = TASK_GATE_DIAGNOSTIC_LIMITS.ancestors + 8;
  const proof = await observeTaskGateTarget(targetDiagnosticDom({ depth, clientOnlyClip: true, outsideBoundClip: true }).h, 'target');
  assert.equal(proof.clipped, true, 'outer clipping beyond the stored ancestor bound still fails');
  assert.equal(proof.diagnostics.ancestorCount, depth);
  assert.equal(proof.diagnostics.ancestors.length, TASK_GATE_DIAGNOSTIC_LIMITS.ancestors);
  assert.equal(proof.diagnostics.ancestorsTruncated, true);
  assert.ok(proof.diagnostics.ancestors.every(parent => !parent.clipsTargetBorderY));
});

test('diagnostics distinguish the actual first global scroll match, closest list, absent target and ambiguous target', async () => {
  const foreign = await observeTaskGateTarget(targetDiagnosticDom({ foreignList: true }).h, 'target');
  assert.equal(foreign.diagnostics.scrollTarget.count, 2); assert.equal(foreign.diagnostics.scrollTarget.isClosestList, false);
  assert.equal(foreign.diagnostics.scrollTarget.element.identity.testId, 'foreign-scroll-target');
  assert.equal(foreign.diagnostics.scrollTarget.element.scrollTop, 7);
  assert.equal(foreign.diagnostics.closestList.identity.testId, 'chat-task-list');
  for (const config of [{ missing: true }, { ambiguous: true }]) {
    const proof = await observeTaskGateTarget(targetDiagnosticDom(config).h, 'target');
    assert.equal(proof.count, config.missing ? 0 : 2); assert.equal(proof.visible, false);
    assert.equal(proof.rect, null); assert.equal(proof.diagnostics.target, null);
    assert.equal(proof.diagnostics.ancestorCount, 0); assert.equal(proof.diagnostics.scrollTarget.count, 1);
    assert.ok(proof.diagnostics.focusedElement);
  }
});

const readyTarget = (patch = {}) => ({ selector: 'exact-target', count: 1, visible: true, inside: true,
  clipped: false, hits: 9, disabled: false, scrollDirection: null, ...patch });
const unitWait = async (_h, read, accept) => {
  for (let i = 0; i < 3; i++) { const value = await read(); if (accept(value)) return value; }
  throw new Error('unchanged readiness timeout');
};
// Isolate existing action/diagnostic contracts from settlement/final guards in
// these unit tests. Real default paths and their ordering are exercised below.
const unitSettle = (h, _selector, deadline, { read, wait, accept = () => true }) => wait(h, read, accept, deadline);
const unitLimitSettled = async () => {};
const unitGuard = async (_h, _selector, settled) => settled;

// Original ready() policy, retained here ONLY as an independent action oracle.
async function originalReadyPolicy(harness, read, wait) {
  for (let i = 0; i < 6; i++) {
    const target = await wait(harness, read, value => value.count === 1 && value.visible);
    if (target.inside && !target.clipped && target.hits === 9 && !target.disabled) return;
    if (!target.scrollDirection) break;
    await harness.scrollWithKey('[data-testid="chat-task-list"]', target.scrollDirection);
  }
  await wait(harness, read, value => value.count === 1 && value.visible && value.inside && !value.clipped && value.hits === 9 && !value.disabled);
}

test('without near-edge evidence, settled ready retains the coarse action sequence, six-key ceiling and strict fullbox+9hit acceptance', async () => {
  const cases = [() => readyTarget(), ...[
    { clipped: true, scrollDirection: 'PageUp' }, { clipped: true, hits: 0, scrollDirection: 'PageDown' },
    { clipped: true }, { hits: 8 }, { inside: false }, { disabled: true }, { count: 2 }, { visible: false },
  ].map(patch => () => readyTarget(patch)), keys => readyTarget(keys < 2 ? { clipped: true, scrollDirection: keys ? 'PageDown' : 'PageUp' } : {})];
  for (const value of cases) {
    const runs = [];
    for (const instrumented of [false, true]) {
      const keys = [], diagnostics = createTaskGateDiagnostics(); let reads = 0, waits = 0, afterReads = 0;
      const h = { scrollWithKey: async (selector, key) => { keys.push([selector, key]); return { key, before: 20, after: 20, moved: false }; } };
      const read = async () => { reads++; return value(keys.length); };
      const wait = (...args) => { waits++; return unitWait(...args); };
      let error = null;
      try {
        if (instrumented) await readyTaskGateTarget(h, 'exact-target', Date.now() + 10000, { read, wait, diagnostics, settle: unitSettle, finalGuard: unitGuard,
          keyRead: async () => { afterReads++; return readyTarget(); } });
        else await originalReadyPolicy(h, read, wait);
      } catch (caught) { error = caught.message; }
      runs.push({ keys, reads, waits, error });
      if (instrumented) {
        assert.equal(afterReads, keys.length); assert.ok(keys.length <= 6);
        assert.equal(diagnostics.records[0].status, error ? 'failed' : 'ready');
        assert.equal(diagnostics.records[0].samples, reads);
        assert.equal(diagnostics.records[0].keys.length, keys.length);
      }
    }
    assert.deepEqual(runs[1], runs[0], 'extra diagnostic reads must not influence the action oracle');
  }
});

test('coarse and fine native keys retain before/after snapshots, list scope and exact receipt without bypassing the next policy read', async () => {
  for (const direction of ['PageUp', 'PageDown']) {
    const f = targetDiagnosticDom({ direction }), diagnostics = createTaskGateDiagnostics();
    const before = await observeTaskGateTarget(f.h, 'exact-target');
    let reads = 0;
    const expected = direction === 'PageUp' ? 'ArrowUp' : 'PageDown';
    const receipt = { key: expected, before: 320, after: direction === 'PageUp' ? 220 : 420, max: 640, moved: true, focused: true };
    const input = async (selector, key) => {
      assert.equal(selector, '[data-testid="chat-task-list"]'); assert.equal(key, expected); f.advance(); return receipt;
    };
    await readyTaskGateTarget({ scrollWithKey: input, press: (key, selector) => input(selector, key) },
      'exact-target', Date.now() + 10000, { diagnostics, wait: unitWait, settle: unitSettle, finalGuard: unitGuard,
      read: async () => ++reads === 1 ? before : readyTarget(), keyRead: () => observeTaskGateTarget(f.h, 'exact-target') });
    const step = diagnostics.records[0].keys[0];
    assert.equal(reads, 2); assert.equal(step.before, before); assert.equal(step.receipt, receipt);
    assert.equal(step.boundary, direction === 'PageUp' ? 'press' : 'scrollWithKey');
    assert.equal(step.status, 'returned'); assert.equal(step.invoked, true);
    assert.equal(step.before.diagnostics.focusedElement.identity.testId, before.diagnostics.target.identity.testId);
    assert.equal(step.after.diagnostics.focusedElement.identity.testId, 'chat-task-list');
    assert.equal(step.after.diagnostics.commandFocusedElement.identity.testId, 'chat-task-list');
    assert.equal(step.after.diagnostics.scrollTarget.element.scrollTop, receipt.after);
    assert.equal(step.after.diagnostics.scrollTarget.element.active, true);
    assert.ok(step.startedAt <= step.returnedAt && step.returnedAt <= step.observedAfterAt);
  }
});

test('diagnostic record count remains bounded through long timeout polling and repeated ready calls without losing the terminal failure or key pairs', async () => {
  const diagnostics = createTaskGateDiagnostics(), limit = TASK_GATE_DIAGNOSTIC_LIMITS.records;
  let keys = 0;
  const h = { scrollWithKey: async () => { keys++; return { moved: false }; } };
  for (let i = 0; i < limit + 5; i++) await readyTaskGateTarget(h, `ready-${i}`, Date.now() + 10000,
    { diagnostics, read: async () => readyTarget(), wait: unitWait, settle: unitSettle, finalGuard: unitGuard });
  const clipped = readyTarget({ clipped: true, scrollDirection: 'PageUp' });
  await assert.rejects(readyTaskGateTarget(h, 'terminal-failure', Date.now() + 10000, { diagnostics, read: async () => clipped, settle: unitSettle, finalGuard: unitGuard,
    keyRead: async () => clipped, wait: async (_h, read, accept) => {
      for (let i = 0; i < 500; i++) { const value = await read(); if (accept(value)) return value; }
      throw new Error('bounded terminal timeout');
    } }), /bounded terminal timeout/);
  assert.equal(diagnostics.records.length, limit); assert.equal(diagnostics.totalRecords, limit + 6);
  assert.equal(diagnostics.droppedRecords, 6); assert.equal(diagnostics.records[0].sequence, 7);
  const last = diagnostics.records.at(-1);
  assert.equal(last.selector, 'terminal-failure'); assert.equal(last.status, 'failed'); assert.equal(last.last, clipped);
  assert.equal(last.samples, 506); assert.equal(last.keys.length, 6); assert.equal(keys, 6);
  assert.ok(last.keys.every(step => step.before === clipped && step.after === clipped));
  assert.ok(JSON.stringify(diagnostics).length < 16000, 'polls do not append unbounded snapshots');
});

test('native key failure is rethrown unchanged; diagnostic failure, missing target and expiry never cause rescue input', async () => {
  for (const failRead of [false, true]) {
    const diagnostics = createTaskGateDiagnostics(), original = new Error('original native failure'); let keys = 0, afterReads = 0;
    await assert.rejects(readyTaskGateTarget({ scrollWithKey: async () => { keys++; throw original; } }, 'target', Date.now() + 10000,
      { diagnostics, wait: unitWait, settle: unitSettle, finalGuard: unitGuard, read: async () => readyTarget({ clipped: true, scrollDirection: 'PageDown' }),
        keyRead: async () => { afterReads++; if (failRead) throw new Error('diagnostic-only failure'); return readyTarget({ count: 0 }); } }), error => error === original);
    const record = diagnostics.records[0];
    assert.equal(keys, 1); assert.equal(afterReads, 1); assert.equal(record.keys[0].status, 'threw');
    assert.equal(record.error, original.message);
    if (failRead) assert.equal(record.keys[0].afterError, 'diagnostic-only failure');
    else assert.equal(record.keys[0].after.count, 0);
  }
  const noAction = new Proxy({}, { get: () => assert.fail('expired operation performs no UI action') });
  await assert.rejects(readyTaskGateTarget(noAction, 'target', 1,
    { diagnostics: createTaskGateDiagnostics(), read: () => assert.fail('no expired read') }));
});

test('never-resolving after-key diagnostics are capped by remaining deadline and 250ms, preserving the exact native exception', { timeout: 2000 }, async () => {
  for (const remainingMs of [10000, 40]) {
    const diagnostics = createTaskGateDiagnostics(), original = new Error('native failure survives a stuck observer');
    let keys = 0, diagnosticReads = 0;
    await assert.rejects(readyTaskGateTarget({ scrollWithKey: async () => { keys++; throw original; } }, 'target', Date.now() + remainingMs,
      { diagnostics, wait: unitWait, settle: unitSettle, finalGuard: unitGuard, read: async () => readyTarget({ clipped: true, scrollDirection: 'PageDown' }),
        keyRead: () => { diagnosticReads++; return new Promise(() => {}); } }), error => error === original);
    const record = diagnostics.records[0], step = record.keys[0];
    assert.equal(keys, 1); assert.equal(diagnosticReads, 1); assert.equal(record.keys.length, 1);
    assert.equal(record.error, original.message); assert.equal(step.error, original.message);
    assert.equal(step.after, null); assert.equal(step.afterTimedOut, true);
    assert.match(step.afterError, /Diagnostic read timed out/);
    assert.ok(step.afterTimeoutMs > 0 && step.afterTimeoutMs <= Math.min(remainingMs, TASK_GATE_DIAGNOSTIC_LIMITS.keyReadMs));
    if (remainingMs === 10000) assert.equal(step.afterTimeoutMs, 250);
  }
});

function settlementClock() {
  const start = Date.now(); let elapsed = 0;
  return { now: () => start + elapsed, elapsed: () => elapsed,
    wait: async (h, read, accept, deadline, options) => {
      assert.equal(options.intervalMs, TASK_GATE_SETTLEMENT.intervalMs);
      assert.equal(options.timeoutMs, TASK_GATE_SETTLEMENT.timeoutMs);
      while (start + elapsed < deadline) {
        const value = await read(h);
        if (accept(value)) return value;
        elapsed += options.intervalMs;
      }
      throw new Error('unit settlement window expired');
    } };
}
async function settlementTarget(patch = {}) {
  const target = await observeTaskGateTarget(targetDiagnosticDom({ clientOnlyClip: true }).h, 'exact-target');
  return { ...JSON.parse(JSON.stringify(target)), ...patch };
}
function stampTarget(target, now = Date.now) {
  const value = structuredClone(target); value.diagnostics.observedAt = now(); return value;
}

// Scalar geometry from the final R2 600 trace. This models observed bounds,
// not Gecko key distance, focus routing or a verified product outcome.
async function r2ScrollTarget() {
  const base = await settlementTarget();
  const box = (left, top, width, height) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height });
  const listBox = box(148.98333740234375, 244.8333282470703, 371.9666748046875, 123.15000915527344);
  const client = { left: listBox.left, top: 245.7954376935959, right: listBox.right, bottom: listBox.bottom,
    width: listBox.width, height: 122.18789970874786 };
  const scale = (354.73333740234375 - 244.75) / (389.1333312988281 - 275);
  return scrollTop => {
    const value = structuredClone(base), d = value.diagnostics;
    const r = box(158, 354.73333740234375 - (scrollTop - 275) * scale, 352, 42.399993896484375);
    const list = { ...d.closestList, rect: listBox, clientRect: client, clientHeight: 127, scrollHeight: 642,
      scrollTop, active: true, containsActive: true };
    value.rect = r;
    value.clipped = r.top < listBox.top || r.bottom > listBox.bottom;
    value.hits = [.2, .5, .8].filter(y => r.top + r.height * y >= client.top && r.top + r.height * y <= client.bottom).length * 3;
    value.scrollDirection = r.bottom > listBox.bottom ? 'PageDown' : r.top < listBox.top ? 'PageUp' : null;
    d.target = { ...d.target, rect: r, clientRect: r, active: false, containsActive: false,
      identity: { ...d.target.identity, tag: 'textarea', type: null, testId: 'chat-task-answer-text', choiceId: null } };
    d.closestList = list; d.scrollTarget.element = list;
    d.ancestors[1] = { ...d.ancestors[1], ...list,
      clipsTargetBorderY: value.clipped, clipsTargetClientY: r.top < client.top || r.bottom > client.bottom };
    d.focusedElement = list; d.commandFocusedElement = list;
    return value;
  };
}

test('R2 measured near-edge distance and client/target heights select fine keys without relaxing even a subpixel full-box clip', async () => {
  const targetAt = await r2ScrollTarget();
  for (const [scrollTop, key] of [[160.86666870117188, 'PageDown'], [275, 'ArrowDown'], [389.1333312988281, 'ArrowUp']]) {
    const target = targetAt(scrollTop);
    assert.equal(chooseTaskGateScrollKey(target), key);
    assert.equal(target.clipped, true);
  }
  const top = targetAt(389.1333312988281);
  assert.equal(top.rect.top, 244.75); assert.equal(top.hits, 9);
  assert.ok(top.diagnostics.closestList.clientRect.top - top.rect.top > 1);
  const near = targetAt(275);
  near.diagnostics.closestList.clientRect.height = 60;
  assert.equal(chooseTaskGateScrollKey(near), 'PageDown', 'less available fit travel changes the near-edge decision');
  near.rect.height = 60;
  assert.equal(chooseTaskGateScrollKey(near), 'PageDown', 'fine keys do not pretend an oversized target fits');
  assert.equal(chooseTaskGateScrollKey({ ...top, scrollDirection: null, hits: 8 }), null, 'occlusion alone cannot authorize scrolling');
});

test('R2 fine adjustment targets only the Task list and waits through different simulated motion speeds before more keys or a click', async () => {
  const targetAt = await r2ScrollTarget();
  for (const [initial, duration, lineStep, expected] of [
    [160.86666870117188, 80, 20, ['PageDown', 'ArrowDown', 'ArrowDown']],
    [160.86666870117188, 200, 40, ['PageDown', 'ArrowDown']],
    [160.86666870117188, 440, 60, ['PageDown', 'ArrowDown']],
    [389.1333312988281, 320, 40, ['ArrowUp']],
  ]) {
    const clock = settlementClock(), diagnostics = createTaskGateDiagnostics(), actions = [];
    let from = initial, to = initial, startedAt = 0;
    const position = () => from + (to - from) * Math.min(1, (clock.elapsed() - startedAt) / duration);
    const read = async () => stampTarget(targetAt(position()), clock.now);
    const input = async (key, selector, boundary) => {
      assert.equal(selector, '[data-testid="chat-task-list"]', 'never send Arrow to the textarea/caret');
      assert.equal(position(), to);
      assert.ok(clock.elapsed() >= (actions.length ? startedAt + duration : 0) + TASK_GATE_SETTLEMENT.windowMs);
      from = to; to += key === 'PageDown' ? 275 - initial : key === 'ArrowDown' ? lineStep : -lineStep;
      startedAt = clock.elapsed();
      const receipt = { fixtureOnly: true, key, boundary };
      actions.push({ key, boundary, receipt }); return receipt;
    };
    const h = { scrollWithKey: (selector, key) => input(key, selector, 'scrollWithKey'),
      press: (key, selector) => input(key, selector, 'press') };
    // Also exercise the no-diagnostics dispatch path on the last case.
    await readyTaskGateTarget(h, 'exact-target', clock.now() + 20000,
      { ...clock, ...(initial > 300 ? {} : { diagnostics }), read, keyRead: read });
    assert.deepEqual(actions.map(a => a.key), expected);
    assert.ok(clock.elapsed() >= startedAt + duration + TASK_GATE_SETTLEMENT.windowMs);
    const final = targetAt(position());
    assert.equal(final.clipped, false); assert.equal(final.hits, 9);
    for (const [i, step] of (diagnostics.records[0]?.keys || []).entries()) {
      assert.equal(step.boundary, actions[i].boundary); assert.equal(step.receipt, actions[i].receipt);
      assert.equal(step.before.diagnostics.focusedElement.identity.testId, 'chat-task-list');
      assert.equal(step.after.diagnostics.commandFocusedElement.identity.testId, 'chat-task-list');
    }
  }
});

test('coarse and ineffective fine keys share one six-adjustment budget with no rescue or transient-paint acceptance', async () => {
  const targetAt = await r2ScrollTarget(), clock = settlementClock(), diagnostics = createTaskGateDiagnostics(), keys = [];
  let scroll = 160.86666870117188;
  const read = async () => stampTarget(targetAt(scroll), clock.now);
  await assert.rejects(readyTaskGateTarget({
    scrollWithKey: async (selector, key) => { assert.equal(selector, '[data-testid="chat-task-list"]'); keys.push(key); scroll = 275; },
    press: async (key, selector) => { assert.equal(selector, '[data-testid="chat-task-list"]'); keys.push(key); },
  }, 'exact-target', clock.now() + 20000, { ...clock, diagnostics, read, keyRead: read }), /did not settle before input/);
  assert.deepEqual(keys, ['PageDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown']);
  const record = diagnostics.records[0];
  assert.equal(record.status, 'failed'); assert.equal(record.keys.length, 6); assert.equal(record.settlements.length, 7);
  assert.equal(record.last.clipped, true);
});

test('fine-key final guard refuses foreign scope, scroll target, changed geometry and stale evidence before invoking press', async () => {
  const targetAt = await r2ScrollTarget();
  for (const change of [
    v => { v.diagnostics.scope.roomId = 'foreign-room'; },
    v => { v.diagnostics.scope.camera.pan.y++; },
    v => { v.diagnostics.viewport.width++; },
    v => { v.diagnostics.scrollTarget.isClosestList = false; },
    v => { v.diagnostics.scrollTarget.element.scrollTop++; },
    v => { v.diagnostics.rowIdentity.gateId = 'foreign-gate'; },
    v => { v.diagnostics.observedAt -= TASK_GATE_SETTLEMENT.maxAgeMs + 1; },
  ]) {
    const clock = settlementClock(), diagnostics = createTaskGateDiagnostics(); let keys = 0;
    await assert.rejects(readyTaskGateTarget({ press: async () => { keys++; }, scrollWithKey: async () => { keys++; } },
      'exact-target', clock.now() + 10000, { ...clock, diagnostics, read: async () => stampTarget(targetAt(275), clock.now),
        keyRead: async () => { const value = stampTarget(targetAt(275), clock.now); change(value); return value; },
      }), /changed|scroll target must|stale/);
    assert.equal(keys, 0); assert.equal(diagnostics.records[0].keys.length, 0);
    assert.equal(diagnostics.records[0].finalGuard.status, 'failed');
  }
});

test('fine-key native exception survives a never-resolving after-read with the same bounded diagnostic policy', { timeout: 1500 }, async () => {
  const targetAt = await r2ScrollTarget(), clock = settlementClock(), diagnostics = createTaskGateDiagnostics();
  const original = new Error('native Arrow failure'); let reads = 0, keys = 0;
  await assert.rejects(readyTaskGateTarget({ press: async (key, selector) => {
    assert.equal(key, 'ArrowDown'); assert.equal(selector, '[data-testid="chat-task-list"]'); keys++; throw original;
  } }, 'exact-target', clock.now() + 10000, { ...clock, diagnostics,
    read: async () => stampTarget(targetAt(275), clock.now),
    keyRead: () => ++reads === 1 ? stampTarget(targetAt(275), clock.now) : new Promise(() => {}),
  }), error => error === original);
  const step = diagnostics.records[0].keys[0];
  assert.equal(keys, 1); assert.equal(reads, 2); assert.equal(step.boundary, 'press');
  assert.equal(step.afterTimedOut, true); assert.equal(step.afterTimeoutMs, TASK_GATE_DIAGNOSTIC_LIMITS.keyReadMs);
});

test('the counter uses the same guarded fine list key but still requires its own painted-text proof after settlement', async () => {
  const targetAt = await r2ScrollTarget(), clock = settlementClock(), diagnostics = createTaskGateDiagnostics();
  const proof = await observeTaskGateLimit(limitPaintDom().h, identity()); let scroll = 275, keys = 0, counterReads = 0;
  const selector = `${taskGateRowSelector(identity())} [data-testid="chat-task-answer-limit"]`;
  const targetRead = async () => stampTarget({ ...targetAt(scroll), selector }, clock.now);
  const result = await readTaskGateLimit({ press: async (key, target) => {
    assert.equal(key, 'ArrowDown'); assert.equal(target, '[data-testid="chat-task-list"]');
    assert.equal(clock.elapsed(), 240); keys++; scroll += 40;
  } }, identity(), clock.now() + 10000, { ...clock, diagnostics, targetRead, keyRead: targetRead,
    read: async () => { counterReads++; return scroll === 275
      ? { ...proof, fragments: [{ ...proof.fragments[0], clipped: true }], scrollDirection: 'PageDown' } : proof; },
  });
  assert.equal(result.proof, proof); assert.equal(keys, 1); assert.equal(counterReads, 2); assert.equal(clock.elapsed(), 480);
  assert.equal(diagnostics.records[0].keys[0].boundary, 'press');
});

test('settlement requires a 240ms unchanged window and resets on every intermediate target, parent or scroll change', async () => {
  for (const change of [
    value => { value.rect.y += .01; },
    value => { value.diagnostics.target.rect.bottom += .01; },
    value => { value.diagnostics.ancestors[1].clientRect.bottom += .01; },
    value => { value.diagnostics.ancestors[1].rect.top += .01; },
    value => { value.diagnostics.scrollTarget.element.scrollTop += .01; },
    value => { value.diagnostics.closestList.scrollHeight++; },
  ]) {
    const base = await settlementTarget(), clock = settlementClock(), record = {};
    const result = await waitTaskGateTargetSettled({}, 'exact-target', clock.now() + 10000, { ...clock, record,
      read: async () => { const value = stampTarget(base, clock.now); if (clock.elapsed() === 80) change(value); return value; } });
    assert.deepEqual(result, stampTarget(base, clock.now));
    assert.equal(clock.elapsed(), 360, 'returning to the initial geometry at 120ms must restart, not reuse the initial window');
    assert.equal(record.settlements[0].resets, 2); assert.equal(record.settlements[0].stableMs, 240);
    assert.equal(record.settlements[0].status, 'settled');
  }
});

test('room/camera/viewport and exact target identity changes fail before input; incomplete geometry cannot be called stable', async () => {
  for (const change of [
    value => { value.diagnostics.scope.roomId = 'foreign-room'; },
    value => { value.diagnostics.scope.camera.zoom += .01; },
    value => { value.diagnostics.scope.camera.pan.x++; },
    value => { value.diagnostics.viewport.width++; },
    value => { value.diagnostics.rowIdentity.gateId = 'foreign-gate'; },
    value => { value.diagnostics.target.identity.choiceId = 'other'; },
    value => { value.selector = 'foreign-target'; },
    value => { value.diagnostics.ancestorsTruncated = true; },
    value => { value.diagnostics.target = null; },
    value => { value.diagnostics.ancestors[0].clientRect.bottom = null; },
    value => { value.diagnostics.scrollTarget.isClosestList = false; },
  ]) {
    const base = await settlementTarget(), clock = settlementClock();
    await assert.rejects(readyTaskGateTarget(new Proxy({}, { get: () => assert.fail('no input on scope/evidence failure') }),
      'exact-target', clock.now() + 10000, { ...clock, read: async () => {
        const value = stampTarget(base, clock.now); if (clock.elapsed() >= 80) change(value); return value;
      } }), /Task target did not settle before input/);
    assert.equal(clock.elapsed(), 80);
  }
});

test('continued motion, insufficient remaining window and a hung stability read fail clearly without native input', { timeout: 2000 }, async () => {
  const base = await settlementTarget();
  for (const remainingMs of [10000, 200]) {
    const clock = settlementClock(), diagnostics = createTaskGateDiagnostics();
    await assert.rejects(readyTaskGateTarget(new Proxy({}, { get: () => assert.fail('no action before settlement') }),
      'exact-target', clock.now() + remainingMs, { ...clock, diagnostics, read: async () => {
        const value = stampTarget(base, clock.now);
        if (remainingMs === 10000) value.diagnostics.scrollTarget.element.scrollTop += clock.elapsed() / 1000;
        return value;
      } }), /Task target did not settle before input/);
    assert.equal(clock.elapsed(), Math.min(remainingMs, TASK_GATE_SETTLEMENT.timeoutMs));
    assert.equal(diagnostics.records[0].keys.length, 0);
    assert.equal(diagnostics.records[0].settlements[0].status, 'failed');
  }
  await assert.rejects(waitTaskGateTargetSettled({}, 'exact-target', Date.now() + 30,
    { read: () => new Promise(() => {}) }), /Task target did not settle before input.*observation timed out/);
});

test('late settlement read completion cannot overwrite a frozen timeout record or permit native input', { timeout: 2000 }, async () => {
  const base = await settlementTarget(), diagnostics = createTaskGateDiagnostics(); let finishRead;
  await assert.rejects(readyTaskGateTarget(new Proxy({}, { get: () => assert.fail('no late input') }), 'exact-target', Date.now() + 30,
    { diagnostics, read: () => new Promise(resolve => { finishRead = resolve; }) }), /Task target did not settle before input/);
  const frozen = JSON.stringify(diagnostics);
  finishRead(base);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(diagnostics), frozen);
  assert.equal(diagnostics.records[0].samples, 0); assert.equal(diagnostics.records[0].keys.length, 0);
});

test('review reproduction: a third screen sample captured near 83ms but delivered 210ms later cannot turn delivery delay into a stable window', { timeout: 2000 }, async () => {
  const base = await settlementTarget(), record = {}, capturedAt = []; let reads = 0;
  await assert.rejects(waitTaskGateTargetSettled({}, 'exact-target', Date.now() + 1500, { record, read: async () => {
    const sample = stampTarget(base); capturedAt.push(sample.diagnostics.observedAt); reads++;
    if (reads === 3) await new Promise(resolve => setTimeout(resolve, 210)); // simulated transport, not a UI wait
    return sample;
  } }), /observation is stale/);
  assert.equal(reads, 3); assert.ok(capturedAt[2] - capturedAt[0] < TASK_GATE_SETTLEMENT.windowMs);
  assert.ok(record.settlements[0].stableMs < TASK_GATE_SETTLEMENT.windowMs);
  assert.equal(record.settlements[0].status, 'failed');
});

test('screen-time coverage gaps reset the window even if every delivered frame is fresh and equal', async () => {
  const base = await settlementTarget(), start = Date.now(); let elapsed = 0, reads = 0;
  const record = {};
  await waitTaskGateTargetSettled({}, 'exact-target', start + 2000, { record, now: () => start + elapsed,
    read: async () => stampTarget(base, () => start + elapsed),
    wait: async (_h, read, accept) => {
      for (const time of [0, 40, 240, 280, 320, 360, 400, 440, 480]) {
        elapsed = time; reads++; if (accept(await read())) return base;
      }
      assert.fail('continuous source-time window should eventually settle');
    } });
  assert.equal(elapsed, 480); assert.equal(reads, 9);
  assert.equal(record.settlements[0].resets, 1); assert.equal(record.settlements[0].stableMs, 240);
});

test('review reproduction: room changed during counter read or only in before-key read is rejected before PageDown using real default waits/guards', { timeout: 3000 }, async () => {
  const proof = await observeTaskGateLimit(limitPaintDom().h, identity());
  for (const changeAt of ['counter', 'key-read']) {
    const base = await settlementTarget(), diagnostics = createTaskGateDiagnostics();
    base.selector = `${taskGateRowSelector(identity())} [data-testid="chat-task-answer-limit"]`;
    let room = 'local-original', keys = 0, counterReads = 0, keyReads = 0;
    await assert.rejects(readTaskGateLimit({ scrollWithKey: async () => { keys++; } }, identity(), Date.now() + 1500, {
      diagnostics, targetRead: async () => stampTarget(base),
      read: async () => {
        counterReads++; if (changeAt === 'counter') room = 'foreign-room';
        return { ...proof, fragments: [{ ...proof.fragments[0], clipped: true }], scrollDirection: 'PageDown' };
      },
      keyRead: async () => {
        keyReads++; if (changeAt === 'key-read') room = 'foreign-room';
        const sample = stampTarget(base); sample.diagnostics.scope.roomId = room; return sample;
      },
    }), /changed room, camera or viewport/);
    assert.equal(keys, 0); assert.equal(counterReads, 1); assert.equal(keyReads, 1);
    const record = diagnostics.records[0];
    assert.equal(record.keys.length, 0); assert.equal(record.finalGuard.status, 'failed');
    assert.equal(record.finalGuard.last.diagnostics.scope.roomId, 'foreign-room');
  }
});

test('the final guard rejects new movement and a stale or deadline-expired sample without permitting a click or key', { timeout: 3000 }, async () => {
  const base = await settlementTarget();
  for (const mode of ['movement', 'stale']) {
    let clicks = 0, keys = 0;
    await assert.rejects((async () => {
      await readyTaskGateTarget({ scrollWithKey: async () => { keys++; } }, 'exact-target', Date.now() + 1500, {
        read: async () => stampTarget(base), keyRead: async () => {
          const value = stampTarget(base);
          if (mode === 'movement') value.diagnostics.target.rect.y++;
          else value.diagnostics.observedAt -= 200;
          return value;
        },
      });
      clicks++;
    })(), mode === 'movement' ? /changed after settlement/ : /observation is stale/);
    assert.equal(clicks, 0); assert.equal(keys, 0);
  }
  await assert.rejects(guardTaskGateTargetBeforeInput({}, 'exact-target', stampTarget(base), Date.now() + 25,
    { read: () => new Promise(() => {}) }), /observation timed out/);
});

test('default guarded path preserves native exceptions despite a hung after-read and refuses a hung before-key guard', { timeout: 3000 }, async () => {
  const base = await settlementTarget({ clipped: true, scrollDirection: 'PageDown' });
  for (const stuckBefore of [false, true]) {
    const diagnostics = createTaskGateDiagnostics(), original = new Error('original native error'); let keys = 0, keyReads = 0;
    const promise = readyTaskGateTarget({ scrollWithKey: async () => { keys++; throw original; } }, 'exact-target',
      Date.now() + (stuckBefore ? 450 : 1500), { diagnostics, read: async () => stampTarget(base), keyRead: () => {
        keyReads++;
        return !stuckBefore && keyReads === 1 ? Promise.resolve(stampTarget(base)) : new Promise(() => {});
      } });
    if (stuckBefore) {
      await assert.rejects(promise, /observation timed out/); assert.equal(keys, 0); assert.equal(keyReads, 1);
      assert.equal(diagnostics.records[0].finalGuard.status, 'failed');
    } else {
      await assert.rejects(promise, error => error === original); assert.equal(keys, 1); assert.equal(keyReads, 2);
      assert.equal(diagnostics.records[0].keys[0].afterTimedOut, true);
    }
  }
});

function cameraSample(camera, now = Date.now) {
  return { observedAt: now(), roomId: 'thread-dm-suqlb75', viewport: { width: 600, height: 600 }, camera };
}
const openChatGoal = () => ({ zoomTarget: .9636363636363636, panTarget: { x: -405.1090909090909, y: -613 } });

test('explicit openChat convergence from the actual 600 failure waits read-only for fixed-target rest before strict readiness starts', async () => {
  const clock = settlementClock(), evidence = {}, goal = openChatGoal();
  const before = cameraSample({ zoom: .5, zoomTarget: .5, pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 } }, clock.now);
  const cameras = [
    { ...goal, zoom: .7304470630731107, pan: { x: -226.6716797216489, y: -347.7186947438335 } },
    { ...goal, zoom: .8963105464885565, pan: { x: -359.86583249974035, y: -545.7372518744588 } },
    { ...goal, zoom: goal.zoomTarget, pan: { ...goal.panTarget } },
  ];
  const final = await waitTaskGateOpenChatCamera(new Proxy({}, { get: () => assert.fail('camera wait has no native actions') }), before,
    clock.now() + 10000, { ...clock, evidence, read: async () => cameraSample(cameras[Math.min(2, clock.elapsed() / 40)], clock.now) });
  assert.equal(clock.elapsed(), 320); assert.deepEqual(final.camera, cameras[2]);
  assert.equal(evidence.openChatCamera.stableMs, 240); assert.equal(evidence.openChatCamera.status, 'settled');
  const source = runTaskGateFlow.toString();
  assert.ok(source.indexOf('const beforeOpenChat =') < source.indexOf('await openChat(harness)'));
  assert.ok(source.indexOf('await openChat(harness)') < source.indexOf('await waitTaskGateOpenChatCamera('));
  assert.ok(source.indexOf('await waitTaskGateOpenChatCamera(') < source.indexOf("await click('.egd-codex-conversation-back')"));
  assert.equal(source.split('await waitTaskGateOpenChatCamera(').length - 1, 1);
  assert.doesNotMatch(source.slice(source.indexOf('const rejectedUi ='), source.indexOf('// Change identity while')), /waitTaskGateOpenChatCamera/);
});

test('openChat allowance rejects room/viewport changes, retargeting, reversal and overshoot instead of silently rebasing', async () => {
  for (const change of [
    value => { value.roomId = 'foreign-room'; }, value => { value.viewport.width = 800; },
    value => { value.camera.zoomTarget = 1.5; }, value => { value.camera.panTarget.x = -900; },
    value => { value.camera.pan.x = -100; }, value => { value.camera.pan.x = -450; },
  ]) {
    const clock = settlementClock(), evidence = {};
    const camera = { ...openChatGoal(), zoom: .7, pan: { x: -200, y: -300 } };
    const before = cameraSample(camera, clock.now);
    await assert.rejects(waitTaskGateOpenChatCamera({}, before, clock.now() + 10000, { ...clock, evidence,
      read: async () => { const value = cameraSample(structuredClone(camera), clock.now); if (clock.elapsed() >= 40) change(value); return value; },
    }), /Explicit openChat camera did not settle/);
    assert.equal(clock.elapsed(), 40); assert.equal(evidence.openChatCamera.status, 'failed');
  }
});

test('near-target openChat motion still resets the observation window; a camera stalled away from its target times out', async () => {
  for (const stalled of [false, true]) {
    const clock = settlementClock(), goal = openChatGoal(), evidence = {};
    const camera = { ...goal, zoom: goal.zoomTarget - .001, pan: { ...goal.panTarget } };
    const promise = waitTaskGateOpenChatCamera({}, cameraSample(camera, clock.now), clock.now() + 10000, { ...clock, evidence,
      read: async () => cameraSample({ ...camera, zoom: stalled ? .5 : goal.zoomTarget - [0.001, 0.0005, 0][Math.min(2, clock.elapsed() / 40)] }, clock.now),
    });
    if (stalled) { await assert.rejects(promise, /did not settle/); assert.equal(clock.elapsed(), 5000); }
    else { await promise; assert.equal(clock.elapsed(), 320); assert.equal(evidence.openChatCamera.resets, 2); }
  }
});

test('ready ignores momentarily fullbox/9hit paint after a key and settles before choosing the next key or permitting a click', async () => {
  const base = await settlementTarget(), clock = settlementClock(), diagnostics = createTaskGateDiagnostics(), actions = [];
  let phase = 0, keyAt = 0;
  const input = async (selector, key) => {
    assert.equal(selector, '[data-testid="chat-task-list"]');
    actions.push([key, clock.elapsed()]); phase++; keyAt = clock.elapsed(); return { key, moved: true };
  };
  const h = { scrollWithKey: input, press: (key, selector) => input(selector, key) };
  const read = async () => {
    const value = stampTarget(base, clock.now);
    if (phase === 0) Object.assign(value, { clipped: true, scrollDirection: 'PageDown' });
    else if (phase === 1 && clock.elapsed() - keyAt >= 120) Object.assign(value, { clipped: true, scrollDirection: 'PageUp' });
    return value;
  };
  await readyTaskGateTarget(h, 'exact-target', clock.now() + 10000,
    { ...clock, diagnostics, read, keyRead: read });
  actions.push(['click-permitted', clock.elapsed()]);
  assert.deepEqual(actions, [['PageDown', 240], ['ArrowUp', 600], ['click-permitted', 840]]);
  assert.deepEqual(diagnostics.records[0].settlements.map(value => value.stableMs), [240, 240, 240]);
  assert.equal(diagnostics.records[0].settlements[1].resets, 1);
});

test('settlement spans native keys with the same room/camera binding and never exceeds six keys or relaxes fullbox+9hit', async () => {
  const base = await settlementTarget();
  for (const mode of ['six-keys', 'camera-after-key', 'clipped-nine', 'eight-hits', 'disabled', 'outside']) {
    const clock = settlementClock(), diagnostics = createTaskGateDiagnostics(); let keys = 0;
    const h = { scrollWithKey: async () => { keys++; return { moved: true }; } };
    const read = async () => {
        const value = stampTarget(base, clock.now);
        if (mode === 'six-keys' || mode === 'camera-after-key') Object.assign(value, { clipped: true, scrollDirection: 'PageDown' });
        if (mode === 'camera-after-key' && keys) value.diagnostics.scope.camera.pan.y++;
        if (mode === 'clipped-nine') value.clipped = true;
        if (mode === 'eight-hits') value.hits = 8;
        if (mode === 'disabled') value.disabled = true;
        if (mode === 'outside') value.inside = false;
        return value;
      };
    await assert.rejects(readyTaskGateTarget(h, 'exact-target', clock.now() + 20000,
      { ...clock, diagnostics, keyRead: read, read }), /Task target did not settle before input/);
    assert.equal(keys, mode === 'six-keys' ? 6 : mode === 'camera-after-key' ? 1 : 0);
    assert.ok(diagnostics.records[0].settlements.length <= 7);
    if (mode === 'six-keys') assert.equal(diagnostics.records[0].settlements.length, 7);
  }
});

test('fixture wait failure preserves the last bounded scalar snapshot without another read or response-body/answer leakage', async () => {
  const original = new Error('fixture predicate timeout'), evidence = {}; let reads = 0;
  const sensitive = 'DO-NOT-COPY-ANSWER';
  const pending = state({ requests: [post(identity(), null, { delegated: false, request: { ...identity(), answer: { text: sensitive } } })],
    fakeProviderTurns: [{ output: sensitive }, {}], persisted: { answers: [{ text: sensitive }] } });
  await assert.rejects(waitTaskGateFixtureState({}, async () => { reads++; return pending; }, value => value.requests.at(-1)?.status === 200,
    Date.now() + 10000, evidence, { wait: async (_h, read, accept) => {
      for (let i = 0; i < 3; i++) assert.equal(accept(await read()), false);
      throw original;
    } }), error => error === original);
  assert.equal(reads, 3); assert.equal(evidence.fixtureWaitFailure.samples, 3);
  assert.equal(evidence.fixtureWaitFailure.last, evidence.lastFixtureState);
  const last = evidence.lastFixtureState;
  assert.equal(last.continuePostCount, 1); assert.equal(last.lastContinue.status, null);
  assert.equal(last.lastContinue.delegated, false); assert.equal(last.answerCount, 1); assert.equal(last.fakeProviderTurnCount, 2);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(sensitive));
  const absent = summarizeTaskGateFixture(state());
  assert.equal(absent.continuePostCount, 0); assert.equal(absent.lastContinue, null);
  const long = summarizeTaskGateFixture(state({ requests: [post(identity({ graphId: 'x'.repeat(10000) }), 400,
    { response: { code: 'TASK_GATE_ANSWER_PRIVATE', message: sensitive }, sequence: 2 })] }));
  assert.equal(long.lastContinue.status, 400); assert.equal(long.lastContinue.code, 'TASK_GATE_ANSWER_PRIVATE');
  assert.equal(long.lastContinue.graphId.length, 256); assert.ok(JSON.stringify(long).length < 1000);
  const noRead = {};
  await assert.rejects(waitTaskGateFixtureState({}, () => assert.fail('no catch-phase fetch'), () => false, 1, noRead,
    { wait: async () => { throw original; } }), error => error === original);
  assert.equal(noRead.fixtureWaitFailure.last, null); assert.equal(noRead.fixtureWaitFailure.samples, 0);
});

function limitPaintDom({ clipped = false, occluded = false, hidden = false, missing = false, offscreen = false } = {}) {
  const calls = [], rect = (left, top, width, height) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height });
  const list = { parentElement: null, scrollTop: 0, scrollHeight: 1000, clientHeight: 600, clientWidth: clipped ? 200 : 800,
    clientLeft: 0, clientTop: 0, offsetWidth: 800, offsetHeight: 600, localName: 'div', getAttribute: () => null,
    getBoundingClientRect: () => rect(0, 0, 800, 600) };
  const node = { isConnected: true, textContent: '21 / 20자 · 입력 후 계속을 누르세요.', dataset: { maxLength: '20', codePoints: '21' },
    parentElement: list, clientWidth: 300, clientHeight: 60, offsetWidth: 300, offsetHeight: 60, clientLeft: 0, clientTop: 0,
    localName: 'span', contains: () => false, getAttribute: name => name === 'data-testid' ? 'chat-task-answer-limit' : null,
    closest: selector => selector === '[data-testid="chat-task-list"]' ? list : null,
    getBoundingClientRect: () => rect(20, 20, 300, 60) };
  const rangeBox = rect(offscreen ? 790 : 20, 24, 280, 12);
  const context = { innerWidth: 800, innerHeight: 600,
    window: { __egdesk: { state: cameraState() } },
    getComputedStyle: target => ({ display: 'block', visibility: hidden ? 'hidden' : 'visible', opacity: '1',
      overflowX: target === list ? 'auto' : 'visible', overflowY: target === list ? 'auto' : 'visible' }),
    document: {
      querySelectorAll: () => [node],
      createRange: () => ({ selectNodeContents: selected => { assert.equal(selected, node); calls.push('Range text'); },
        getClientRects: () => missing ? [] : [rangeBox], detach() {} }),
      elementFromPoint: (x, y) => !occluded && x >= rangeBox.left && x <= rangeBox.right && y >= rangeBox.top && y <= rangeBox.bottom ? node : list,
    } };
  return { calls, h: { evaluateChrome: source => vm.runInNewContext(`(${source})()`, context) } };
}

test('Task R2 count label uses actual painted text while the stretched span remains a failed nine-point click target', async () => {
  const f = limitPaintDom();
  const element = await observeTaskGateTarget(f.h, 'exact-limit-span');
  assert.equal(element.hits, 3, 'reproduce the span whitespace hit mismatch');
  const proof = await observeTaskGateLimit(f.h, identity());
  assert.equal(proof.counted, 21); assert.equal(proof.limit, 20);
  assert.equal(proof.fragments.length, 1); assert.equal(proof.fragments[0].hitCount, 3);
  assert.equal(taskGateLimitReadable(proof), true);
  assert.deepEqual(f.calls, ['Range text']);
});

test('actual count text must have all line rectangles visible, in viewport, unclipped and unoccluded', async () => {
  for (const config of [{ clipped: true }, { occluded: true }, { hidden: true }, { missing: true }, { offscreen: true }]) {
    const f = limitPaintDom(config);
    assert.equal(taskGateLimitReadable(await observeTaskGateLimit(f.h, identity())), false);
  }
  const proof = await observeTaskGateLimit(limitPaintDom().h, identity());
  for (const patch of [{ count: 2 }, { text: '' }, { fragments: [] }, { fragments: [...proof.fragments,
    { ...proof.fragments[0], clipped: true }] }, { fragments: [{ ...proof.fragments[0], hitCount: 2 }] }]) {
    assert.equal(taskGateLimitReadable({ ...proof, ...patch }), false);
  }
});

test('fully visible 0/20 cannot pass with 21 actual input code points and matching 21-count datasets', async () => {
  const raw = '😀'.repeat(21), painted = await observeTaskGateLimit(limitPaintDom().h, identity());
  const current = ui({ value: raw, counted: 21, limitText: painted.text });
  assert.equal(assertTaskGateLimitPaint(painted, current, identity(), raw), true);
  const stale = { ...painted, text: '0 / 20자 · 입력 후 계속을 누르세요.' };
  assert.equal(taskGateLimitReadable(stale), true, 'visibility alone is deliberately insufficient');
  assert.throws(() => assertTaskGateLimitPaint(stale, { ...current, limitText: stale.text }, identity(), raw), /VISIBLE counter/);
  const wrongMaximum = { ...painted, limit: 200, text: '21 / 200자' };
  assert.throws(() => assertTaskGateLimitPaint(wrongMaximum, { ...current, limit: 200, limitText: wrongMaximum.text }, identity(), raw), /VISIBLE maximum/);
  assert.throws(() => assertTaskGateLimitPaint({ ...painted, fragments: [] }, current, identity(), raw), /painted/);
});

test('readable count metadata receives no native click or scroll; clipped text can use measured native list scrolling', async () => {
  const proof = await observeTaskGateLimit(limitPaintDom().h, identity());
  let calls = 0; const keys = [], h = { scrollWithKey: async (selector, key) => { keys.push([selector, key]); return { moved: true, key }; } };
  const deadlineMs = Date.now() + 10000;
  const first = await readTaskGateLimit(h, identity(), deadlineMs, { read: async () => proof, settle: unitLimitSettled, finalGuard: unitGuard });
  assert.equal(first.proof, proof); assert.deepEqual(keys, []);
  const scrolled = await readTaskGateLimit(h, identity(), deadlineMs, { settle: unitLimitSettled, finalGuard: unitGuard, read: async () => ++calls === 1
    ? { ...proof, fragments: [{ ...proof.fragments[0], clipped: true }], scrollDirection: 'PageDown' } : proof });
  assert.equal(scrolled.proof, proof);
  assert.deepEqual(keys, [['[data-testid="chat-task-list"]', 'PageDown']]);
});

test('existing counter PageUp/PageDown steps also retain bounded focus traces without using diagnostic paint to pass the counter', async () => {
  const proof = await observeTaskGateLimit(limitPaintDom().h, identity());
  for (const direction of ['PageUp', 'PageDown']) {
    const diagnostics = createTaskGateDiagnostics(), calls = [], before = readyTarget({ clipped: true }), after = readyTarget();
    let reads = 0, diagnosticReads = 0;
    const receipt = { key: direction, moved: false };
    const result = await readTaskGateLimit({ scrollWithKey: async (selector, key) => {
      calls.push(['native-key', selector, key]); return receipt;
    } }, identity(), Date.now() + 10000, { diagnostics, settle: unitLimitSettled, finalGuard: unitGuard,
      read: async () => { calls.push(['counter-read']); return ++reads === 1
        ? { ...proof, fragments: [{ ...proof.fragments[0], clipped: true }], scrollDirection: direction } : proof; },
      keyRead: async (_h, selector) => { calls.push(['diagnostic-read', selector]); return ++diagnosticReads === 1 ? before : after; },
    });
    const selector = `${taskGateRowSelector(identity())} [data-testid="chat-task-answer-limit"]`;
    assert.deepEqual(calls, [['counter-read'], ['diagnostic-read', selector], ['native-key', '[data-testid="chat-task-list"]', direction],
      ['diagnostic-read', selector], ['counter-read']]);
    assert.equal(result.proof, proof); assert.equal(result.scrolls[0], receipt);
    const record = diagnostics.records[0], step = record.keys[0];
    assert.equal(record.kind, 'limit'); assert.equal(record.status, 'readable'); assert.equal(record.samples, 2);
    assert.equal(step.before, before); assert.equal(step.after, after); assert.equal(step.receipt, receipt);
  }
});

test('counter decisions wait for actual target/parent/scroll settlement before each existing key and re-read the counter afterward', async () => {
  const proof = await observeTaskGateLimit(limitPaintDom().h, identity()), base = await settlementTarget();
  const clock = settlementClock(), diagnostics = createTaskGateDiagnostics(), actions = [];
  let keyAt = null;
  const selector = `${taskGateRowSelector(identity())} [data-testid="chat-task-answer-limit"]`;
  base.selector = selector;
  const targetRead = async () => {
      const value = stampTarget(base, clock.now);
      if (keyAt !== null) value.diagnostics.scrollTarget.element.scrollTop += Math.min(clock.elapsed() - keyAt, 160);
      return value;
    };
  const result = await readTaskGateLimit({ scrollWithKey: async (_selector, key) => {
    actions.push([key, clock.elapsed()]); keyAt = clock.elapsed(); return { key, moved: true };
  } }, identity(), clock.now() + 10000, { ...clock, diagnostics, targetRead,
    read: async () => {
      actions.push(['counter-read', clock.elapsed()]);
      return keyAt === null ? { ...proof, fragments: [{ ...proof.fragments[0], clipped: true }], scrollDirection: 'PageDown' } : proof;
    },
    keyRead: targetRead,
  });
  assert.deepEqual(actions, [['counter-read', 240], ['PageDown', 240], ['counter-read', 640]]);
  assert.equal(result.proof, proof); assert.equal(result.scrolls.length, 1);
  assert.equal(diagnostics.records[0].settlements.length, 2);
  assert.equal(diagnostics.records[0].settlements[1].resets, 4);
});

test('never-resolving before-key counter diagnostics time out once without replacing policy reads or adding native actions', { timeout: 2000 }, async () => {
  const proof = await observeTaskGateLimit(limitPaintDom().h, identity()), diagnostics = createTaskGateDiagnostics(), calls = [];
  let reads = 0, diagnosticReads = 0;
  const result = await readTaskGateLimit({ scrollWithKey: async (_selector, key) => {
    calls.push(key); return { key, moved: false };
  } }, identity(), Date.now() + 10000, { diagnostics, settle: unitLimitSettled, finalGuard: unitGuard,
    read: async () => { calls.push('counter-read'); return ++reads === 1
      ? { ...proof, fragments: [{ ...proof.fragments[0], clipped: true }], scrollDirection: 'PageDown' } : proof; },
    keyRead: () => {
      calls.push('diagnostic-read');
      return ++diagnosticReads === 1 ? new Promise(() => {}) : Promise.resolve(readyTarget());
    },
  });
  assert.deepEqual(calls, ['counter-read', 'diagnostic-read', 'PageDown', 'diagnostic-read', 'counter-read']);
  assert.equal(result.proof, proof); assert.equal(result.scrolls.length, 1);
  const record = diagnostics.records[0], step = record.keys[0];
  assert.equal(record.status, 'readable'); assert.equal(record.keys.length, 1);
  assert.equal(step.before, null); assert.equal(step.beforeTimedOut, true); assert.equal(step.beforeTimeoutMs, 250);
  assert.match(step.beforeError, /Diagnostic read timed out/); assert.equal(step.after.hits, 9);
  assert.equal(step.invoked, true); assert.equal(step.status, 'returned');
});

test('a before-key diagnostic that consumes the remaining deadline prevents native input and skips the after-read', { timeout: 2000 }, async () => {
  const proof = await observeTaskGateLimit(limitPaintDom().h, identity()), diagnostics = createTaskGateDiagnostics();
  let diagnosticReads = 0;
  await assert.rejects(readTaskGateLimit({ scrollWithKey: () => assert.fail('no key after deadline') }, identity(), Date.now() + 40,
    { diagnostics, settle: unitLimitSettled, finalGuard: unitGuard, read: async () => ({ ...proof, fragments: [{ ...proof.fragments[0], clipped: true }], scrollDirection: 'PageDown' }),
      keyRead: () => { diagnosticReads++; return new Promise(() => {}); } }));
  const record = diagnostics.records[0], step = record.keys[0];
  assert.equal(diagnosticReads, 1); assert.equal(record.status, 'failed'); assert.equal(record.keys.length, 1);
  assert.equal(step.beforeTimedOut, true); assert.ok(step.beforeTimeoutMs > 0 && step.beforeTimeoutMs <= 40);
  assert.equal(step.invoked, false); assert.equal(step.afterSkipped, 'deadline reached'); assert.equal(step.after, null);
});

test('count text occlusion cannot be waived or fixed by blind scrolling, and expired reads do nothing', async () => {
  const proof = await observeTaskGateLimit(limitPaintDom({ occluded: true }).h, identity());
  const h = { scrollWithKey: () => assert.fail('no scroll direction was observed') };
  const wait = async (_h, read, accept) => { assert.equal(accept(await read()), false); throw new Error('text still occluded'); };
  await assert.rejects(readTaskGateLimit(h, identity(), Date.now() + 10000, { read: async () => proof, wait, settle: unitLimitSettled, finalGuard: unitGuard }), /text still occluded/);
  await assert.rejects(readTaskGateLimit(h, identity(), 1, { read: () => assert.fail('expired observation') }));
});

function failurePaintDom({ clippedButton, clippedText = false, ownTextScroll = false, clippedError = false, occludedError = false, hiddenError = false, missingCancel = false,
  missingQuestion = false, wrongQuestion = false, clippedQuestion = false, occludedQuestion = false, hiddenQuestion = false } = {}) {
  const current = ui({ notice: '개인 정보가 포함되어 있습니다.\n해당 값을 빼고 다시 답해 주세요.' });
  const calls = [], rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
  const makeNode = (box, extra = {}) => ({ isConnected: true, parentElement: null,
    offsetWidth: box.width, offsetHeight: box.height, clientWidth: box.width, clientHeight: box.height,
    clientLeft: 0, clientTop: 0, closest: () => null, contains: () => false, getAttribute: () => null,
    getBoundingClientRect: () => box, ...extra });
  const main = makeNode(rect(0, 0, 800, 600));
  const composer = makeNode(rect(100, 565, 400, 30), { parentElement: main, dataset: { threadId: current.threadId }, disabled: false });
  main.querySelectorAll = selector => selector === '[data-testid="chat-composer"]' ? [composer] : [];
  const list = makeNode(rect(0, 0, 800, 560), { parentElement: main });
  const row = makeNode(rect(0, 0, 800, 560), { parentElement: list, dataset: current,
    closest: selector => selector === '.egd-codex-chat-main' ? main : null });
  const parts = Object.fromEntries(['question', 'next', 'text', 'notice', 'errorQuestion', 'continue', 'cancel'].map(key => {
    const box = ['continue', 'cancel'].includes(key)
      ? rect(key === 'continue' ? 100 : 220, clippedButton === key ? 543 : 500, 100, clippedButton === key ? 18 : 30)
      : key === 'errorQuestion' ? rect(100, clippedQuestion ? 543 : 160, 400, 24)
      : key === 'text' ? rect(100, clippedText ? 535 : 80, 400, clippedText ? 28 : 40)
      : rect(100, 200, 400, 40);
    const text = key === 'errorQuestion' ? (wrongQuestion ? '다른 질문' : current.question) : current[key] || '';
    return [key, makeNode(box, { parentElement: row, textContent: text, value: key === 'text' ? current.value : undefined, disabled: false,
      ...(key === 'text' && ownTextScroll ? { clientLeft: 1, clientTop: 1, clientWidth: box.width - 2, clientHeight: box.height - 2 } : {}),
      getAttribute: name => key === 'errorQuestion' && name === 'title' ? text : key === 'errorQuestion' && name === 'tabindex' ? '0'
        : key === 'notice' && name === 'aria-label' ? `${current.question} · ${current.notice}` : null })];
  }));
  row.querySelectorAll = selector => {
    const key = Object.keys(parts).find(key => selector === `[data-testid="${TASK_GATE_SELECTORS[key]}"]`);
    return key && !(key === 'cancel' && missingCancel) && !(key === 'errorQuestion' && missingQuestion) ? [parts[key]] : [];
  };
  row.querySelector = () => null;
  const lines = [rect(100, 202, 300, 14), rect(100, clippedError ? 554 : 218, 300, 14)];
  const questionLine = rect(100, clippedQuestion ? 545 : 162, 250, 14);
  const contains = (box, x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  const context = { innerWidth: 800, innerHeight: 600, window: { __egdesk: { state: { codex: { activeThreadId: current.threadId } } } },
    getComputedStyle: node => ({ display: 'block', visibility: 'visible',
      opacity: hiddenError && node === parts.notice || hiddenQuestion && node === parts.errorQuestion ? '0' : '1',
      overflowX: node === list || ownTextScroll && node === parts.text ? 'auto' : 'visible',
      overflowY: node === list || ownTextScroll && node === parts.text ? 'auto' : 'visible' }),
    document: {
      querySelectorAll: selector => { assert.equal(selector, taskGateRowSelector(identity())); return [row]; },
      createRange: () => { let selected; return { selectNodeContents: node => {
        assert.ok(node === parts.notice || node === parts.errorQuestion); selected = node;
        calls.push(node === parts.notice ? 'full-error-range' : 'question-range');
      }, getClientRects: () => selected === parts.notice ? lines : [questionLine], detach() {} }; },
      elementFromPoint: (x, y) => {
        if (contains(composer.getBoundingClientRect(), x, y)) return composer;
        if (y > 560 || x < 0 || x > 800) return list;
        for (const key of ['text', 'continue', 'cancel']) if (contains(parts[key].getBoundingClientRect(), x, y)) return parts[key];
        if (!occludedQuestion && contains(questionLine, x, y)) return parts.errorQuestion;
        return !occludedError && lines.some(box => contains(box, x, y)) ? parts.notice : list;
      },
    } };
  const noInput = () => assert.fail('post-error proof must never scroll, focus, click or replay input');
  const h = { evaluateChrome: source => { calls.push('single-read'); return vm.runInNewContext(`(${source})()`, context); },
    scrollWithKey: noInput, wheelAt: noInput, click: noInput, clickPoint: noInput, press: noInput };
  return { h, current, typed: { ...current, notice: '' }, calls };
}

test('post-error proof reads full multiline error and both nine-hit buttons in one immutable observation', async () => {
  const f = failurePaintDom(), proof = await observeTaskGateFailurePaint(f.h, identity());
  assert.equal(assertTaskGateFailurePaint(proof, f.typed, f.current, identity(), f.current.threadId), true);
  assert.equal(proof.notice.fragments.length, 2); assert.equal(proof.continue.hits, 9); assert.equal(proof.cancel.hits, 9);
  assert.equal(proof.errorQuestion.text, identity().label); assert.equal(proof.errorQuestion.fragments[0].hitCount, 3);
  assert.deepEqual(f.calls, ['single-read', 'full-error-range', 'question-range']);
});

test('R7 counterexample: full error visible and nine hits cannot excuse a clipped Continue or Cancel edge', async () => {
  for (const clippedButton of ['continue', 'cancel']) {
    const f = failurePaintDom({ clippedButton }), proof = await observeTaskGateFailurePaint(f.h, identity());
    assert.equal(taskGateLimitReadable(proof.notice), true, 'full error is genuinely visible');
    assert.equal(proof[clippedButton].inside, true, 'button is within the browser viewport');
    assert.equal(proof[clippedButton].hits, 9, 'all sample points can hit despite one clipped edge');
    assert.equal(proof[clippedButton].clipped, true, 'the containing form clips the full button box');
    assert.throws(() => assertTaskGateFailurePaint(proof, f.typed, f.current, identity(), f.current.threadId), new RegExp(`${clippedButton}: FULL`));
    assert.deepEqual(f.calls, ['single-read', 'full-error-range', 'question-range'], 'no second sample or recovery scroll');
  }
});

test('R6 counterexample: a visible error and actions do not excuse the clipped answer on the first paint', async () => {
  const f = failurePaintDom({ clippedText: true }), proof = await observeTaskGateFailurePaint(f.h, identity());
  assert.equal(taskGateLimitReadable(proof.notice), true);
  assert.equal(proof.continue.hits, 9); assert.equal(proof.cancel.hits, 9);
  assert.equal(proof.text.hits, 9); assert.equal(proof.text.clipped, true);
  assert.throws(() => assertTaskGateFailurePaint(proof, f.typed, f.current, identity(), f.current.threadId), /text: FULL/);
  assert.deepEqual(f.calls, ['single-read', 'full-error-range', 'question-range'], 'no recovery scroll before the assertion');
});

test('a textarea scrolls inside its own border without falsely clipping its fully visible outer box', async () => {
  const f = failurePaintDom({ ownTextScroll: true }), proof = await observeTaskGateFailurePaint(f.h, identity());
  assert.equal(proof.text.clipped, false); assert.equal(proof.text.hits, 9);
  assert.equal(assertTaskGateFailurePaint(proof, f.typed, f.current, identity(), f.current.threadId), true);
  const clipped = failurePaintDom({ ownTextScroll: true, clippedText: true });
  const rejected = await observeTaskGateFailurePaint(clipped.h, identity());
  assert.equal(rejected.text.clipped, true, 'the list ancestor still clips the actual border box');
  assert.throws(() => assertTaskGateFailurePaint(rejected, clipped.typed, clipped.current, identity(), clipped.current.threadId), /text: FULL/);
});

test('post-error proof rejects a clipped last error line, occlusion, hidden text, missing control or changed draft/question', async () => {
  for (const config of [{ clippedError: true }, { occludedError: true }, { hiddenError: true }, { missingCancel: true }]) {
    const f = failurePaintDom(config), proof = await observeTaskGateFailurePaint(f.h, identity());
    assert.throws(() => assertTaskGateFailurePaint(proof, f.typed, f.current, identity(), f.current.threadId));
    assert.deepEqual(f.calls, ['single-read', 'full-error-range', 'question-range']);
  }
  const f = failurePaintDom(), proof = await observeTaskGateFailurePaint(f.h, identity());
  for (const patch of [{ value: '' }, { notice: 'shortened error' }, { responseKey: 'other' }, { threadId: 'other' }]) {
    assert.throws(() => assertTaskGateFailurePaint({ ...proof, ui: { ...proof.ui, ...patch } }, f.typed, f.current, identity(), f.current.threadId));
  }
  for (const key of ['continue', 'cancel']) for (const patch of [{ hits: 8 }, { disabled: true }, { visible: false }, { count: 2 }, { selector: 'unrelated' }]) {
    assert.throws(() => assertTaskGateFailurePaint({ ...proof, [key]: { ...proof[key], ...patch } }, f.typed, f.current, identity(), f.current.threadId));
  }
});

test('post-error proof rejects a missing, wrong, clipped, hidden or occluded question title', async () => {
  for (const config of [{ missingQuestion: true }, { wrongQuestion: true }, { clippedQuestion: true }, { hiddenQuestion: true }, { occludedQuestion: true }]) {
    const f = failurePaintDom(config), proof = await observeTaskGateFailurePaint(f.h, identity());
    assert.throws(() => assertTaskGateFailurePaint(proof, f.typed, f.current, identity(), f.current.threadId));
    assert.equal(f.calls[0], 'single-read', 'no input or additional sample');
  }
  const f = failurePaintDom(), proof = await observeTaskGateFailurePaint(f.h, identity());
  assert.throws(() => assertTaskGateFailurePaint({ ...proof, notice: { ...proof.notice, accessibleLabel: f.current.notice } },
    f.typed, f.current, identity(), f.current.threadId));
  assert.throws(() => assertTaskGateFailurePaint({ ...proof, errorQuestion: { ...proof.errorQuestion, tabIndex: null } },
    f.typed, f.current, identity(), f.current.threadId));
});

test('long-title keyboard proof requires the actual last line painted and a focused scroller at its end', async () => {
  const f = failurePaintDom(), proof = await observeTaskGateFailurePaint(f.h, identity());
  assert.equal(assertTaskGateTitleEndPaint(proof, identity()), true);
  const clippedTail = structuredClone(proof);
  clippedTail.errorQuestion.fragments.push({ visible: false, hits: [], hitCount: 0 });
  assert.throws(() => assertTaskGateTitleEndPaint(clippedTail, identity()), /final actual title line/);
  assert.throws(() => assertTaskGateTitleEndPaint(proof, identity({ label: 'another title' })));
  const atEnd = { focused: true, scrollHeight: 200, clientHeight: 40, scrollTop: 160 };
  assert.equal(taskGateTitleAtEnd(atEnd), true);
  for (const patch of [{ focused: false }, { scrollTop: 100 }, { scrollHeight: 40 }, { scrollTop: null }]) {
    assert.equal(taskGateTitleAtEnd({ ...atEnd, ...patch }), false);
  }
});

// Native sequencing unit doubles only; these are not actual UI acceptance evidence.
function initialDesk({ focused = true, visible = false, reveal = true, browser = true,
  replaceBrowser = false, replaceContext = false, expired = false, delayReads = 0 } = {}) {
  const calls = []; let pressed = false, readsAfterPress = 0;
  const h = {
    async evaluateChrome(source) {
      calls.push(['read']);
      const exited = pressed && reveal && ++readsAfterPress > delayReads;
      const inFocus = focused && !exited;
      const card = browser ? Object.freeze({ id: pressed && replaceBrowser ? 'different-browser' : 'original-browser',
        _xulBrowser: Object.freeze({ browsingContext: Object.freeze({ id: pressed && replaceContext ? 22 : 11 }) }) }) : null;
      const api = Object.freeze({ state: Object.freeze({ cardFullscreen: inFocus && card ? Object.freeze({ cardId: card.id }) : null }),
        surface: Object.freeze({ snapshot: () => Object.freeze({ initialBrowserFocus: inFocus, browserCardId: card?.id ?? null }) }) });
      return vm.runInNewContext(`(${source})()`, { window: Object.freeze({ __egdesk: api }),
        document: Object.freeze({ getElementById: id => card?.id === id ? card : null }) });
    },
    async inspect(selector) {
      calls.push(['inspect', selector]);
      return [{ visible: visible || pressed && reveal && readsAfterPress > delayReads, disabled: false }];
    },
    async press(key) { calls.push(['native-key', key]); pressed = true; },
  };
  const options = { deadlineMs: 100, now: () => expired ? 101 : 1, readFirstUse: observeTaskGateDesk,
    waitUntil: async (read, accept, timing) => {
      assert.equal(timing.timeoutMs, 10000); assert.equal(timing.intervalMs, 100);
      for (let attempt = 0; attempt < 4; attempt++) { const value = await read(); if (accept(value)) return value; }
      throw new Error('native Desk never became ready');
    } };
  return { h, options, calls };
}

test('Task R1 first-use focus exits once before Dock access, waiting read-only for the native transition', async () => {
  const f = initialDesk({ delayReads: 2 });
  const proof = await prepareRunOutputDesk(f.h, f.options);
  assert.equal(proof.action, 'native first-use zoom-out');
  assert.equal(proof.before.initialBrowserFocus, true); assert.equal(proof.before.dockVisible, false);
  assert.equal(proof.after.initialBrowserFocus, false); assert.equal(proof.after.fullscreen, false);
  assert.equal(proof.after.dockVisible, true);
  assert.equal(proof.before.cardId, proof.after.cardId);
  assert.equal(proof.before.browserContextId, proof.after.browserContextId);
  assert.deepEqual(f.calls.filter(call => call[0] === 'native-key'), [['native-key', 'meta+-']]);
});

test('Task Desk observer handles null fullscreen and missing Browser; already-ready Desk needs no native input', async () => {
  for (const browser of [true, false]) {
    const f = initialDesk({ focused: false, visible: true, browser });
    const proof = await prepareRunOutputDesk(f.h, f.options);
    assert.equal(proof.action, 'already-ready'); assert.equal(proof.after.fullscreen, false);
    assert.equal(proof.after.cardId, browser ? 'original-browser' : null);
    assert.equal(proof.after.browserContextId, browser ? 11 : null);
    assert.equal(f.calls.some(call => call[0] === 'native-key'), false);
  }
});

test('Task initial Desk refuses hidden non-focus, ineffective exit, identity replacement and expiry without input replay', async () => {
  for (const config of [{ focused: false }, { reveal: false }, { replaceBrowser: true }, { replaceContext: true }, { expired: true }]) {
    const f = initialDesk(config);
    await assert.rejects(prepareRunOutputDesk(f.h, f.options));
    assert.equal(f.calls.filter(call => call[0] === 'native-key').length, config.focused === false || config.expired ? 0 : 1);
    if (config.expired) assert.equal(f.calls.length, 0);
  }
});

test('CLI/environment/deadline refusals happen before any harness or UI action', async () => {
  await assert.rejects(runCli(['--profile', '/not-a-profile', '--deadline-utc', '2000-01-01T00:00:00Z'], ENV));
  await assert.rejects(runTaskGateFlow({}, { profile: '/not-a-profile', deadlineMs: Date.now() + 10000, env: {} }));
});

test('Task viewport CLI is optional, accepts only the two exact sizes and rejects duplicate or invalid options', () => {
  const base = ['--profile', '/owned/profile', '--deadline-utc', '2026-10-26T01:00:00Z'], now = Date.parse('2026-10-26T00:00:00Z');
  assert.deepEqual(parseTaskGateCli(base, now), { profile: '/owned/profile', deadlineMs: Date.parse(base[3]) });
  for (const viewport of ['600x600', '800x600']) {
    assert.equal(parseTaskGateCli([...base, '--viewport', viewport], now).viewport, viewport);
    assert.equal(parseTaskGateCli(['--viewport', viewport, ...base], now).viewport, viewport);
  }
  for (const args of [['--viewport'], ['--viewport', '600X600'], ['--viewport', '600x601'], ['--viewport', '1366x768'],
    ['--viewport', '600x600', '--viewport', '800x600'], ['--viewport', '600x600', '--viewport', '600x600'],
    ['--viewport=600x600'], ['--unknown', '600x600']]) assert.throws(() => parseTaskGateCli([...base, ...args], now));
});

test('Task viewport setup resizes exactly once then verifies actual size; default performs no harness operation', async () => {
  for (const viewport of [undefined, '600x600', '800x600']) {
    const calls = [], deadlineMs = Date.now() + 10000;
    const proof = await prepareTaskGateViewport({}, viewport, deadlineMs, {
      resize: async (_h, size, deadline) => { calls.push('resize'); assert.equal(deadline, deadlineMs); return { requested: size }; },
      settle: async (_h, size, deadline, options) => {
        calls.push('settle'); assert.equal(deadline, deadlineMs); assert.equal(options.timeoutMs, 5000); return { ...size };
      },
    });
    assert.deepEqual(calls, viewport === undefined ? [] : ['resize', 'settle']);
    if (viewport === undefined) assert.equal(proof, null);
    else assert.deepEqual(proof.actual, { width: Number(viewport.split('x')[0]), height: 600 });
  }
});

test('Task viewport mismatch, timeout, invalid input and expiry stop without resize retry or native input', async () => {
  for (const mode of ['mismatch', 'timeout', 'invalid', 'expired']) {
    const calls = [], noInput = new Proxy({}, { get: () => assert.fail('no native input or recovery action') });
    await assert.rejects(prepareTaskGateViewport(noInput, mode === 'invalid' ? '0x0' : '600x600', mode === 'expired' ? 1 : Date.now() + 10000, {
      resize: async () => { calls.push('resize'); return {}; },
      settle: async () => { calls.push('settle'); if (mode === 'timeout') throw new Error('settle timeout'); return { width: 601, height: 600 }; },
    }));
    assert.deepEqual(calls, ['invalid', 'expired'].includes(mode) ? [] : ['resize', 'settle']);
  }
});

test('Task viewport setup is after the owned guard and before every existing native action, never in error proof', async () => {
  for (const connected of [true, false]) {
    const calls = [], result = {};
    const promise = runCaptureSection('  const guard = await observeGuard(harness);', '  const token =', {
      assert, harness: {}, result, viewport: '600x600', deadlineMs: 123,
      observeGuard: async () => { calls.push('guard'); return { headless: connected, mounted: true, loggedIn: true, accountBound: true }; },
      prepareTaskGateViewport: async () => { calls.push('resize-once-and-settle'); return { actual: { width: 600, height: 600 } }; },
    });
    if (connected) await promise; else await assert.rejects(promise);
    assert.deepEqual(calls, connected ? ['guard', 'resize-once-and-settle'] : ['guard']);
  }
  const source = runTaskGateFlow.toString();
  assert.equal(source.split('await prepareTaskGateViewport(').length - 1, 1);
  assert.ok(source.indexOf('await prepareTaskGateViewport(') < source.indexOf('await prepareRunOutputDesk('));
  assert.doesNotMatch(source.slice(source.indexOf('const rejectedUi ='), source.indexOf('// Change identity while')), /resize|scroll|focus|wheel|ready\(/i);
});

// Execute the actual checkpoint callsites with unit-only capture/input doubles.
// No screenshot, browser, fixture transport or provider is started here.
function runCaptureSection(start, end, context) {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-task-gate-flow.mjs', import.meta.url), 'utf8');
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'actual flow checkpoint boundaries exist');
  return vm.runInNewContext(`(async () => {\n${source.slice(from, to)}\n})()`, context);
}

test('initial-choice screenshot precedes the existing hold and only Continue, retaining its stage, receipt and original question', async () => {
  const proof = evidence().choice, trace = [], captured = { captures: [] };
  const screenshot = { path: '/owned/unit-only/task-gate-initial-choice-before-continue.png', method: 'unit-double' };
  await runCaptureSection("  await choose('kakao');", '  const whileHeld =', {
    choice: proof.identity, evidence: captured,
    choose: async id => trace.push(['choose', id]), read: async () => { trace.push(['read']); return proof.ui; },
    capture: async stage => { trace.push(['capture', stage]); return screenshot; },
    state: async () => { trace.push(['state']); return proof.before; },
    control: async action => trace.push(['control', action]), field: (_identity, name) => name,
    click: async selector => trace.push(['click', selector]),
  });
  assert.deepEqual(trace, [['choose', 'kakao'], ['read'], ['capture', 'task-gate-initial-choice-before-continue'],
    ['state'], ['control', 'hold-next'], ['click', 'continue']]);
  assert.equal(captured.captures.length, 1);
  const checkpoint = captured.captures[0];
  assert.equal(checkpoint.stage, 'initial-choice-before-continue');
  assert.equal(checkpoint.identity, proof.identity); assert.equal(checkpoint.ui, proof.ui);
  assert.equal(checkpoint.identity.label, proof.ui.question);
  assert.deepEqual(checkpoint.identity.response.options.map(option => option.id), ['email', 'kakao']);
  assert.equal(checkpoint.ui.choice, 'kakao'); assert.equal(checkpoint.ui.continueDisabled, false);
  assert.equal(checkpoint.screenshot, screenshot); assert.equal(checkpoint.screenshot.path, screenshot.path);
  assert.equal(checkpoint.visualReview, 'pending', 'unit receipt is not actual UI or visual approval');
});

test('failed intermediate choice capture stops before hold/Continue with no retry or false checkpoint', async () => {
  const proof = evidence().choice, captured = { captures: [] }; let captures = 0;
  await assert.rejects(runCaptureSection("  await choose('kakao');", '  const whileHeld =', {
    choice: proof.identity, evidence: captured, choose: async () => {}, read: async () => proof.ui,
    capture: async () => { captures++; throw new Error('capture failed'); },
    state: () => assert.fail('no later state read'), control: () => assert.fail('no hold'),
    field: () => assert.fail('no Continue target'), click: () => assert.fail('no Continue'),
  }), /capture failed/);
  assert.equal(captures, 1); assert.deepEqual(captured.captures, []);
});

test('same-question failure screenshot follows required retained-draft/error assertions and exposes the retry state', async () => {
  const proof = evidence().rejected, trace = [], captured = { captures: [], errorPaint: {} };
  const screenshot = { path: '/owned/unit-only/task-gate-same-question-text-failure.png', method: 'unit-double' };
  const context = {
    text: proof.identity, evidence: captured, rejectedBefore: proof.before, rejectedAfter: proof.after,
    typed: proof.typed, rejectedUi: proof.ui, refreshed: proof.refreshed,
    harness: {}, local: { id: 'local-original' },
    observeTaskGateFailurePaint: async () => { trace.push('observe-paint'); return failurePaint(proof.refreshed); },
    assertTaskGateFailurePaint: (...args) => { trace.push('assert-paint'); return assertTaskGateFailurePaint(...args); },
    assertDraftRetained: (...args) => { trace.push('assert-retained'); return assertDraftRetained(...args); },
    check: (label, passed) => { trace.push('check'); assert.equal(passed, true); assert.match(label, /retain draft and explanation/); },
    capture: async stage => { trace.push(stage); return screenshot; },
  };
  await runCaptureSection('  evidence.rejected =', '  // Change identity while', context);
  assert.deepEqual(trace, ['assert-retained', 'observe-paint', 'assert-paint', 'check', 'task-gate-same-question-text-failure']);
  const checkpoint = captured.captures[0];
  assert.equal(checkpoint.stage, 'same-question-text-failure'); assert.equal(checkpoint.identity, proof.identity);
  assert.equal(checkpoint.ui, proof.refreshed); assert.equal(checkpoint.ui.value, proof.typed.value);
  assert.ok(checkpoint.ui.notice); assert.equal(checkpoint.ui.continueDisabled, false);
  assert.equal(checkpoint.screenshot, screenshot); assert.equal(checkpoint.visualReview, 'pending');
  assert.equal(captured.errorPaint.beforeCapture.ui, proof.refreshed);
  for (const patch of [{ value: '' }, { notice: '' }, { responseKey: 'other-question' }, { threadId: 'other-room' }]) {
    trace.length = 0;
    const invalid = { ...context, evidence: { captures: [] }, refreshed: { ...proof.refreshed, ...patch } };
    await assert.rejects(runCaptureSection('  evidence.rejected =', '  // Change identity while', invalid));
    assert.deepEqual(trace, ['assert-retained'], 'lost answer/error/identity cannot be captured as the preserved failure');
    assert.deepEqual(invalid.evidence.captures, []);
  }
  for (const key of ['continue', 'cancel']) {
    trace.length = 0;
    const clipped = failurePaint(proof.refreshed); clipped[key].clipped = true;
    const invalid = { ...context, evidence: { captures: [], errorPaint: {} },
      observeTaskGateFailurePaint: async () => { trace.push('observe-paint'); return clipped; } };
    await assert.rejects(runCaptureSection('  evidence.rejected =', '  // Change identity while', invalid), new RegExp(`${key}: FULL`));
    assert.deepEqual(trace, ['assert-retained', 'observe-paint', 'assert-paint']);
    assert.equal(invalid.evidence.errorPaint.beforeCapture, clipped, 'failed paint evidence is retained');
    assert.deepEqual(invalid.evidence.captures, [], 'clipped buttons never produce a passed-state screenshot');
  }
});

test('first post-error clipped state fails before refresh or capture, with no wheel, scroll or input retry', async () => {
  const proof = evidence().rejected;
  for (const key of ['continue', 'cancel']) {
    const clipped = failurePaint(proof.ui); clipped[key].clipped = true;
    const captured = { errorPaint: {} }; let reads = 0;
    await assert.rejects(runCaptureSection('  evidence.errorPaint.initial =', '  const refreshed =', {
      evidence: captured, text: proof.identity, typed: proof.typed, rejectedUi: proof.ui, local: { id: 'local-original' },
      harness: new Proxy({}, { get: () => assert.fail('no native action in error proof') }),
      observeTaskGateFailurePaint: async () => { reads++; return clipped; }, assertTaskGateFailurePaint,
      state: () => assert.fail('fail before later fixture reads'), refresh: () => assert.fail('no refresh repair'),
      capture: () => assert.fail('no success capture'),
    }), new RegExp(`${key}: FULL`));
    assert.equal(reads, 1); assert.equal(captured.errorPaint.initial, clipped);
  }
});

test('intermediate captures retain all existing flow assertions and the final capture in their original order', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-task-gate-flow.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/await capture\('([^']+)'\)/g)].map(match => match[1]), [
    'task-gate-initial-choice-before-continue', 'task-gate-first-error-all-visible', 'task-gate-same-question-text-failure',
    'task-gate-long-question-focus', 'task-gate-long-question-end', 'task-gate-answer-flow',
  ]);
  let previous = -1;
  for (const required of [
    'assertQuestionIdentity(initialChoice, choice, local.id);',
    "await capture('task-gate-initial-choice-before-continue')",
    "await control('hold-next'); await click(field(choice, 'continue'));",
    'assertOneAnswer(choiceBefore, choiceAfter, choice);',
    'assertTaskGateFailurePaint(evidence.errorPaint.initial, typed, rejectedUi, text, local.id);',
    'assertDraftRetained(rejectedUi, refreshed, { notice: true });',
    'assertTaskGateFailurePaint(evidence.errorPaint.beforeCapture, typed, refreshed, text, local.id);',
    "await capture('task-gate-same-question-text-failure')",
    "await control('next-question');",
    'assertNewQuestionCleared(evidence.previousQuestion, emptyNext);',
    'assertOneAnswer(textBefore, textAfter, text);',
    'assertTaskGateStaleReconciled(evidence.stale, local.id);',
    'assertTaskGateEvidence(evidence);',
    "await capture('task-gate-answer-flow');",
  ]) {
    const at = source.indexOf(required, previous + 1);
    assert.ok(at > previous, `required assertion/stage remains ordered: ${required}`); previous = at;
  }
});

test('verifier delegates only native input and fixture controls, never directly POSTs a user task answer or fabricates DOM state', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-task-gate-flow.mjs', import.meta.url), 'utf8');
  assert.match(source, /runUiFlow\('firefox-mcp-task-gate-flow'/);
  assert.match(source, /press\('Enter'/);
  assert.match(source, /harness\.click\(field\(choice, 'continue'\)\)/, 'duplicate uses a second native click');
  assert.match(source, /replaceFieldText\(/);
  assert.match(source, /readFirstUse: observeTaskGateDesk, waitUntil/);
  assert.ok(source.indexOf('result.initialDesk = await prepareRunOutputDesk(') < source.indexOf('await openChat(harness)'),
    'first-use native exit and usable Dock proof must precede Chat Dock access');
  assert.doesNotMatch(source, /ready\(field\(text, 'limit'\)\)/, 'noninteractive metadata is not treated as a button');
  assert.match(source, /target\.hits === 9/); assert.match(source, /value\.hits === 9/, 'click controls keep all nine points');
  assert.match(source, /evidence\.stale\.after = staleAfter/);
  assert.match(source, /reconciledTaskGateRead\(value, next, rejectedSequence\)/);
  assert.doesNotMatch(source, /read\(next\), value => !!value\.notice/, 'do not require a transient stale error to outlive real reconciliation');
  assert.doesNotMatch(source, /loopbackJson\(['"]\/tasks\/continue/);
  assert.doesNotMatch(source, /dispatchEvent|new (?:KeyboardEvent|InputEvent)|\.value\s*=|innerHTML\s*=/);
  assert.doesNotMatch(source, /newQaThread\(/, 'that shared helper writes fixture metadata; this flow uses native creation and read-only identity');
});
