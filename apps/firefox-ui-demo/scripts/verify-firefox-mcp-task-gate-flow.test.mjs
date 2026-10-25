import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { TASK_GATE_SELECTORS, taskGateRowSelector, assertTaskGateEnvironment, assertQuestionIdentity, assertNoContinue,
  assertDraftRetained, assertNewQuestionCleared, assertCodePointLimit, assertOneAnswer, assertTaskGateEvidence,
  observeTaskGate, runTaskGateFlow, runCli } from './verify-firefox-mcp-task-gate-flow.mjs';

const ENV = { EGDESK_QA_TASK_GATE_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_REAL_TURN: '0',
  EGDESK_QA_FIXTURE_PORT: '49319', EGDESK_QA_FIXTURE_TOKEN: 'owned-task-gate-verifier-unit-token' };
const sha = value => createHash('sha256').update(value).digest('hex');
const identity = (extra = {}) => ({ graphId: 'graph-original', taskId: 'note', gateId: 'memo', label: '덧붙일 말', response: { kind: 'text', maxLength: 20 }, ...extra });
const ui = (extra = {}) => { const value = { count: 1, threadId: 'local-original', ...identity(),
  question: '덧붙일 말', next: '답변하면 메모를 반영합니다.', value: '답변', choice: null, notice: '',
  limit: 20, counted: 2, limitText: '2 / 20자', continueDisabled: false, ...extra };
  return { ...value, responseKey: extra.responseKey ?? JSON.stringify(['userAction', value.label, value.response]) }; };
const state = (extra = {}) => ({ requests: [], persisted: { answers: [] }, fakeProviderTurns: [], ...extra });
const post = (ids, status = 200, extra = {}) => ({ sequence: 1, method: 'POST', path: '/tasks/continue',
  delegated: true, status, request: { graphId: ids.graphId, taskId: ids.taskId, gateId: ids.gateId,
    answer: ids.response?.kind === 'choice' ? { choice: 'kakao' } : { textCodePoints: 20 } }, response: {}, ...extra });

// Assertion inputs ONLY. They are not fixture handler responses, a native
// browser run, screenshot evidence, or proof that Harvey's UI is implemented.
function evidence() {
  const choice = identity({ taskId: 'send', gateId: 'how', label: '어떻게 보낼까요?', response: { kind: 'choice',
    options: [{ id: 'email', label: '메일로' }, { id: 'kakao', label: '카카오톡으로' }] } });
  const text = identity(), next = identity({ graphId: 'graph-next', taskId: 'next-note', gateId: 'next-memo', label: '새 질문: 덧붙일 말', response: { kind: 'text', maxLength: 8 } });
  const value = '😀'.repeat(20), textUi = ui({ value, counted: 20, limitText: '20 / 20자' });
  const rejectedTyped = ui({ value: 'pw: hunter2', counted: 11 }), rejectedUi = { ...rejectedTyped, notice: '해당 값을 빼고 다시 답해 주세요.' };
  const nextUi = ui({ ...next, question: next.label, value: '', limit: 8, counted: 0, limitText: '0 / 8자' });
  const staleTyped = { ...nextUi, value: '다음 답변', counted: 5 }, staleUi = { ...staleTyped, notice: '이 조건은 이미 풀렸습니다.' };
  const before = state(), chosen = state({ requests: [post(choice)] });
  const rejected = state({ requests: [post(text, 400, { response: { code: 'TASK_GATE_ANSWER_PRIVATE' } })] });
  const written = state({ requests: [post(text)], persisted: { answers: [{ ...text, codePoints: 20, textSha256: sha(value) }] } });
  const stale = state({ requests: [post(next, 409, { response: { code: 'TASK_GATE_STALE' } })] });
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
    text: { identity: text, before, after: written, ui: textUi, value },
    previousQuestion: rejectedUi, newQuestion: nextUi,
    stale: { identity: next, before, after: stale, typed: staleTyped, ui: staleUi },
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
  const over = ui({ value: '😀'.repeat(21), counted: 21, continueDisabled: true });
  assert.equal(assertCodePointLimit(over, over.value, 20, { invalid: true }), true);
  assert.throws(() => assertCodePointLimit({ ...over, continueDisabled: false, notice: '' }, over.value, 20, { invalid: true }));
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
    proof => { proof.stale.ui.value = ''; }, proof => { proof.stale.after.requests[0].response.code = 'fake'; },
    proof => { proof.duplicate.afterAttempt.requests.push(post(identity())); }, proof => { proof.duplicate.disabled = false; },
    proof => { proof.duplicate.whileHeld.held = null; proof.duplicate.afterAttempt.held = null; },
    proof => { proof.choice.ui.choice = 'email'; }, proof => { proof.choice.ui.responseKey = '["wrong-question"]'; },
  ];
  for (const corrupt of corruptions) { const proof = evidence(); corrupt(proof); assert.throws(() => assertTaskGateEvidence(proof)); }
});

test('observation is bounded read-only chrome source; no input or DOM/state mutation occurs during reads', async () => {
  const sources = [], harness = { evaluateChrome(source) { sources.push(source); return Promise.resolve({ count: 0 }); } };
  await observeTaskGate(harness, identity());
  assert.equal(sources.length, 1); assert.ok(Buffer.byteLength(sources[0]) < 12000);
  for (const forbidden of [/dispatchEvent/, /new (?:InputEvent|KeyboardEvent|Event)\(/, /\.value\s*=/, /\.click\(/,
    /innerHTML\s*=/, /__egdesk[^\n]*\s=\s/, /\.style\s*[.=]/]) assert.doesNotMatch(sources[0], forbidden);
});

test('CLI/environment/deadline refusals happen before any harness or UI action', async () => {
  await assert.rejects(runCli(['--profile', '/not-a-profile', '--deadline-utc', '2000-01-01T00:00:00Z'], ENV));
  await assert.rejects(runTaskGateFlow({}, { profile: '/not-a-profile', deadlineMs: Date.now() + 10000, env: {} }));
});

test('verifier delegates only native input and fixture controls, never directly POSTs a user task answer or fabricates DOM state', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-task-gate-flow.mjs', import.meta.url), 'utf8');
  assert.match(source, /runUiFlow\('firefox-mcp-task-gate-flow'/);
  assert.match(source, /press\('Enter'/);
  assert.match(source, /harness\.click\(field\(choice, 'continue'\)\)/, 'duplicate uses a second native click');
  assert.match(source, /replaceFieldText\(/);
  assert.doesNotMatch(source, /loopbackJson\(['"]\/tasks\/continue/);
  assert.doesNotMatch(source, /dispatchEvent|new (?:KeyboardEvent|InputEvent)|\.value\s*=|innerHTML\s*=/);
  assert.doesNotMatch(source, /newQaThread\(/, 'that shared helper writes fixture metadata; this flow uses native creation and read-only identity');
});
