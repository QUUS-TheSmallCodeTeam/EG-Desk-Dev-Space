// a1 (L1): Browser task step lines in Chat and the frame on the Card (EGDeskBrowserStepsView.sys.mjs + the surface wiring).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const View = await import('../overlay/resources/EGDeskBrowserStepsView.sys.mjs');
const ChatState = await import('../overlay/resources/EGDeskChatState.sys.mjs');
const surfaceSource = fs.readFileSync(fileURLToPath(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url)), 'utf8');
const surfaceCss = fs.readFileSync(fileURLToPath(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url)), 'utf8');

const step = (seq, extra = {}) => ({ threadId: 'thread-a', taskId: 'task-1', cardId: 'browser-a', seq, op: 'fill', target: '검색칸',
  valueName: '검색어', ok: true, ms: 312, by: 'decision', ...extra });

test('a step keeps labels and the name of a value, never more, and is refused without room, task or order', () => {
  const normalized = View.normalizeBrowserStep(step(0, { value: '우산', text: 'secret typed', target: { label: '  검색\n칸 ', value: 'x' } }), { ts: 1000 });
  assert.deepEqual(normalized, { clientThreadId: 'thread-a', taskId: 'task-1', seq: 0, op: 'fill', cardId: 'browser-a', target: '검색 칸',
    valueName: '검색어', ok: true, ms: 312, by: 'decision', ts: 1000 });
  assert.equal(JSON.stringify(normalized).includes('우산'), false);
  assert.equal(JSON.stringify(normalized).includes('secret'), false);
  assert.equal(View.normalizeBrowserStep({ ...step(0), threadId: '' }), null);
  assert.equal(View.normalizeBrowserStep({ ...step(0), taskId: undefined }), null);
  assert.equal(View.normalizeBrowserStep({ ...step(0), seq: -1 }), null);
  assert.equal(View.normalizeBrowserStep({ ...step(0), seq: 1.5 }), null);
  assert.equal(View.normalizeBrowserStep(null), null);
  assert.equal(View.normalizeBrowserStep(step(0, { by: 'someone' })).by, 'decision');
  assert.equal(View.normalizeBrowserStep(step(0, { by: 'model' })).by, 'model');
  assert.equal(View.normalizeBrowserStep(step(0, { clientThreadId: 'thread-b' })).clientThreadId, 'thread-b', 'either name of the room');
});

test('ops from the tools, the reflex and the contract read as one vocabulary', () => {
  for (const [raw, op] of [['egdesk_browser_fill', 'fill'], ['TYPE_TEXT', 'fill'], ['type', 'fill'], ['CLICK', 'click'], ['egdesk_browser_click', 'click'],
    ['press_key', 'press'], ['SELECT', 'select'], ['SCROLL_DOWN', 'scroll'], ['navigate', 'navigate'], ['observe', 'observe'],
    ['WAIT', 'wait'], ['submit', 'submit'], ['DONE', 'done'], ['BLOCKED', 'blocked'], ['handoff', 'handoff'], ['dance', 'other'], [undefined, 'other']]) {
    assert.equal(View.browserStepOp(raw), op, String(raw));
  }
  assert.equal(View.browserStepByCallId('call_7.reflex-3-0b3c'), 'decision');
  assert.equal(View.browserStepByCallId('direct-task.reflex-1-uuid'), 'decision');
  assert.equal(View.browserStepByCallId('toolu_01ABC'), 'model');
  assert.equal(View.browserStepByCallId(undefined), 'model');
});

test('each line says who did what and how long it took (proposed words)', () => {
  const line = (raw, engineId = 'claude') => View.browserStepLine(View.normalizeBrowserStep(raw, { ts: 1 }), { engineId }).line;
  assert.equal(line(step(0)), "결정 모델 · 검색칸에 '검색어' 입력 · 0.3초");
  assert.equal(line(step(1, { op: 'click', target: '검색', valueName: undefined, ms: 420 })), "결정 모델 · '검색' 누름 · 0.4초");
  assert.equal(line(step(2, { op: 'click', target: '다음', by: 'model', ms: 1210 })), "Claude · '다음' 누름 · 1.2초");
  assert.equal(line(step(3, { op: 'click', target: '다음', by: 'model', ms: 1210 }), 'codex'), "Codex · '다음' 누름 · 1.2초");
  assert.equal(line(step(4, { op: 'scroll', direction: 'down', target: undefined, ms: 50 })), '결정 모델 · 아래로 스크롤 · 0.1초');
  assert.equal(line(step(5, { op: 'click', target: '결제', ok: false, ms: 12000 })), "결정 모델 · '결제' 누름 실패 · 12초");
  assert.equal(line(step(6, { op: 'handoff', status: 'needs_value' })), 'Claude가 이어받음 (값 필요)');
  assert.equal(line(step(7, { op: 'fill', status: 'low_confidence' })), 'Claude가 이어받음 (확신 낮음)');
  assert.equal(line(step(8, { op: 'handoff' }), 'unknown-engine'), '대화 모델이 이어받음');
  assert.equal(line(step(9, { op: 'blocked', target: undefined, ms: undefined })), '결정 모델 · 더 진행할 수 없음', 'blocked by itself is not a handoff line');
  assert.equal(line(step(10, { op: 'done', target: undefined, ms: undefined })), '결정 모델 · 작업 끝');
  assert.equal(line(step(11, { op: 'observe', target: undefined })), '결정 모델 · 화면 읽음 · 0.3초');
});

test('a room keeps each task step once, in time order, from frames and from its runs, within a limit', () => {
  let list = [];
  list = View.addBrowserStep(list, step(1), { ts: 20 });
  list = View.addBrowserStep(list, step(0), { ts: 10 });
  list = View.addBrowserStep(list, step(1, { ok: false }), { ts: 20 });
  list = View.addBrowserStep(list, { ...step(0), threadId: 'thread-b' }, { ts: 15 });
  assert.equal(list.length, 3);
  const same = View.addBrowserStep(list, { nothing: true });
  assert.equal(same, list, 'an unusable step changes nothing (the same array)');
  const run = { browserSteps: [View.normalizeBrowserStep(step(2), { ts: 30 }), View.normalizeBrowserStep(step(1), { ts: 20 })] };
  const mine = View.browserStepsFor(list, 'thread-a', [run]);
  assert.deepEqual(mine.map(item => [item.seq, item.ts]), [[0, 10], [1, 20], [2, 30]]);
  assert.deepEqual(View.browserStepsFor(list, 'thread-b').map(item => item.clientThreadId), ['thread-b']);
  assert.deepEqual(View.browserStepsFor(list, ''), []);
  let many = [];
  for (let seq = 0; seq < 30; seq++) many = View.addBrowserStep(many, step(seq), { ts: seq, limit: 25 });
  assert.equal(many.length, 25);
  assert.equal(many[0].seq, 5, 'the oldest go first');
});

test('steps are placed where they happened: one block per task between two messages, the rest at the end', () => {
  const steps = [0, 1, 2].map(seq => View.normalizeBrowserStep(step(seq), { ts: 100 + seq }))
    .concat([View.normalizeBrowserStep({ ...step(0), taskId: 'task-2' }, { ts: 150 }), View.normalizeBrowserStep(step(3), { ts: 300 })]);
  const placement = View.browserStepPlacement(steps);
  assert.deepEqual(placement.take(50), [], 'nothing before the user message');
  const beforeAnswer = placement.take(200);
  assert.deepEqual(beforeAnswer.map(block => [block.key, block.steps.map(item => item.seq)]), [['task-1:0', [0, 1, 2]], ['task-2:0', [0]]]);
  assert.deepEqual(placement.take().map(block => [block.key, block.steps.length]), [['task-1:3', 1]], 'a later step of the same task starts its own block');
  assert.deepEqual(placement.take(), []);
});

test('a long task folds to its summary and newest line; the toggle words say how many are hidden', () => {
  const steps = [0, 1, 2, 3, 4].map(seq => View.normalizeBrowserStep(step(seq, seq === 4 ? { by: 'model', op: 'click', target: '확인' } : {}), { ts: seq }));
  const folded = View.browserStepsBlockView({ key: 'task-1:0', steps }, { engineId: 'claude' });
  assert.equal(folded.summary, '브라우저 작업 · 결정 모델 4단계 · Claude 1단계 · 1.6초');
  assert.equal(folded.collapsed, true);
  assert.deepEqual(folded.lines.map(row => row.line), ["Claude · '확인' 누름 · 0.3초"]);
  assert.equal(folded.hiddenCount, 4);
  assert.equal(folded.toggleLabel, '4단계 더 보기');
  const open = View.browserStepsBlockView({ key: 'task-1:0', steps }, { engineId: 'claude', open: true });
  assert.equal(open.lines.length, 5);
  assert.equal(open.toggleLabel, '접기');
  const short = View.browserStepsBlockView({ key: 'k', steps: steps.slice(0, 2) });
  assert.equal(short.foldable, false);
  assert.equal(short.toggleLabel, '');
  assert.equal(short.lines.length, 2);
});

test('a Card caption names who acted and on what, never the typed text; a frame only on the page it was read on', () => {
  const reading = View.browserStepReading({ documentId: 'doc-1', viewport: { width: 1440, height: 900 },
    interactiveElements: [{ ref: 'el_2', bounds: { x: 100, y: 90, width: 400, height: 40 } }, { ref: 'el_3' }] });
  assert.deepEqual(reading.bounds.get('el_2'), { x: 100, y: 90, width: 400, height: 40 });
  assert.equal(reading.bounds.has('el_3'), false);
  const fill = { kind: 'act', callId: 'entry.reflex-2-x', clientThreadId: 'thread-a', action: { type: 'fill', ref: 'el_2', text: '우산 SECRET' },
    guard: { documentId: 'doc-1', viewport: { width: 1440, height: 900 }, target: { ref: 'el_2', role: 'searchbox', label: '검색', value: 'old' } } };
  const view = View.browserStepCardView({ request: fill, response: { status: 'acted', receipt: { after: { documentId: 'doc-1' } } }, reading, engineId: 'claude' });
  assert.equal(view.by, 'decision');
  assert.equal(view.caption, '결정 모델 · 검색에 입력');
  assert.deepEqual(view.box, { left: 6.94, top: 10, width: 27.78, height: 4.44 }, 'the last reading gives the bounds the request lacks');
  assert.equal(JSON.stringify(view).includes('SECRET'), false);
  const click = { kind: 'act', callId: 'toolu_1', action: { type: 'click', ref: 'el_9' },
    guard: { documentId: 'doc-1', viewport: { width: 1000, height: 500 }, target: { ref: 'el_9', label: '검색', bounds: { x: 900, y: 450, width: 200, height: 100 } } } };
  const clicked = View.browserStepCardView({ request: click, response: { status: 'acted', receipt: { after: { documentId: 'doc-1' } } }, engineId: 'codex' });
  assert.equal(clicked.caption, "Codex · '검색' 누름");
  assert.deepEqual(clicked.box, { left: 90, top: 90, width: 10, height: 10 }, 'the observed bounds of the request, clipped to the page');
  const navigated = View.browserStepCardView({ request: click, response: { status: 'acted', receipt: { after: { documentId: 'doc-2' } } } });
  assert.equal(navigated.box, null, 'the page changed: caption only');
  assert.equal(View.browserStepCardView({ request: click, response: { status: 'rejected' }, outcome: 'refused' }).caption, "대화 모델 · '검색' 누름 · 거부됨");
  assert.equal(View.browserStepCardView({ request: click, outcome: 'refused' }).box, null);
  const otherDoc = View.browserStepCardView({ request: { ...fill, guard: { ...fill.guard, documentId: 'doc-9', target: { ref: 'el_2', label: '검색' } } }, reading });
  assert.equal(otherDoc.box, null, 'a reading of another document gives no frame');
  assert.equal(View.browserStepCardView({ request: { kind: 'observe' } }), null, 'a reading has no caption');
  assert.equal(View.browserStepCardView({ request: { kind: 'act', action: { type: 'snapshot' } } }), null);
  assert.equal(View.browserStepHighlightBox({ x: 2000, y: 0, width: 10, height: 10 }, { width: 1000, height: 500 }), null, 'off the page');
  assert.equal(View.browserStepHighlightBox({ x: 0, y: 0, width: 0, height: 10 }, { width: 1000, height: 500 }), null);
  assert.equal(View.browserStepHighlightBox(null, { width: 1000, height: 500 }), null);
});

test('a run keeps its Browser task steps from the chat event browserTask.step', () => {
  const protocol = ChatState.createChatProtocolState ? ChatState.createChatProtocolState() : { runs: {}, streams: {}, connection: 'online' };
  const base = { type: 'chat.event', v: 2, provider: 'codex', engineId: 'codex', streamId: 'stream-1', requestId: 'req-1',
    clientThreadId: 'thread-a', conversationId: 'conv-1', runId: 'run-1', answerId: 'run-1' };
  ChatState.reduceChatEvent(protocol, { ...base, event: 'run.started', seq: 1, ts: 10, details: { status: 'inProgress' } });
  const run = ChatState.reduceChatEvent(protocol, { ...base, event: 'browserTask.step', seq: 2, ts: 20, details: step(0) });
  assert.ok(run, 'the event is admitted to its run');
  assert.deepEqual(run.browserSteps.map(item => [item.clientThreadId, item.taskId, item.seq, item.ts]), [['thread-a', 'task-1', 0, 20]]);
  const again = ChatState.reduceChatEvent(protocol, { ...base, event: 'browserTask.step', seq: 3, ts: 21, details: { ...step(0), ok: false } });
  assert.equal(again.browserSteps.length, 1, 'the same task step replaces its earlier copy');
  assert.equal(again.browserSteps[0].ok, false);
  assert.equal(again.messages.length, 0, 'a step is never a message');
});

test('the surface draws the steps only with the bridge capability, between the messages, and frames the Card from its own record', () => {
  assert.match(surfaceSource, /const BrowserStepsView = ChromeUtils\.importESModule\('chrome:\/\/userchrome\/content\/EGDeskBrowserStepsView\.sys\.mjs'\);/);
  assert.match(surfaceSource, /function bridgeBrowserStepsField\(bridgeState\) \{\n    return \{ browserStepsUi: bridgeState\?\.capabilities\?\.browserSteps === true \};\n  \}/);
  assert.equal((surfaceSource.match(/\.\.\.bridgeSessionFields\(bridgeState\),\n\s+\.\.\.bridgeBrowserStepsField\(bridgeState\),/g) || []).length, 2, 'connect and refresh both read it');
  assert.match(surfaceSource, /case 'browser\.task\.step': \{\n          const before = state\.codex\.browserSteps;\n          state\.codex\.browserSteps = BrowserStepsView\.addBrowserStep\(before, event\);/);
  assert.match(surfaceSource, /const browserStepBlocks = codex\.browserStepsUi === true\n/);
  assert.match(surfaceSource, /formatMessageTime\(notice\.at\)\)\)\);\n            \}\n            appendBrowserSteps\(until\);\n          \};/, 'placed with the control notices, by time');
  assert.match(surfaceSource, /toolActivity: request => browserStepDisplay\.track\(request, startAgentToolActivity\(request\)\),/);
  assert.match(surfaceSource, /card\.addEventListener\('egdesk:browser-agent-action', \(ev\) => \{\n        const entry = ev\.detail, info = pending;\n        if \(!info \|\| entry\?\.source !== 'model-tool' \|\| !shown\(\)\) return;/);
  assert.match(surfaceSource, /      agentProjection\.dispose\(\);\n      browserStepDisplay\.dispose\(\);\n/);
  // The BRW-13 block a test runs on its own does not use the new display (it stays outside the block).
  const block = surfaceSource.slice(surfaceSource.indexOf('    // ---- BRW-13: Agent activity on this Card'), surfaceSource.indexOf('    const browserToolBinding = (roomKey) => {'));
  assert.ok(block.length > 1000);
  assert.equal(/BrowserStepsView|browserStepDisplay/.test(block), false);
  const rule = selector => surfaceCss.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`, 'm'))?.[1] || '';
  for (const selector of ['.egd-codex-browser-steps', '.egd-codex-browser-steps-toggle', '.egd-browser-step-box', '.egd-browser-step-caption']) {
    assert.ok(rule(selector), selector);
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(rule(selector)), false, `${selector} uses tokens only`);
  }
  assert.match(rule('.egd-browser-step-box'), /pointer-events: none !important;/);
  assert.match(rule('.egd-browser-step-caption'), /pointer-events: none !important;/);
  assert.match(rule('.egd-browser-step-caption'), /z-index: 13;/, 'above the Card body capture layer (12)');
});
