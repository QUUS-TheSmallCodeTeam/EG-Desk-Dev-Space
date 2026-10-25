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
  runTaskGateFlow, runCli } from './verify-firefox-mcp-task-gate-flow.mjs';

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
  ];
  for (const corrupt of corruptions) { const proof = evidence(); corrupt(proof); assert.throws(() => assertTaskGateEvidence(proof)); }
});

test('observation is bounded read-only chrome source; no input or DOM/state mutation occurs during reads', async () => {
  const sources = [], harness = { evaluateChrome(source) { sources.push(source); return Promise.resolve({ count: 0 }); } };
  await observeTaskGate(harness, identity());
  await observeTaskGateDesk(harness);
  await observeTaskGateTarget(harness, '[data-testid="chat-task-answer-continue"]');
  await observeTaskGateLimit(harness, identity());
  assert.equal(sources.length, 4);
  for (const source of sources) {
    assert.ok(Buffer.byteLength(source) < 12000);
    for (const forbidden of [/dispatchEvent/, /new (?:InputEvent|KeyboardEvent|Event)\(/, /\.value\s*=/, /\.click\(/,
      /innerHTML\s*=/, /__egdesk[^\n]*\s=\s/, /\.style\s*[.=]/]) assert.doesNotMatch(source, forbidden);
  }
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
  const first = await readTaskGateLimit(h, identity(), deadlineMs, { read: async () => proof });
  assert.equal(first.proof, proof); assert.deepEqual(keys, []);
  const scrolled = await readTaskGateLimit(h, identity(), deadlineMs, { read: async () => ++calls === 1
    ? { ...proof, fragments: [{ ...proof.fragments[0], clipped: true }], scrollDirection: 'PageDown' } : proof });
  assert.equal(scrolled.proof, proof);
  assert.deepEqual(keys, [['[data-testid="chat-task-list"]', 'PageDown']]);
});

test('count text occlusion cannot be waived or fixed by blind scrolling, and expired reads do nothing', async () => {
  const proof = await observeTaskGateLimit(limitPaintDom({ occluded: true }).h, identity());
  const h = { scrollWithKey: () => assert.fail('no scroll direction was observed') };
  const wait = async (_h, read, accept) => { assert.equal(accept(await read()), false); throw new Error('text still occluded'); };
  await assert.rejects(readTaskGateLimit(h, identity(), Date.now() + 10000, { read: async () => proof, wait }), /text still occluded/);
  await assert.rejects(readTaskGateLimit(h, identity(), 1, { read: () => assert.fail('expired observation') }));
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
  const proof = evidence().rejected, trace = [], captured = { captures: [] };
  const screenshot = { path: '/owned/unit-only/task-gate-same-question-text-failure.png', method: 'unit-double' };
  const context = {
    text: proof.identity, evidence: captured, rejectedBefore: proof.before, rejectedAfter: proof.after,
    typed: proof.typed, rejectedUi: proof.ui, refreshed: proof.refreshed,
    assertDraftRetained: (...args) => { trace.push('assert-retained'); return assertDraftRetained(...args); },
    check: (label, passed) => { trace.push('check'); assert.equal(passed, true); assert.match(label, /retain draft and explanation/); },
    capture: async stage => { trace.push(stage); return screenshot; },
  };
  await runCaptureSection('  evidence.rejected =', '  // Change identity while', context);
  assert.deepEqual(trace, ['assert-retained', 'check', 'task-gate-same-question-text-failure']);
  const checkpoint = captured.captures[0];
  assert.equal(checkpoint.stage, 'same-question-text-failure'); assert.equal(checkpoint.identity, proof.identity);
  assert.equal(checkpoint.ui, proof.refreshed); assert.equal(checkpoint.ui.value, proof.typed.value);
  assert.ok(checkpoint.ui.notice); assert.equal(checkpoint.ui.continueDisabled, false);
  assert.equal(checkpoint.screenshot, screenshot); assert.equal(checkpoint.visualReview, 'pending');
  for (const patch of [{ value: '' }, { notice: '' }, { responseKey: 'other-question' }, { threadId: 'other-room' }]) {
    trace.length = 0;
    const invalid = { ...context, evidence: { captures: [] }, refreshed: { ...proof.refreshed, ...patch } };
    await assert.rejects(runCaptureSection('  evidence.rejected =', '  // Change identity while', invalid));
    assert.deepEqual(trace, ['assert-retained'], 'lost answer/error/identity cannot be captured as the preserved failure');
    assert.deepEqual(invalid.evidence.captures, []);
  }
});

test('intermediate captures retain all existing flow assertions and the final capture in their original order', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-task-gate-flow.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/await capture\('([^']+)'\)/g)].map(match => match[1]), [
    'task-gate-initial-choice-before-continue', 'task-gate-same-question-text-failure', 'task-gate-answer-flow',
  ]);
  let previous = -1;
  for (const required of [
    'assertQuestionIdentity(initialChoice, choice, local.id);',
    "await capture('task-gate-initial-choice-before-continue')",
    "await control('hold-next'); await click(field(choice, 'continue'));",
    'assertOneAnswer(choiceBefore, choiceAfter, choice);',
    'assertDraftRetained(rejectedUi, refreshed, { notice: true });',
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
