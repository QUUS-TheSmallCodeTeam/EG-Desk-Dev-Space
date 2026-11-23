import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';

const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
function section(from, to) {
  const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a);
  return surface.slice(a, b);
}
const controller = section('  function chatChoiceExplanationDraft(', '  function mountCodexHUD(');
const mount = vm.runInNewContext(`${controller}\nmountChatChoiceComposer`);
const submit = section('            const submitComposer = () => {', '            const sendButton =');
const transport = section('      readChatChoiceMode(signal)', "      // Settings '결정 모델");
const tick = () => new Promise(resolve => setImmediate(resolve));
const proof = { configured: true, mode: 'on', boardRevision: 'a'.repeat(64) };
const question = '기간을 기준으로 어느 쪽이 나을까요?';
const opts = ['<img src=x onerror=oops>', '두 번째'];

// Fake DOM: execute the Surface handlers, not parallel test implementations.
function el(tag, props = {}, ...children) {
  return { tag, props, children: children.filter(x => x != null), value: '', textContent: '', hidden: false, disabled: false,
    focus() {}, replaceChildren(...next) { this.children = next; },
    querySelector(selector) { return this.find(selector.match(/data-testid="([^\"]+)"/)?.[1])[0] || null; },
    find(id) { return [ ...(this.props.data?.testid === id ? [this] : []), ...this.children.flatMap(x => x.find?.(id) || []) ]; },
    get text() { return this.textContent + ' ' + this.children.map(x => typeof x === 'string' ? x : x.text).join(' '); },
    click() { if (!this.disabled && !this.hidden) this.props.onclick?.(); },
    type(value) { this.value = value; this.props.oninput?.(); },
  };
}
function fixture({ initialProof = proof, read = state => state.proof, post = async () => ({ status: 'recommended', index: 0 }), text = question } = {}) {
  const calls = { post: [], mode: [], native: [], drafts: [] };
  const state = { key: 'room/owner/revision/1', question: text, proof: initialProof };
  const input = Object.assign(el('textarea'), { isConnected: true, value: text });
  const codexBridge = vm.runInNewContext(`({${transport}})`, { fetchJson: (path, args) => {
    if (path === '/decision/status') { calls.mode.push([path, args.method, args.signal]); return Promise.resolve(read(state, calls.mode.length)); }
    assert.equal(path, '/chat/choice'); assert.equal(args.method, 'POST');
    calls.post.push({ body: JSON.parse(args.body), signal: args.signal }); return post();
  } });
  const choice = mount({ el, readMode: codexBridge.readChatChoiceMode, postChoice: codexBridge.postChatChoice,
    makeController: () => new AbortController(), makeRequestId: () => 'choice-fixture' });
  choice.attach({ input, readScope: () => state.key && ({ ...state, clientThreadId: 'room', conversationId: 'native', profileId: 'review-verifier', question: input.value }),
    setDraft: draft => calls.drafts.push(draft) });
  choice.sync();
  const ordinary = vm.runInNewContext(`${submit}\nsubmitComposer`, { choice, input, compositionInProgress: false,
    boardInputState: null, boardPreview: null, manualOwner: 'owner', codexBridge: { sendMessage: opts => calls.native.push([opts.manualOwner, input.value]) } });
  const find = id => choice.panel.find(`chat-choice-${id}`);
  const click = id => find(id)[0]?.click();
  const open = () => { choice.trigger.click(); find('option').forEach((node, i) => node.type(opts[i])); };
  const review = async () => { open(); click('review'); await tick(); };
  return { calls, choice, state, input, find, click, open, review, ordinary };
}

function assertCounts(calls, mode, post, native, drafts = 0) {
  assert.deepEqual([calls.mode.length, calls.post.length, calls.native.length, calls.drafts.length], [mode, post, native, drafts]);
}

test('R1 Surface open/review leak no question or native send; one confirmed loopback POST, text-only inert result, then editable draft and ordinary send once', async () => {
  const f = fixture(); f.open(); assertCounts(f.calls, 0, 0, 0);
  f.click('review'); await tick(); assertCounts(f.calls, 1, 0, 0);
  assert.match(f.choice.panel.text, /OpenAI Decisions · 저장한 API 키 사용.*API 비용이 청구됩니다/);
  assert.match(f.choice.panel.text, /기간을 기준으로/); assert.ok(f.choice.panel.text.includes(opts[0])); assert.ok(f.choice.panel.text.includes(opts[1]));
  const confirm = f.find('confirm')[0]; confirm.click(); confirm.click(); await tick();
  assertCounts(f.calls, 3, 1, 0);
  assert.deepEqual(f.calls.post[0].body, { clientThreadId: 'room', conversationId: 'native', profileId: 'review-verifier',
    requestId: 'choice-fixture', question, options: opts, confirm: true, reviewRevision: proof.boardRevision });
  assert.equal(f.find('result')[0].textContent, `EG-Desk 추천: ${opts[0]} · 실행하지 않음`);
  assert.equal(f.input.value, question);
  f.click('explain'); await tick(); assertCounts(f.calls, 4, 1, 0, 1);
  assert.equal(f.input.value, f.calls.drafts[0]); assert.ok(f.input.value.includes(question));
  for (const opt of opts) assert.ok(f.input.value.includes(opt));
  assert.match(f.input.value, /내부 판단 근거는 알 수 없으니/);
  f.input.value += '\n내가 추가한 후속 질문';
  f.ordinary(); assertCounts(f.calls, 4, 1, 1, 1);
  assert.deepEqual(f.calls.native[0], ['owner', f.input.value]);
});

test('R1 cannot opt in before verified on+key and explicit confirm; cancel before review sends zero', async () => {
  const cancelled = fixture(); cancelled.open(); cancelled.click('cancel'); assertCounts(cancelled.calls, 0, 0, 0);
  assert.equal(cancelled.input.value, question);
  for (const status of [null, { ...proof, configured: false }, { ...proof, mode: 'advisory' }, { ...proof, mode: 'off' }, { ...proof, boardRevision: null }]) {
    const f = fixture({ initialProof: status }); await f.review(); f.click('confirm');
    assertCounts(f.calls, 1, 0, 0); assert.equal(f.find('result').length, 0);
    assert.match(f.choice.panel.text, /직접 판단/); assert.equal(f.input.value, question);
  }
});

test('R1 offer requires 1 line / 500; direct 2–8 options each 1 line / 120, and no implicit requests', async () => {
  for (const text of ['', '하나\n둘', '가'.repeat(501)]) {
    const f = fixture({ text }); f.open(); assert.equal(f.find('option').length, 0); assertCounts(f.calls, 0, 0, 0);
  }
  const f = fixture({ text: '가'.repeat(500) }); f.open();
  for (let i = 0; i < 7; i++) f.click('add');
  assert.equal(f.find('option').length, 8); assert.equal(f.find('add').length, 0);
  f.find('option').forEach((field, i) => field.type(`${i}${'가'.repeat(119)}`));
  for (const invalid of [' ', 'x\ny', 'x\u2028y', '가'.repeat(121)]) {
    f.find('option')[0].type(invalid); f.click('review'); assertCounts(f.calls, 0, 0, 0);
  }
  f.find('option')[0].type('유효한 보기'); f.click('review'); await tick(); assertCounts(f.calls, 1, 0, 0);
});

test('R1 after confirm, late result is discarded on edit, owner/room revision switch, close or cancel; never a native send', async () => {
  for (const action of [f => { f.input.value = '사용자가 편집함'; }, f => { f.state.key = 'different/owner'; },
    f => { f.input.isConnected = false; }, f => { f.click('cancel'); }]) {
    let resolve; const f = fixture({ post: () => new Promise(r => { resolve = r; }) });
    await f.review(); f.click('confirm'); await tick(); assertCounts(f.calls, 2, 1, 0);
    assert.match(f.choice.panel.text, /이미 보낸 요청은 취소해도 회수되지 않습니다/);
    action(f); f.choice.sync(); resolve({ status: 'recommended', index: 0 }); await tick();
    assertCounts(f.calls, 2, 1, 0); assert.equal(f.find('result').length, 0);
    assert.equal(f.calls.post[0].signal.aborted, true);
  }
});

test('R1 manual/failure/out-of-range are inert, changed settings suppress result or draft', async () => {
  for (const post of [async () => ({ status: 'manual' }), async () => { throw Error('opaque'); },
    async () => ({ status: 'recommended', index: 2 }), async () => ({ status: 'recommended', index: -1 }),
    async () => ({ status: 'recommended', index: '0' })]) {
    const f = fixture({ post }); await f.review(); f.click('confirm'); await tick();
    assertCounts(f.calls, 2, 1, 0); assert.equal(f.input.value, question);
    assert.match(f.choice.panel.text, /직접 판단/);
  }
  let resolve; const pending = fixture({ post: () => new Promise(r => { resolve = r; }) });
  await pending.review(); pending.click('confirm'); await tick();
  pending.state.proof = { ...proof, boardRevision: 'b'.repeat(64) };
  resolve({ status: 'recommended', index: 0 }); await tick();
  assertCounts(pending.calls, 3, 1, 0); assert.equal(pending.find('result').length, 0);
  const f = fixture(); await f.review(); f.click('confirm'); await tick();
  f.state.proof = { ...proof, mode: 'off' }; f.click('explain'); await tick();
  assertCounts(f.calls, 4, 1, 0); assert.equal(f.input.value, question);
  assert.equal(f.find('result').length, 0);
});

test('R1 actual mount consumes the supplement and existing composer send button remains on native submit', () => {
  assert.match(surface, /choice\.attach\(\{ input, readScope:.*\n\s*\? codexBridge\.chatChoiceScope\(activeThread\.id, input\.value\)/);
  assert.match(surface, /choice\.panel,\n\s*el\('div', \{ class: 'egd-codex-input-row'/);
  assert.match(surface, /choice\.trigger,\n\s*sendButton/);
  assert.match(surface, /makeRequestId: \(\) => `choice-\$\{Date\.now\(\)\}-\$\{window\.crypto\.randomUUID\(\)\}`/);
  assert.match(surface, /testid: 'chat-send' \},\n\s*onclick: submitComposer/);
  assert.match(surface, /: fetchJson\('\/chat\/send', \{\n\s*method: 'POST'/);
});

test('R1 actual live Surface scope fails closed on wrong room/account/Agent, native forms, project or selected context', () => {
  const profile = { id: 'review-verifier', origin: 'template', revision: 1 };
  const account = { isLoggedIn: true, authMode: 'chatgpt', accountId: 'verified-account' };
  const room = { id: 'room', type: 'dm', engineId: 'codex', profileEnabled: true, agentProfileId: profile.id,
    bindingAccountKey: ChatState.codexAccountKey(account), bindingState: 'verified', conversationId: 'native',
    agent: { profileId: profile.id, revision: 1 } };
  const state = { codex: { activeThreadId: room.id, hudView: 'conversation', authStatus: account, connected: true,
    threadDraftRevisions: { room: 0 }, activityRoomGeneration: 0 }, contextSuggest: { byThread: { room: { picked: [] } } } };
  const protocol = ChatState.createChatProtocolState();
  let project = { status: 'ready', value: { status: 'none' } }, busy = false;
  const { chatChoiceScope: scope } = vm.runInNewContext(`({${section('      chatChoiceScope(', '      readChatChoiceMode(')}})`, {
    state, protocol, ChatState, choiceSettingsWriting: 0, choiceSettingsGeneration: 0,
    getCodexThreadById: (_, id) => id === room.id ? room : null, getCodexThreadDraft: () => question,
    codexThreadAgentProfile: () => profile, CODEX_AGENT_PROFILES: { [profile.id]: {} },
    threadBusy: () => busy, chatRoomProjectState: () => project, chatProjectDraftActions: new Map(),
    manualOwnerIdentity: () => 'same-owner', document: { getElementById: () => ({ matches: () => true }) },
  });
  const read = () => scope('room', question);
  const first = read(); assert.equal(first.profileId, profile.id); assert.equal(first.conversationId, 'native');
  for (const [key, value] of [['type', 'group'], ['engineId', 'claude'], ['conversationId', null], ['profileEnabled', false],
    ['bindingState', 'live-unverified'], ['bindingAccountKey', 'codex:chatgpt:somebody-else'], ['inputSources', [{}]],
    ['briefingInputs', [{}]], ['requestProjectTarget', {}], ['cwd', '/some/path'], ['executionBounded', true]]) {
    const prior = room[key]; room[key] = value; assert.equal(read(), null, key); room[key] = prior;
  }
  profile.origin = 'user'; assert.equal(read(), null); profile.origin = 'template';
  profile.revision = 2; assert.equal(read(), null); profile.revision = 1;
  busy = true; assert.equal(read(), null); busy = false;
  state.activeEntityId = 'focused-file'; assert.equal(read(), null); state.activeEntityId = null;
  state.contextSuggest.byThread.room.picked = ['selected']; assert.equal(read(), null); state.contextSuggest.byThread.room.picked = [];
  state.codex.activeThreadId = 'another-room'; assert.equal(read(), null); state.codex.activeThreadId = room.id;
  state.codex.hudView = 'list'; assert.equal(read(), null); state.codex.hudView = 'conversation';
  project = null; assert.equal(read(), null); project = { status: 'ready', value: { status: 'connected' } }; assert.equal(read(), null);
  project = { status: 'ready', value: { status: 'none' } };
  protocol.runs['native/one'] = { conversationId: 'native', clientThreadId: 'room', runId: 'one', status: 'running', pendingApprovals: [{}] };
  assert.equal(read(), null); delete protocol.runs['native/one'];
  assert.equal(scope('room', 'a different draft'), null);
  state.codex.threadDraftRevisions.room++; assert.notEqual(read().key, first.key);
  state.canvasSelectionRevision = 1; assert.notEqual(read().key, first.key);
});

test('R1 v2 cross-window settings change after review: confirmation reads only local state and never POSTs', async () => {
  for (const next of [{ ...proof, boardRevision: 'b'.repeat(64) }, { ...proof, mode: 'off' },
    { ...proof, mode: 'advisory' }, { ...proof, configured: false }, null]) {
    const f = fixture(); await f.review(); assertCounts(f.calls, 1, 0, 0);
    f.state.proof = next; // Simulate another window without a Surface state notification.
    f.click('confirm'); await tick();
    assertCounts(f.calls, 2, 0, 0);
    assert.deepEqual(f.calls.mode.map(call => call.slice(0, 2)), [['/decision/status', 'GET'], ['/decision/status', 'GET']]);
    assert.equal(f.find('confirm').length, 0);
    assert.match(f.choice.panel.text, /직접 판단/); assert.equal(f.input.value, question);
  }
});

test('R1 v2 checkingConfirm locks the reviewed controls; cancel or reset aborts and blocks even a late valid status', async () => {
  for (const action of [f => f.click('cancel'), f => f.choice.reset()]) {
    let finish;
    const f = fixture({ read: (state, call) => call === 2 ? new Promise(resolve => { finish = resolve; }) : state.proof });
    await f.review(); const confirm = f.find('confirm')[0]; confirm.click(); confirm.click();
    assertCounts(f.calls, 2, 0, 0);
    assert.equal(f.find('confirm').length, 0); assert.equal(f.find('option').length, 0);
    assert.match(f.choice.panel.text, /저장된 모드와 키 확인 중/);
    action(f); assert.equal(f.calls.mode[1][2].aborted, true);
    finish(proof); await tick();
    assertCounts(f.calls, 2, 0, 0); assert.equal(f.find('result').length, 0); assert.equal(f.input.value, question);
  }
});

test('R1 v2 only the matching confirmation epoch allows one POST using the frozen review revision', async () => {
  let finish;
  const f = fixture({ read: (state, call) => call === 2 ? new Promise(resolve => { finish = resolve; }) : state.proof });
  await f.review(); const confirm = f.find('confirm')[0]; confirm.click(); confirm.click();
  assertCounts(f.calls, 2, 0, 0);
  finish({ ...proof }); await tick();
  assertCounts(f.calls, 3, 1, 0); assert.equal(f.calls.post[0].body.reviewRevision, proof.boardRevision);
  assert.equal(f.find('result').length, 1);
});

test('R1 v3 NFC+trim snapshot is the exact review, POST, inert result and explanation; raw composer survives review and cancel', async () => {
  const rawQuestion = '  Cafe\u0301와 \u1112\u1161\u11ab? ';
  const rawOptions = [' \u1112\u1161\u11ab  글 ', '  Cafe\u0301 메뉴\u00a0'];
  const expected = { question: 'Café와 한?', options: ['한  글', 'Café 메뉴'] };
  const f = fixture({ text: rawQuestion });
  const edit = () => { f.open(); f.find('option').forEach((node, i) => node.type(rawOptions[i])); };
  const visibleReview = () => ({ question: f.choice.panel.children[0].textContent.slice('질문: '.length),
    options: f.choice.panel.children[1].children.map(node => node.textContent) });
  edit(); assert.equal(f.input.value, rawQuestion); assertCounts(f.calls, 0, 0, 0);
  f.click('review'); await tick(); assert.deepEqual(visibleReview(), expected);
  assert.match(f.choice.panel.children[1].children[0].props.style, /white-space:pre-wrap/);
  assert.equal(f.input.value, rawQuestion); f.click('cancel'); assert.equal(f.input.value, rawQuestion); assertCounts(f.calls, 1, 0, 0);
  edit(); f.click('review'); await tick(); const reviewed = visibleReview(); assert.deepEqual(reviewed, expected);
  f.click('confirm'); await tick(); assertCounts(f.calls, 4, 1, 0);
  assert.deepEqual({ question: f.calls.post[0].body.question, options: f.calls.post[0].body.options }, reviewed);
  assert.equal(f.find('result')[0].textContent, 'EG-Desk 추천: 한  글 · 실행하지 않음');
  assert.equal(f.input.value, rawQuestion);
  f.click('explain'); await tick(); assertCounts(f.calls, 5, 1, 0, 1);
  assert.match(f.input.value, /질문: Café와 한\?\n1\. 한  글\n2\. Café 메뉴\nEG-Desk 추천: 1\. 한  글$/);
});

test('R1 v3 canonical and case/space duplicate options stay in editable fields with guidance, no local or native requests', async () => {
  for (const values of [[' Cafe\u0301 ', 'Café'], ['Alpha  BETA', 'alpha\u00a0beta'], ['\u1112\u1161\u11ab', '한']]) {
    const f = fixture(); f.open();
    f.find('option').forEach((node, i) => node.type(values[i]));
    f.click('review'); await tick(); assertCounts(f.calls, 0, 0, 0);
    assert.equal(f.find('review')[0].disabled, true);
    assert.match(f.find('validation')[0].textContent, /중복/);
    assert.deepEqual(f.find('option').map(node => node.value), values);
    f.find('option')[1].type('고유한 보기'); f.click('review'); await tick(); assertCounts(f.calls, 1, 0, 0);
    assert.equal(f.find('confirm').length, 1);
  }
});

test('R1 v3 chooser-forbidden control/format/lone surrogate/line separators/default-ignorable text gets local guidance', async () => {
  for (const invalid of ['\u0000x', 'x\u200d', 'x\ud800', 'x\u2029', 'x\ufe0f', 'x\u034f', '\ufeffx', 'x\u2028']) {
    const badQuestion = fixture({ text: invalid }); badQuestion.open();
    assert.equal(badQuestion.choice.questionHint.hidden, false);
    assert.equal(badQuestion.find('option').length, 0); assert.equal(badQuestion.input.value, invalid);
    assertCounts(badQuestion.calls, 0, 0, 0);
    const badOption = fixture(); badOption.open(); badOption.find('option')[1].type(invalid);
    badOption.click('review'); await tick(); assertCounts(badOption.calls, 0, 0, 0);
    assert.match(badOption.find('validation')[0].textContent, /보기 2.*보이지 않는 문자나 줄바꿈/);
    assert.equal(badOption.find('option')[1].value, invalid);
  }
  const tooLongBeforeNFC = fixture({ text: 'e\u0301'.repeat(251) }); tooLongBeforeNFC.open();
  assert.equal(tooLongBeforeNFC.choice.questionHint.hidden, false); assertCounts(tooLongBeforeNFC.calls, 0, 0, 0);
});

test('R1 v3 raw composer changes invalidate review even when the replacement normalizes to the same question', async () => {
  const f = fixture({ text: ' Cafe\u0301 ' }); await f.review();
  const confirm = f.find('confirm')[0]; f.input.value = 'Café'; confirm.click(); f.choice.sync(); await tick();
  assertCounts(f.calls, 1, 0, 0); assert.equal(f.input.value, 'Café'); assert.equal(f.find('confirm').length, 0);
});
