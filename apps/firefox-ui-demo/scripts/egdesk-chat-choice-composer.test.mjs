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
const notSentText = '결정 모델 설정을 확인하지 못해 질문과 보기를 보내지 않았습니다. 작성 중인 메시지는 그대로입니다.';
const manualText = '추천을 표시할 수 없습니다. 직접 판단해 주세요. 작성 중인 메시지는 그대로입니다.';

// Fake DOM: execute the Surface handlers, not parallel test implementations.
function el(tag, props = {}, ...children) {
  const listeners = new Map();
  return { tag, props, children: children.filter(x => x != null), value: '', textContent: '', hidden: false, disabled: false,
    focus() {}, replaceChildren(...next) { this.children = next; },
    querySelector(selector) { return this.find(selector.match(/data-testid="([^\"]+)"/)?.[1])[0] || null; },
    find(id) { return [ ...(this.props.data?.testid === id ? [this] : []), ...this.children.flatMap(x => x.find?.(id) || []) ]; },
    get text() { return this.textContent + ' ' + this.children.map(x => typeof x === 'string' ? x : x.text).join(' '); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    fire(type, event = {}) { listeners.get(type)?.({ target: this, ...event }); },
    click() { if (!this.disabled && !this.hidden) { this.props.onclick?.(); this.fire('click'); } },
    type(value) { this.value = value; this.props.oninput?.(); },
  };
}
function fixture({ initialProof = proof, read = state => state.proof, post = async () => ({ status: 'recommended', index: 0 }), text = question,
  openSettings, makeRequestId = () => 'choice-fixture' } = {}) {
  const calls = { post: [], mode: [], native: [], drafts: [] };
  const state = { key: 'room/owner/revision/1', editKey: 'room/owner/draft/1', question: text, proof: initialProof };
  const input = Object.assign(el('textarea'), { isConnected: true, value: text, dataset: { threadId: 'room' } });
  const codexBridge = vm.runInNewContext(`({${transport}})`, { fetchJson: (path, args) => {
    if (path === '/decision/status') {
      calls.mode.push([path, args.method, args.signal, args]);
      return Promise.resolve(read(state, calls.mode.length));
    }
    assert.equal(path, '/chat/choice'); assert.equal(args.method, 'POST');
    calls.post.push({ body: JSON.parse(args.body), signal: args.signal }); return post();
  } });
  const choice = mount({ el, readMode: codexBridge.readChatChoiceMode, postChoice: codexBridge.postChatChoice,
    openSettings, makeController: () => new AbortController(), makeRequestId });
  const attach = () => choice.attach({ input, readScope: () => state.key && !state.scopePending && ({ ...state, clientThreadId: 'room', conversationId: 'native', profileId: 'review-verifier', question: input.value }),
    setDraft: draft => calls.drafts.push(draft) });
  attach();
  choice.sync();
  const ordinary = vm.runInNewContext(`${submit}\nsubmitComposer`, { choice, input, compositionInProgress: false,
    boardInputState: null, boardPreview: null, manualOwner: 'owner', codexBridge: { sendMessage: opts => calls.native.push([opts.manualOwner, input.value]) } });
  const find = id => choice.panel.find(`chat-choice-${id}`);
  const click = id => find(id)[0]?.click();
  const open = () => { choice.trigger.click(); find('option').forEach((node, i) => node.type(opts[i])); };
  const review = async () => { open(); click('review'); await tick(); };
  return { calls, choice, state, input, find, click, open, review, ordinary, attach };
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
  for (const status of [{ ...proof, mode: 'advisory' }, { ...proof, mode: 'off' }]) {
    const f = fixture({ initialProof: status }); await f.review(); f.click('confirm');
    assertCounts(f.calls, 1, 0, 0); assert.equal(f.find('result').length, 0);
    assert.match(f.choice.panel.text, /직접 판단/); assert.equal(f.input.value, question);
  }
});

for (const [label, read] of [
  ['rejected status', async () => { throw Error('status refused'); }],
  ['connection failure', async () => { throw new TypeError('Failed to fetch'); }],
  ['missing status', () => null],
  ['unknown mode', () => ({ ...proof, mode: 'unknown' })],
  ['incompatible revision', () => ({ ...proof, boardRevision: null })],
  ['configuration not provable', () => ({ ...proof, configured: false, store: 'unreadable' })],
]) {
  test(`R1 first status check (${label}) explains no choice request and only offers Close`, async () => {
    const text = `  ${question} `;
    const f = fixture({ read, text, openSettings: () => assert.fail('unexpected Settings action') });
    await f.review();
    assertCounts(f.calls, 1, 0, 0);
    assert.deepEqual(f.calls.mode.map(call => call.slice(0, 2)), [['/decision/status', 'GET']]);
    const [, , signal, args] = f.calls.mode[0];
    assert.deepEqual({ ...args }, { method: 'GET', signal, cache: 'no-store' });
    assert.equal(f.input.value, text);
    assert.equal(f.choice.panel.children[0].props.role, 'status');
    assert.equal(f.choice.panel.children[0].textContent, notSentText);
    assert.deepEqual(f.choice.panel.children.map(node => node.tag), ['p', 'button']);
    assert.equal(f.find('cancel')[0].text.trim(), '닫기');
    f.click('confirm'); f.click('settings'); f.click('cancel'); await tick();
    assert.equal(f.choice.panel.hidden, true); assert.equal(f.input.value, text);
    assertCounts(f.calls, 1, 0, 0);
  });
}

test('R1 failed initial status arriving after a room or draft change stays hidden', async () => {
  for (const change of [f => { f.state.key = 'other-room/account'; }, f => { f.input.value = '편집한 원문'; }]) {
    let reject;
    const f = fixture({ read: () => new Promise((_, rejectRead) => { reject = rejectRead; }) });
    f.open(); f.click('review'); assertCounts(f.calls, 1, 0, 0);
    change(f); const text = f.input.value;
    reject(Error('late status failure')); await tick();
    assertCounts(f.calls, 1, 0, 0); assert.equal(f.calls.mode[0][2].aborted, true);
    assert.equal(f.choice.panel.hidden, true); assert.equal(f.choice.panel.text.trim(), '');
    assert.equal(f.input.value, text);
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
  for (const post of [async () => ({ status: 'manual' }), async () => undefined, async () => { throw Error('opaque'); },
    async () => ({ status: 'recommended', index: 2 }), async () => ({ status: 'recommended', index: -1 }),
    async () => ({ status: 'recommended', index: '0' })]) {
    const f = fixture({ post }); await f.review(); f.click('confirm'); await tick();
    assertCounts(f.calls, 2, 1, 0); assert.equal(f.input.value, question);
    assert.deepEqual(f.calls.mode.map(call => call.slice(0, 2)), [['/decision/status', 'GET'], ['/decision/status', 'GET']]);
    assert.equal(f.calls.post[0].body.confirm, true);
    assert.equal(f.choice.panel.children[0].textContent, manualText);
    assert.equal(f.find('settings').length, 0); assert.equal(f.find('cancel')[0].text.trim(), '닫기');
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
    assert.equal(f.choice.panel.children[0].textContent, manualText);
    assert.equal(f.find('settings').length, 0); assert.equal(f.input.value, question);
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

test('R1 setup-only recovery: explicit Settings click, old review gone, draft preserved, fresh same-room review required', async () => {
  for (const [status, reason, message] of [[{ ...proof, configured: false, store: 'missing' }, 'key', /저장한 API 키가 없습니다/],
    [{ ...proof, mode: 'off' }, 'mode', /꺼져 있습니다/], [{ ...proof, mode: 'advisory' }, 'mode', /기록만/]]) {
    const opened = [];
    const f = fixture({ initialProof: status, openSettings: reason => opened.push(reason) });
    await f.review(); assertCounts(f.calls, 1, 0, 0); assert.deepEqual(opened, []);
    const settings = f.find('settings')[0]; assert.ok(settings, 'expected actionable Settings button after review');
    assert.equal(settings.text.trim(), '계정 설정 열기');
    assert.match(f.choice.panel.text, message); assert.equal(f.find('confirm').length, 0);
    settings.click(); settings.click(); await tick();
    assert.deepEqual(opened, [reason]); assert.equal(f.choice.panel.hidden, true);
    assertCounts(f.calls, 1, 0, 0); assert.equal(f.calls.mode[0][2].aborted, true); assert.equal(f.input.value, question);
    f.state.proof = proof; f.state.key = 'room/owner/revision/2'; f.click('confirm'); assertCounts(f.calls, 1, 0, 0);
    f.choice.trigger.click(); assert.deepEqual(f.find('option').map(node => node.value), opts);
    f.click('review'); await tick(); f.click('confirm'); await tick(); assertCounts(f.calls, 4, 1, 0);
  }
});

test('R1 setup recovery never appears for unknown or failed status, refusal, invalid result, or a stale review', async () => {
  for (const options of [{ initialProof: null }, { initialProof: { ...proof, configured: false, store: 'unreadable' } },
    { initialProof: { ...proof, mode: 'off', boardRevision: null } }, { read: () => { throw Error('offline'); } },
    { post: async () => ({ status: 'manual' }) }, { post: async () => { throw Error('refused'); } },
    { post: async () => ({ status: 'recommended', index: 999 }) }, {}]) {
    const f = fixture({ ...options, openSettings: () => assert.fail('unexpected Settings action') });
    await f.review(); assert.equal(f.find('settings').length, 0);
    f.click('confirm'); await tick(); assert.equal(f.find('settings').length, 0);
  }
  for (const revoke of [f => { f.state.key = 'other-room/account'; }, f => { f.input.value = 'edited'; }, f => f.choice.dispose()]) {
    const f = fixture({ initialProof: { ...proof, mode: 'off' }, openSettings: () => assert.fail('stale Settings action') });
    await f.review(); const settings = f.find('settings')[0]; assert.ok(settings);
    revoke(f); settings.click(); await tick();
    assertCounts(f.calls, 1, 0, 0); assert.equal(f.find('settings').length, 0);
  }
});

test('R1 actual Settings handoff opens the account tab, uses only existing controls, and fails safely if the section did not render', async () => {
  const calls = [];
  const key = { focus: () => calls.push('focus-key') }, mode = { focus: () => calls.push('focus-mode') };
  const decisionSection = { isConnected: true, scrollIntoView: () => calls.push('scroll'), querySelector: q => {
    if (q === 'input[type="password"][data-testid="settings-decision-key"]') return key;
    if (q === '[data-testid="settings-decision-mode"][data-mode="on"]') return mode;
    assert.fail(`unexpected selector: ${q}`);
  } };
  let renderedAccount = false;
  const card = { id: 'fake-settings-card', isConnected: true, classList: { contains: value => value === 'egd-card-collapsed' },
    _setWindowCollapsed: value => calls.push(['collapsed', value]), querySelector: q => {
      if (q === '[data-testid="settings-tab-account"][aria-selected="true"]') return renderedAccount;
      if (q === '[data-testid="settings-decision"]') return decisionSection;
      assert.fail(`unexpected selector: ${q}`);
    } };
  const open = vm.runInNewContext(`${controller}\nopenChatChoiceSettings`, {
    spawnSettingsCard: opts => { calls.push(`tab:${opts.tab}`); assert.deepEqual(Object.keys(opts), ['tab']); return card; },
    state: { activeEntityId: card.id },
    revealOpenCanvasCard: (candidate, { isCurrent }) => { assert.equal(candidate, card); assert.equal(isCurrent(), true); calls.push('reveal'); },
    boardNotice: text => calls.push(text),
  });
  const f = fixture({ initialProof: { ...proof, mode: 'off' }, openSettings: open });
  assert.match(surface, /openSettings: openChatChoiceSettings/);
  assert.match(surface, /contentArea\.replaceChildren\([^\n]*renderDecisionModel\(\)\)/);
  assert.match(surface, /type: 'password'[^\n]*egd-settings-decision-input[\s\S]{0,250}testid: 'settings-decision-key'/);
  open('key'); assert.equal(calls[0], 'tab:account'); assert.match(calls[1], /채팅에는 API 키를 입력하지 마세요/);
  assert.equal(calls.length, 2); renderedAccount = true; calls.length = 0;
  open('key'); assert.deepEqual(calls, ['tab:account', ['collapsed', false], 'reveal', 'scroll', 'focus-key']); calls.length = 0;
  await f.review(); f.click('settings'); assert.deepEqual(calls, ['tab:account', ['collapsed', false], 'reveal', 'scroll', 'focus-mode']); calls.length = 0;
  key.disabled = true;
  open('key'); assert.deepEqual(calls, ['tab:account', ['collapsed', false], 'reveal', 'scroll']);
  assertCounts(f.calls, 1, 0, 0);
});

test('R1 unreviewed option edits survive setup dismissal but do not follow a different DM owner/draft', async () => {
  const f = fixture({ initialProof: { ...proof, mode: 'off' }, openSettings() {} });
  await f.review(); f.click('cancel');
  assert.deepEqual(f.find('option').map(node => node.value), opts);
  assert.equal(f.find('confirm').length, 0); assertCounts(f.calls, 1, 0, 0);
  f.click('review'); await tick(); f.click('settings');
  f.state.key = 'other-room'; f.state.editKey = 'other-room/draft'; f.choice.sync();
  f.choice.trigger.click(); assert.deepEqual(f.find('option').map(node => node.value), ['', '']);
  assert.equal(f.input.value, question); assertCounts(f.calls, 2, 0, 0);
});

test('R1 same-DM recovery after rejected status requires a new review and explicit approval', async t => {
  const rawQuestion = '  Cafe\u0301와 어느 일정이 맞나요? ';
  const reviewedQuestion = 'Café와 어느 일정이 맞나요?';
  const rawOptions = ['  Cafe\u0301에서 오전 일정 ', '이전 오후 일정  '];
  const revisedOptions = ['Café에서 오전 일정', '새 오후 일정'];
  let rejectFirst, finishPost, requestIds = 0;
  const f = fixture({ text: rawQuestion, initialProof: null,
    read: (state, call) => call === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : state.proof,
    post: () => new Promise(resolve => { finishPost = resolve; }),
    openSettings: () => assert.fail('unexpected Settings action'),
    makeRequestId: () => `choice-recovery-${++requestIds}`,
  });
  const { editKey } = f.state;
  const checkpoint = (stage, get, post = 0) => {
    assertCounts(f.calls, get, post, 0);
    assert.equal(f.input.value, rawQuestion, stage);
    assert.equal(f.state.editKey, editKey, stage);
    assert.equal(requestIds, post, stage);
    t.diagnostic(`${stage}: status GET=${get}, choice POST=${post}, native=0, raw question unchanged`);
  };

  assert.equal(f.choice.trigger.text.trim(), '보기 추천');
  f.choice.trigger.click();
  f.find('option').forEach((field, i) => field.type(rawOptions[i]));
  assert.equal(f.find('review')[0].text.trim(), '질문과 보기 검토');
  checkpoint('first open and entry', 0);
  f.click('review');
  assert.match(f.choice.panel.text, /저장된 모드와 키 확인 중/);
  checkpoint('first review starts GET', 1);
  rejectFirst(Error('synthetic status refusal'));
  await tick();
  assert.equal(f.choice.panel.children[0].textContent, notSentText);
  assert.equal(f.find('confirm').length, 0);
  assert.equal(f.find('cancel')[0].text.trim(), '닫기');
  checkpoint('first status rejected; not sent', 1);
  f.click('cancel');
  assert.equal(f.choice.panel.hidden, true);
  assert.equal(f.calls.mode[0][2].aborted, true);
  checkpoint('closed', 1);

  const recovered = { ...proof, boardRevision: 'b'.repeat(64) };
  f.state.proof = recovered;
  f.state.key = 'room/owner/revision/2'; // Decisions settings changed, edit ownership did not.
  f.choice.sync();
  await tick();
  assert.equal(f.choice.panel.hidden, true);
  checkpoint('recovered state while idle; no automatic retry', 1);
  f.choice.trigger.click(); // Unlike fixture.open(), does not populate any option fields.
  const fields = f.find('option');
  assert.deepEqual(fields.map(field => field.value), rawOptions);
  assert.equal(f.find('confirm').length, 0);
  assert.equal(f.find('result').length, 0);
  checkpoint('explicit reopen restored only the original raw options', 1);
  fields[1].type('  새 오후 일정  ');
  checkpoint('user edits one recovered option', 1);
  assert.equal(f.find('review')[0].text.trim(), '질문과 보기 검토');
  f.click('review');
  checkpoint('second review starts fresh GET', 2);
  await tick();
  assert.notEqual(f.calls.mode[0][2], f.calls.mode[1][2]);
  assert.equal(f.calls.mode[1][2].aborted, false);
  const [shownQuestion, shownOptions] = f.choice.panel.children;
  assert.equal(shownQuestion.textContent, `질문: ${reviewedQuestion}`);
  assert.deepEqual(shownOptions.children.map(option => option.textContent), revisedOptions);
  assert.equal(f.find('confirm')[0].text.trim(), '질문과 보기만 보내기');
  checkpoint('new review displayed; awaiting explicit approval', 2);

  f.click('confirm');
  checkpoint('explicit approval starts confirmation GET', 3);
  await tick();
  assert.deepEqual(f.calls.post[0].body, { clientThreadId: 'room', conversationId: 'native', profileId: 'review-verifier',
    requestId: 'choice-recovery-1', confirm: true, reviewRevision: recovered.boardRevision,
    question: shownQuestion.textContent.slice('질문: '.length), options: revisedOptions });
  assert.match(f.choice.panel.text, /추천을 기다리는 중/);
  checkpoint('approved choice POST dispatched', 3, 1);
  finishPost({ status: 'recommended', index: 1 });
  await tick();
  assert.equal(f.find('result')[0].textContent, `EG-Desk 추천: ${revisedOptions[1]} · 실행하지 않음`);
  for (const [path, method, signal, args] of f.calls.mode) {
    assert.equal(path, '/decision/status');
    assert.equal(method, 'GET');
    assert.deepEqual({ ...args }, { method: 'GET', signal, cache: 'no-store' });
  }
  checkpoint('result displayed after revision recheck', 4, 1);
});

test('R1 failed-review edits never cross room, owner, Agent, exact question, missing edit key, or disposal', async () => {
  const original = 'Cafe\u0301 일정?';
  for (const boundary of ['room', 'owner', 'Agent', 'question', 'no edit key', 'dispose', 'stale close']) {
    const f = fixture({ text: original, read: async () => { throw Error('synthetic refusal'); } });
    if (boundary === 'no edit key') f.state.editKey = null;
    const { key, editKey } = f.state;
    await f.review();
    assert.equal(f.choice.panel.children[0].textContent, notSentText);
    if (boundary === 'stale close') {
      f.state.key = 'outdated/action'; f.state.editKey = 'other-room/owner/draft/1';
    }
    f.click('cancel');
    assert.equal(f.choice.panel.hidden, true);
    assert.equal(f.calls.mode[0][2].aborted, true);
    if (['room', 'owner', 'Agent'].includes(boundary)) {
      f.state.editKey = `${editKey}/${boundary}-changed`;
      f.state.key = `${key}/${boundary}-changed`;
    }
    if (boundary === 'question') f.input.value = original.normalize('NFC');
    if (boundary === 'dispose') { f.choice.dispose(); f.attach(); }
    f.choice.sync();
    if (['room', 'owner', 'Agent', 'question'].includes(boundary)) {
      // Returning to the prior DM/draft must not bring back already discarded edits.
      Object.assign(f.state, { key, editKey });
      f.input.value = original;
      f.choice.sync();
    }
    if (boundary === 'stale close') { Object.assign(f.state, { key, editKey }); f.choice.sync(); }
    f.choice.trigger.click();
    assert.deepEqual(f.find('option').map(field => field.value), ['', ''], boundary);
    assert.equal(f.find('confirm').length, 0, boundary);
    assert.equal(f.input.value, original, boundary);
    assertCounts(f.calls, 1, 0, 0);
  }
});

test('R1 ordinary cancel and manual after POST discard option edits instead of saving them', async () => {
  const cancelled = fixture(); cancelled.open();
  assert.equal(cancelled.find('cancel')[0].text.trim(), '취소');
  cancelled.click('cancel'); cancelled.choice.trigger.click();
  assert.deepEqual(cancelled.find('option').map(field => field.value), ['', '']);
  assertCounts(cancelled.calls, 0, 0, 0);

  const manual = fixture({ post: async () => ({ status: 'manual' }) });
  await manual.review(); manual.click('confirm'); await tick();
  assert.equal(manual.choice.panel.children[0].textContent, manualText);
  assert.equal(manual.find('cancel')[0].text.trim(), '닫기');
  manual.click('cancel'); manual.choice.trigger.click();
  assert.deepEqual(manual.find('option').map(field => field.value), ['', '']);
  assert.equal(manual.find('confirm').length, 0);
  assert.equal(manual.input.value, question);
  assertCounts(manual.calls, 2, 1, 0);
});

const listShell = section('      const shellClasses = [', '      const currentNotices = body.querySelector');
const navigateHeader = section("            el('button', {\n              class: 'egd-codex-conversation-back',", "            el('div', { class: 'egd-codex-conversation-hud-center'").trim().replace(/,$/, '');
const rowStart = '          const item = el(\'div\', {\n            class: `egd-codex-thread-item';
const listRow = section(rowStart, '          const lastMsg =');
const keyboard = section('    const openRoomFromKeyboard =', '    const closeFloatingMenus =');
const rowKeys = section('  function bindChatRoomRowKeys(', '  // Chat rebuilds its DOM');
function listFixture(f) {
  let room = 'room';
  const render = isHudListView => {
    f.input.isConnected = !isHudListView;
    f.input.dataset.threadId = room;
    if (f.input.isConnected) f.attach();
    vm.runInNewContext(listShell, { el, choice: f.choice, mode: 'hud', body: { appendChild() {} },
      activeThread: { id: room, type: 'dm' }, hudView: isHudListView ? 'list' : 'conversation', isHudListView,
      allowComposer: !isHudListView, threadRail: null, conversation: null, footer: null, chromeRow: null,
      connectionNotice: null, authCard: null, diagnostics: null });
  };
  const codexBridge = { setHudView: view => { assert.equal(view, 'list'); render(true); },
    selectThread: id => { room = id; render(false); } };
  const header = () => vm.runInNewContext(navigateHeader, { el, choice: f.choice, codexBridge, deskIcon: () => null });
  const row = id => vm.runInNewContext(`${rowKeys}\nlet focusOpenedRoom = false;\n${keyboard}\n${listRow}\nitem`,
    { el, choice: f.choice, codexBridge, thread: { id }, activeThread: { id: room }, threadMenuOpen: false, codexThreadRowLabel: () => id });
  return { back: () => header().click(), row, programmatic: codexBridge.selectThread };
}
const rawListOptions = ['  Cafe\u0301의 은빛  점선  ', '  짙은 초록 물결 '];
function enterRawOptions(f) {
  f.choice.trigger.click();
  f.find('option').forEach((node, i) => node.type(rawListOptions[i]));
}
function reopenedOptions(f) {
  assert.equal(f.choice.panel.hidden, true);
  f.choice.trigger.click();
  assert.equal(f.find('confirm').length, 0);
  assert.equal(f.find('result').length, 0);
  return f.find('option').map(node => node.value);
}

test('R1 list round trip keeps only raw same-room unreviewed edits; both pointer and Enter return through a fresh scope', () => {
  for (const key of [null, 'Enter']) {
    const f = fixture(); const nav = listFixture(f);
    enterRawOptions(f);
    nav.back();
    assert.equal(f.choice.panel.hidden, true);
    assert.equal(f.find('option').length, 0);
    f.state.scopePending = true; // Native resume temporarily cannot yield a Choice scope.
    const row = nav.row('room');
    if (key) row.fire('keydown', { key, preventDefault() {} }); else row.click();
    assert.equal(f.choice.trigger.hidden, true);
    f.state.scopePending = false; f.choice.sync();
    assert.equal(f.input.value, question);
    assert.deepEqual(reopenedOptions(f), rawListOptions);
    assertCounts(f.calls, 0, 0, 0);
  }
});

test('R1 list edits do not follow a different row, non-row return, changed scope/raw draft, or generic reset/disposal', () => {
  const original = 'Cafe\u0301 일정?';
  for (const boundary of ['different row', 'non-row return', 'cancel', 'dispose', 'reset', 'ordinary submit',
    'owner', 'Agent', 'local/native binding', 'room generation', 'settings', 'selection', 'question', 'same raw/new revision']) {
    const f = fixture({ text: original }); const nav = listFixture(f);
    enterRawOptions(f);
    if (boundary === 'cancel') f.click('cancel');
    nav.back();
    if (boundary === 'dispose') f.choice.dispose();
    if (boundary === 'reset') f.choice.reset();
    if (boundary === 'ordinary submit') f.ordinary();
    if (boundary === 'non-row return') nav.programmatic('room');
    else if (boundary === 'different row') {
      f.state.scopePending = true;
      nav.row('B').click(); // Keep B ineligible throughout; no option reopen in B.
      nav.back();
      nav.row('room').click();
      f.state.scopePending = false; f.choice.sync();
    } else {
      if (boundary === 'question') f.input.value = original.normalize('NFC');
      if (['owner', 'Agent', 'local/native binding', 'room generation', 'settings', 'selection', 'same raw/new revision'].includes(boundary)) f.state.key += `/${boundary}`;
      nav.row('room').click();
    }
    assert.deepEqual(reopenedOptions(f), ['', ''], boundary);
    assertCounts(f.calls, 0, 0, Number(boundary === 'ordinary submit'));
  }
});

test('R1 list navigation never revives a checking, confirmable, or already-reviewed editor', async () => {
  for (const stage of ['checking', 'confirmable', 'approved pending', 'setup dismissed', 'unavailable reopened']) {
    let finishStatus, finishChoice;
    const f = fixture({ initialProof: stage === 'setup dismissed' ? { ...proof, mode: 'off' } : proof,
      read: stage === 'checking' ? () => new Promise(resolve => { finishStatus = resolve; }) : stage === 'unavailable reopened' ? () => null : undefined,
      post: () => new Promise(resolve => { finishChoice = resolve; }), openSettings() {} });
    const nav = listFixture(f); enterRawOptions(f); f.click('review');
    if (stage !== 'checking') await tick();
    if (stage === 'setup dismissed' || stage === 'unavailable reopened') {
      f.click('cancel');
      if (stage === 'unavailable reopened') f.choice.trigger.click();
      assert.deepEqual(f.find('option').map(node => node.value), rawListOptions);
    }
    const approved = stage === 'approved pending';
    if (approved) { f.click('confirm'); await tick(); assertCounts(f.calls, 2, 1, 0); }
    nav.back();
    assert.equal(f.calls.mode[0][2].aborted, true);
    if (approved) assert.equal(f.calls.post[0].signal.aborted, true);
    nav.row('room').click();
    finishStatus?.(proof); finishChoice?.({ status: 'recommended', index: 0 }); await tick();
    assert.deepEqual(reopenedOptions(f), ['', ''], stage);
    assertCounts(f.calls, approved ? 2 : 1, Number(approved), 0);
  }
});
