import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardAgentAsk, boardAgentAskContent, boardAgentAskSupported } from '../overlay/resources/EGDeskBoardAgentAsk.sys.mjs';
import { createReviewFlow, reviewDialogContent } from '../overlay/resources/EGDeskReviewHandoff.sys.mjs';

const askCode = 'egask1-' + 'a'.repeat(32); // fixture only
const fields = { recipient: '검토', question: '공개 가격은?', excerpt: '요청 파일에 든 별도 발췌', expectedReply: '간단하게' };
const pair = { requestId: '76165063-e1c0-48c9-b42d-465545d0a626', requestDigest: 'a'.repeat(64) };
const review = { kind: 'request', ...fields, ...pair, askCode };
const board = { id: 'local-board', title: '업무 Board' };
const availability = { decision: true, draft: true, model: 'fake-draft' };
const basePolicy = { version: 'v7', profileId: 'p1', profileName: '공개 조사 Agent', profileRevision: 4, stale: false, excerpts: ['공개\n<표>'], publicInstructions: '한 문단으로 답한다.' };
const el = (tag, props, ...children) => ({ tag, props, children: children.filter(Boolean) });
const walk = nodes => nodes.flatMap(n => typeof n === 'object' ? [n, ...walk(n.children)] : []);
const text = nodes => nodes.map(n => typeof n === 'object' ? text(n.children) : n).join(' ');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

// decisionMode: the host's saved Decisions mode ('on' | 'advisory' | null). The host, never the panel, decides whether a run is screened:
// only a draft run can be (the excerpts already go to a model then).
function harness({ policy = basePolicy, services = availability, decisionMode = 'on' } = {}) {
  let current = true, tree = [], prepared, time = 1000;
  const calls = [], answers = [];
  const h = { calls, answers, get prepared() { return prepared; }, invalidate() { current = false; flow.invalidate(); },
    setTime(n) { time = n; }, pending: null, changed: {}, ran: {} };
  const flow = createBoardAgentAsk({ isCurrent: () => current, now: () => time,
    onState: view => { tree = view ? boardAgentAskContent(el, view, flow, flow.close).children : []; },
    onAnswer: (...value) => answers.push(value), loadProfiles: () => [{ id: 'p1', name: '공개 조사 Agent', activeRevision: 4 }],
    post: async (path, body) => {
      const endpoint = path.split('/').at(-1);
      calls.push({ endpoint, body });
      if (h.pending?.endpoint === endpoint) await h.pending.promise;
      const respond = body => ({ status: 200, body });
      if (endpoint === 'policy') {
        if (body.action === 'save') policy = { ...basePolicy, version: 'v8', excerpts: body.excerpts, publicInstructions: body.publicInstructions };
        else if (body.action === 'revoke') policy = null;
        return respond({ policy, availability: services, ...(body.action === 'issue' ? { askCode, expiresAt: 7000 } : {}) });
      }
      if (endpoint === 'prepare') {
        const draft = body.mode === 'draft';
        const draftModel = draft ? 'fake-draft' : null;
        const decisionModel = draft && decisionMode ? 'fake-decision' : null;
        prepared = { ticket: 'test-ticket', expiresAt: 2000, mode: body.mode, decisionMode: decisionModel ? decisionMode : null,
          profileName: policy.profileName, profileRevision: policy.profileRevision, model: draftModel ?? decisionModel,
          provider: draft || decisionModel ? 'openai' : null, draftModel, decisionModel, question: body.request.question, excerpts: policy.excerpts,
          replyStyle: 'concise', publicInstructions: draft ? policy.publicInstructions : '', ...h.changed };
        return respond(prepared);
      }
      if (endpoint === 'run') return respond({ mode: prepared.mode, answer: prepared.excerpts[0], source: prepared.mode === 'draft' ? 'draft' : 'local',
        ...(prepared.decisionModel ? { screening: prepared.decisionMode === 'advisory' ? 'advisory' : 'decision' } : {}), ...h.ran });
      return respond(null);
    },
  });
  const find = key => walk(tree).find(n => n.props?.data?.testid === `board-agent-ask-${key}`);
  const input = (key, value) => { const node = find(key); assert.ok(node, key); (node.props.oninput || node.props.onchange)({ currentTarget: typeof value === 'boolean' ? { checked: value } : { value } }); };
  const click = key => { assert.ok(find(key), key); return find(key).props.onclick(); };
  return Object.assign(h, { flow, tree: () => tree, open: incoming => flow.open({ board, ...(incoming ? { review } : {}) }), find, input, click, text: () => text(tree) });
}

test('owner UI saves separately typed excerpts with UTF-8 bounds and CAS, then explicitly issues a non-persisted code', async () => {
  const h = harness({ policy: null });
  await h.open();
  await h.click('save'); assert.match(h.text(), /Agent를 선택/); assert.equal(h.calls.length, 1);
  h.input('profile', 'p1'); h.input('excerpt-0', '가'.repeat(501));
  await h.click('save'); assert.match(h.text(), /1,500바이트/); assert.equal(h.calls.length, 1);
  h.input('excerpt-0', '가'.repeat(500)); h.click('add-excerpt'); h.click('add-excerpt');
  h.input('excerpt-2', '두 번째'); h.input('instructions', '짧게.');
  await h.click('save');
  assert.deepEqual(h.calls[1].body, { boardId: board.id, action: 'save', expectedVersion: null, profileId: 'p1', excerpts: ['가'.repeat(500), '두 번째'], publicInstructions: '짧게.' });
  assert.equal(h.find('issued-code'), undefined);
  await h.click('issue');
  assert.deepEqual(h.calls[2].body, { boardId: board.id, action: 'issue', expectedVersion: 'v8' });
  assert.equal(h.find('issued-code').value, askCode);
  h.click('close'); await h.open(); assert.equal(h.find('issued-code'), undefined);
  await h.click('revoke'); assert.deepEqual(h.calls.at(-1).body, { boardId: board.id, action: 'revoke', expectedVersion: 'v8' });
});

test('exact consent preview, explicitly one run, the provider mode resets for a new preparation', async () => {
  const h = harness(); await h.open(true);
  assert.match(h.text(), /업무 Board.*공개 조사 Agent Q?/s);
  assert.equal(h.find('mode-extract').checked, true); assert.equal(h.find('decision'), undefined, 'no screening checkbox');
  h.input('mode-draft', 'draft'); await h.click('prepare');
  assert.deepEqual(h.calls[1], { endpoint: 'prepare', body: { boardId: board.id, request: review, mode: 'draft' } });
  assert.match(h.text(), /공개 가격은.*<표>.*공개 답변 지침.*한 문단.*fake-draft.*fake-decision/s);
  assert.doesNotMatch(h.text(), /요청 파일에 든 별도 발췌|egask1|test-ticket/);
  assert.equal(h.calls.length, 2);
  h.click('back'); assert.equal(h.calls.at(-1).endpoint, 'cancel');
  assert.equal(h.find('mode-extract').checked, true); assert.equal(h.find('decision'), undefined);
  await h.click('prepare');
  assert.match(h.text(), /원문 그대로.*외부 API로 보내지 않습니다/s);
  const run = h.find('run').props.onclick; const pending = run(); run(); await pending;
  assert.deepEqual(h.calls.filter(call => call.endpoint === 'run'), [{ endpoint: 'run', body: { ticket: 'test-ticket', confirm: true } }]);
  assert.deepEqual(h.answers[0][1], { answer: basePolicy.excerpts[0], mode: 'extract', source: 'local' });
});

const inputs = h => walk(h.tree()).filter(n => n.tag === 'input');
test('there is no screening checkbox: the panel only offers the two run modes, and the preview states what the host will do', async () => {
  // choose step: radios only, with or without a usable Decisions setting
  for (const services of [availability, { decision: false, draft: true, model: 'fake-draft' }]) {
    const h = harness({ services }); await h.open(true);
    assert.deepEqual(inputs(h).map(n => [n.props.type, n.props.data.testid]), [['radio', 'board-agent-ask-mode-extract'], ['radio', 'board-agent-ask-mode-draft']]);
    assert.equal(h.find('decision'), undefined);
    assert.doesNotMatch(h.text(), /Decisions|관련성을 판단하도록 허용/);
    assert.equal(h.flow.chooseDecision, undefined, 'the flow has no screening choice');
  }
  // extract preview: nothing leaves, whatever the saved Decisions mode is
  for (const decisionMode of ['on', 'advisory', null]) {
    const h = harness({ decisionMode }); await h.open(true); await h.click('prepare');
    assert.deepEqual(h.calls.at(-1).body, { boardId: board.id, request: review, mode: 'extract' });
    assert.match(h.text(), /원문 그대로.*외부 API로 보내지 않습니다/s); assert.doesNotMatch(h.text(), /Decisions/);
    assert.deepEqual(inputs(h), [], 'the confirmation has no inputs at all');
  }
  // draft preview: Decisions is named exactly when the host will screen, with the mode that applies
  const on = harness(); await on.open(true); on.input('mode-draft', 'draft'); await on.click('prepare');
  assert.match(on.text(), /관련 항목을 고르는 데 OpenAI Decisions \(fake-decision\)도 씁니다\. 표시된 질문과 공개 발췌문 전부를 보내며, 계정 설정에 저장한 결정 모델 모드와 키를 그대로 따릅니다\./);
  assert.doesNotMatch(on.text(), /기록만/); assert.deepEqual(inputs(on), []);
  await on.click('run');
  assert.deepEqual(on.answers[0][1], { answer: basePolicy.excerpts[0], mode: 'draft', source: 'draft', screening: 'decision' });
  const advisory = harness({ decisionMode: 'advisory' }); await advisory.open(true); advisory.input('mode-draft', 'draft'); await advisory.click('prepare');
  assert.match(advisory.text(), /OpenAI Decisions \(fake-decision\)도 씁니다.*지금은 ‘기록만’ 모드라 그 판단은 선택에 반영되지 않고 이 기기의 단어 일치로 고릅니다\. 그래도 전송되며 API 비용이 생길 수 있습니다\./s);
  const off = harness({ decisionMode: null }); await off.open(true); off.input('mode-draft', 'draft'); await off.click('prepare');
  assert.match(off.text(), /fake-draft.*별도 Decisions API에는 보내지 않습니다\./s); assert.doesNotMatch(off.text(), /fake-decision|Decisions \(/);
  await off.click('run');
  assert.deepEqual(off.answers[0][1], { answer: basePolicy.excerpts[0], mode: 'draft', source: 'draft' });
});

test('a host reply that names Decisions outside a draft run, or without a known mode, is refused before any run', async () => {
  for (const [mode, changed] of [
    ['extract', { decisionModel: 'fake-decision', decisionMode: 'on', model: 'fake-decision', provider: 'openai' }],
    ['extract', { decisionMode: 'on' }],
    ['draft', { decisionMode: 'unknown' }],
    ['draft', { decisionMode: null }],
    ['draft', { decisionModel: null }],
    ['draft', { decisionModel: '' }],
  ]) {
    const h = harness(); await h.open(true);
    if (mode === 'draft') h.input('mode-draft', 'draft');
    h.changed = changed; await h.click('prepare');
    assert.equal(h.find('run'), undefined, JSON.stringify([mode, changed]));
    assert.equal(h.calls.at(-1).endpoint, 'cancel');
    assert.match(h.text(), /다시 열어 확인해 주세요/);
  }
});

test('the owner note follows what the run reports; a draft without screening never claims Decisions was used', () => {
  const note = result => {
    const flow = createReviewFlow({ getContext: () => ({}), isContextCurrent: () => true, isBoardCurrent: () => true, store: { check() {}, issue() {} },
      pickFile: async () => ({ bytes: new Uint8Array([1]) }), request: async () => ({ status: 200, body: { locked: false, encrypted: true, review } }) });
    return (async () => { flow.openFile(); await flow.chooseFile(); assert.equal(flow.beginAgentReply(flow.view().review, board, result), true); return flow.view().answerSource; })();
  };
  return (async () => {
    assert.equal(await note({ answer: '초안', mode: 'draft', source: 'draft' }), '전용 OpenAI API로 만든 초안입니다. 내용을 검토하고 내 회신으로 편집해 주세요.');
    assert.equal(await note({ answer: '공개', mode: 'extract', source: 'local' }), 'Board의 관련 공개 발췌문입니다. 생성된 답변이 아닙니다. 내용을 검토하고 내 회신으로 편집해 주세요.');
    // the removed per-request flag has no effect on the note
    assert.doesNotMatch(await note({ answer: '초안', mode: 'draft', source: 'draft', decisionEgress: true }), /Decisions/);
    assert.match(await note({ answer: '초안', mode: 'draft', source: 'draft', screening: 'decision' }), /초안입니다.*관련성 판단에 별도 Decisions API를 사용했습니다\.$/);
    assert.match(await note({ answer: '초안', mode: 'draft', source: 'draft', screening: 'advisory' }), /‘기록만’ 모드라 별도 Decisions API 판단은 선택에 반영하지 않고 이 기기의 단어 일치로 골랐습니다\. 질문과 공개 발췌문은 그 API로 전송되었습니다\.$/);
    assert.match(await note({ answer: '초안', mode: 'draft', source: 'draft', screening: 'fallback' }), /별도 Decisions API 판단을 완료하지 못해 이 기기의 단어 일치로 골랐습니다\. 질문과 공개 발췌문이 그 API로 전송되었을 수 있습니다\.$/);
    assert.match(await note({ answer: '', mode: 'draft', source: 'decision', screening: 'decision' }), /^이 질문에 쓸 관련 공개 발췌문을 찾지 못했습니다\. 직접 회신을 쓸 수 있습니다\. 관련성 판단에 별도 Decisions API를 사용했습니다\.$/);
  })();
});

test('stale, unavailable, expired and late receipts never run or rebind', async () => {
  assert.equal(boardAgentAskSupported({ capabilities: { portable: ['reviewHandoff'] } }), false);
  assert.equal(boardAgentAskSupported({ capabilities: { portable: ['boardAgentAsk'] } }), true);
  const stale = harness({ policy: { ...basePolicy, stale: true } }); await stale.open(true);
  assert.equal(stale.find('prepare'), undefined);
  const h = harness({ services: { decision: false, draft: true, model: null } }); await h.open(true);
  assert.equal(h.find('mode-draft'), undefined); assert.equal(h.find('decision'), undefined);
  h.changed = { question: '바뀐 질문' }; await h.click('prepare'); assert.equal(h.find('run'), undefined); assert.equal(h.calls.at(-1).endpoint, 'cancel');
  const exp = harness(); await exp.open(true); await exp.click('prepare'); exp.setTime(2100); await exp.click('run');
  assert.equal(exp.calls.at(-1).endpoint, 'cancel');
  const exit = harness(); await exit.open(true);
  const late = deferred(); exit.pending = { endpoint: 'prepare', ...late };
  const pending = exit.click('prepare'); exit.click('close'); late.resolve(); await pending;
  assert.equal(exit.calls.at(-1).endpoint, 'cancel'); assert.equal(exit.flow.view(), null);
  const other = harness(); await other.open(true); await other.click('prepare');
  const run = deferred(); other.pending = { endpoint: 'run', ...run };
  const inFlight = other.click('run'); other.invalidate(); run.resolve(); await inFlight;
  assert.equal(other.calls.at(-1).endpoint, 'cancel'); assert.equal(other.answers.length, 0);
});

test('coded review masks the code, requires encryption, and never exports the inserted answer automatically', async () => {
  const calls = [];
  const flow = createReviewFlow({ getContext: () => ({}), isContextCurrent: () => true, isBoardCurrent: () => true,
    store: { check() {}, issue() {} }, pickFile: async () => ({ bytes: new Uint8Array([1]) }),
    request: async (_method, path, body) => {
      calls.push({ path, body });
      if (path.endsWith('/inspect')) return { status: 200, body: { locked: false, encrypted: true, review } };
      return { status: 201, body: { review: body.review.kind === 'request' ? { ...body.review, ...pair } : body.review, encrypted: !!body.passphrase } };
    },
  });
  const render = opts => reviewDialogContent(el, flow.view(), flow, opts).children;
  const find = (tree, name) => walk(tree).find(node => node.props?.data?.testid === `review-${name}`);
  flow.openRequest(board);
  assert.equal(find(render({}), 'askCode'), undefined);
  assert.equal(find(render({ askCodeEnabled: true }), 'askCode').props.type, 'password');
  flow.previewRequest({ ...fields, askCode });
  assert.equal(find(render({ askCodeEnabled: true }), 'password-mode').disabled, true);
  assert.doesNotMatch(text(render({ askCodeEnabled: true })), /egask1/);
  await flow.exportFile(); assert.equal(calls.length, 0);
  await flow.exportFile({ passphrase: '테스트 암호-123', confirm: '테스트 암호-123', passwordProtected: true });
  assert.equal(calls[0].body.review.askCode, askCode);
  flow.openFile(); await flow.chooseFile();
  assert.equal(find(render({}), 'board-agent-ask'), undefined);
  let activated = false;
  find(render({ onBoardAgentAsk: () => { activated = true; } }), 'board-agent-ask').props.onclick();
  assert.ok(activated);
  flow.beginAgentReply(flow.view().review, board, { mode: 'extract', answer: '공개\n<표>', source: 'local' });
  assert.equal(find(render({}), 'answer').value, '공개\n<표>');
  assert.equal(calls.length, 2);
  flow.previewReply('내가 확인한 회신'); assert.equal(calls.length, 2);
  await flow.exportFile(); assert.deepEqual(calls[2].body.review, { kind: 'reply', ...pair, answer: '내가 확인한 회신' });
});
