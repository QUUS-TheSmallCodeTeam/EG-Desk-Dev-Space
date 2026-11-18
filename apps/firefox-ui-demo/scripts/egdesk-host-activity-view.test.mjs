import test from 'node:test';
import assert from 'node:assert/strict';
import * as View from '../overlay/resources/EGDeskHostActivityView.sys.mjs';
import { createHostControl } from '../helper/egdesk-host-control.mjs';
import { readSurfaceSource } from './egdesk-surface-source.mjs';

// CU-01: the host-activity Desk window's view models and DOM, fed by the real
// helper state shape (egdesk-host-control) with a fake agent and clock.
function helperState({ monitor = false } = {}) {
  const clock = { mono: 1000, wall: 1_800_000_000_000 };
  const agent = {
    alive: true,
    status: () => ({ state: 'ready', alive: agent.alive, inputMonitor: false, code: null, failures: 0 }),
    guardAlive: () => agent.alive,
    attachLease(lease) { lease.setInputMonitor(monitor); return () => {}; },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  const sent = [];
  const control = createHostControl({
    makeAgent: onEvent => { agent.onEvent = onEvent; return agent; },
    emit: event => sent.push(event), monotonic: () => clock.mono, now: () => clock.wall,
    setRepeat: () => 1, clearRepeat: () => {}, defer: fn => fn(),
  });
  control.ensureAgent();
  return { control, agent, sent, clock };
}
const fixedTime = at => `T${at}`;

class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.className = ''; this._text = ''; this.listeners = new Map(); this.disabled = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  get firstChild() { return this.children[0] ?? null; }
  append(...nodes) { this.children.push(...nodes); }
  removeChild(node) { this.children = this.children.filter(child => child !== node); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
}
const walk = node => [node, ...node.children.flatMap(walk)];
const byTestId = (node, id) => walk(node).filter(item => item.getAttribute('data-testid') === id);

test('a fresh bridge state reads fail closed in Korean, with every control the view needs', () => {
  const { control } = helperState();
  const state = View.normalizeHostActivity(control.state());
  const view = View.hostActivityView(state, { formatTime: fixedTime });
  assert.equal(view.status, 'live');
  assert.equal(view.controller.label, '조작하는 쪽 없음');
  assert.equal(view.lease.label, 'Agent 입력 막힘');
  assert.match(view.lease.epochLabel, /^차례 \d+$/);
  assert.equal(view.gate.label, '입력 게이트 닫힘');
  assert.equal(view.agent.label, '관찰 중 · 입력 없음');
  assert.deepEqual(view.actions.map(action => action.id), ['pause', 'stopApp', 'stop', 'handBack']);
  assert.equal(view.actions.find(action => action.id === 'stopApp').enabled, false, 'no front app known yet');
  assert.equal(view.actions.find(action => action.id === 'stop').enabled, true, 'stopping is always allowed');
  assert.ok(view.notes.includes(View.HOST_ACTIVITY_NOTES.observeOnly));
  assert.ok(view.notes.includes(View.HOST_ACTIVITY_NOTES.codexDisplayOnly), 'REA 10: Codex is shown, not stopped automatically');
});

test('host and Codex events become the target and timeline; metadata only, unknown fields dropped', () => {
  const { control, agent, sent } = helperState();
  agent.onEvent({ type: 'host.event', event: 'app.activated', app: { bundleId: 'com.apple.TextEdit', pid: 9, name: 'TextEdit' }, at: 1_800_000_000_000 });
  control.onChatEvent({ type: 'chat.event', event: 'computer.used', details: { runId: 'run-1', calls: 2, lastAt: 1_800_000_000_000, active: true } });
  let state = View.normalizeHostActivity(control.state({ rows: false }));
  assert.deepEqual(state.rows, []);
  for (const event of sent) state = View.reduceHostActivityEvent(state, event);
  const again = View.reduceHostActivityEvent(state, sent.find(event => event.type === 'host.activity'));
  assert.equal(again, state, 'a row already kept is not added twice');
  const view = View.hostActivityView(state, { formatTime: fixedTime });
  assert.equal(view.target.label, 'TextEdit');
  assert.equal(view.target.sub, 'com.apple.TextEdit · pid 9');
  assert.equal(view.controller.label, 'Codex 컴퓨터 조작 중');
  assert.equal(view.codex, 'Codex 컴퓨터 조작 2번째 진행 중');
  const titles = view.rows.map(row => row.title);
  assert.ok(titles.includes('앞 앱: TextEdit'));
  assert.ok(titles.includes('Codex 컴퓨터 조작 시작 · 2번째'));
  assert.equal(view.actions.find(action => action.id === 'stopApp').enabled, true);
  // A forged row with private fields keeps only what its kind carries.
  const forged = View.reduceHostActivityEvent(state, { type: 'host.activity', row: { seq: 999, at: 1, kind: 'front-app', app: { name: 'Mail', title: '비밀 제목' }, typed: '비밀번호', screenshot: 'data:' } });
  const text = JSON.stringify(forged);
  for (const secret of ['비밀 제목', '비밀번호', 'data:']) assert.ok(!text.includes(secret), secret);
  assert.equal(View.reduceHostActivityEvent(state, { type: 'host.activity', row: { seq: 1000, at: 1, kind: 'screenshot' } }), state);
});

test('control requests carry the epochs the screen showed; the helper accepts them', async () => {
  const { control } = helperState({ monitor: true });
  control.pulse();
  let state = View.normalizeHostActivity(control.state());
  const handBack = View.hostControlRequest('handBack', state);
  assert.deepEqual(handBack, { path: '/host/control', body: { action: 'handBack', epoch: state.lease.epoch, gateEpoch: state.gate.epoch } });
  const result = await control.control(handBack.body);
  assert.equal(View.hostControlResultText('handBack', result), 'Agent에게 돌려줬습니다.');
  state = View.normalizeHostActivity(control.state());
  assert.equal(View.hostActivityView(state).gate.label, '입력 게이트 열림');
  assert.deepEqual(View.hostControlRequest('stop', state).body, { action: 'stop' });
  const stopped = await control.control(View.hostControlRequest('stop', state).body);
  assert.match(View.hostControlResultText('stop', stopped), /^모든 Agent 입력을 멈췄습니다/);
  // The old epochs are refused by the helper.
  await assert.rejects(control.control(handBack.body), error => {
    assert.equal(View.hostControlErrorText(error), '그 사이 입력권 상태가 바뀌었습니다. 새 상태를 확인한 뒤 다시 눌러 주세요.');
    return true;
  });
  assert.equal(View.hostControlRequest('stopApp', state), null, 'no target app, no request');
  assert.equal(View.hostControlRequest('teleport', state), null);
  assert.equal(View.hostControlRequest('pause', null), null);
  const after = View.hostActivityView(View.normalizeHostActivity(control.state()), { formatTime: fixedTime });
  assert.equal(after.gate.reason, '중지 요청');
  assert.ok(after.rows.some(row => row.title === '모든 Agent 입력 중지'));
});

test('handback requires two displayed epochs and reports a failed reopen as failure', async () => {
  const { control, agent } = helperState({ monitor: true });
  agent.alive = false;
  await control.control({ action: 'stop' });
  const state = View.normalizeHostActivity(control.state());
  const incomplete = { ...state, gate: { ...state.gate, epoch: null } };
  assert.equal(View.hostControlRequest('handBack', incomplete), null);
  assert.equal(View.hostActivityView(incomplete).actions.find(action => action.id === 'handBack').enabled, false);
  const request = View.hostControlRequest('handBack', state);
  const result = await control.control(request.body);
  assert.equal(result.ok, false);
  assert.match(View.hostControlResultText('handBack', result), /관찰 도우미 신호가 없어 돌려주지 못했습니다/);
});

test('offline keeps the last rows but disables every control', () => {
  const { control } = helperState();
  const view = View.hostActivityView(View.normalizeHostActivity(control.state()), { connected: false });
  assert.equal(view.status, 'offline');
  assert.equal(view.title, '연결이 끊겨 지금 상태가 아닙니다');
  assert.ok(view.actions.every(action => action.enabled === false));
  assert.equal(View.hostActivityView(null, { connected: false }).title, '연결이 끊겼습니다');
  assert.equal(View.normalizeHostActivity(null), null);
});

test('the DOM view draws facts, actions and rows, and calls onAction only for enabled buttons', () => {
  const { control } = helperState();
  const document = { createElement: tag => new Node(tag) };
  const dom = View.createEGDeskHostActivityView({ document });
  const pressed = [];
  dom.update(View.hostActivityView(View.normalizeHostActivity(control.state()), { formatTime: fixedTime }), { onAction: id => pressed.push(id), notice: { text: '알림', tone: 'status' } });
  assert.equal(byTestId(dom.element, 'host-activity-lease').length, 1);
  assert.match(byTestId(dom.element, 'host-activity-gate')[0].textContent, /입력 게이트 닫힘/);
  byTestId(dom.element, 'host-activity-action-stop')[0].click();
  byTestId(dom.element, 'host-activity-action-stopApp')[0].click();
  assert.deepEqual(pressed, ['stop']);
  assert.ok(byTestId(dom.element, 'host-activity-row').length >= 1);
  assert.equal(byTestId(dom.element, 'host-activity-notice')[0].getAttribute('role'), 'status');
  dom.update(View.hostActivityView(View.normalizeHostActivity(control.state())), { onAction: id => pressed.push(id), busy: true });
  byTestId(dom.element, 'host-activity-action-stop')[0].click();
  assert.deepEqual(pressed, ['stop'], 'busy disables the buttons');
  assert.throws(() => View.createEGDeskHostActivityView({}), TypeError);
});

test('the surface opens the view from the 컴퓨터 조작 settings section and follows the SSE frames', () => {
  const source = readSurfaceSource();
  assert.match(source, /EGDeskHostActivityView\.sys\.mjs/);
  assert.match(source, /case 'host\.activity':/);
  assert.match(source, /case 'host\.control':/);
  assert.match(source, /settings-computer-host-activity/);
  assert.match(source, /kind: 'host-activity'/);
});

// ============ CU-05 in-app emergency stop chord ============

test('CU-05: the in-app stop chord matches the helper gate exactly: Ctrl+Alt+Shift by physical Period, Command up', async () => {
  const { isEmergencyStopChord, EMERGENCY_STOP_CHORD } = await import('../helper/egdesk-host-input-gate.mjs');
  assert.equal(View.EMERGENCY_STOP_LABEL, EMERGENCY_STOP_CHORD.label);
  const cases = [];
  for (const ctrlKey of [true, false]) for (const altKey of [true, false]) for (const shiftKey of [true, false]) for (const metaKey of [true, false]) {
    for (const [code, key] of [['Period', '>'], ['Period', '≥'], ['Comma', '.'], ['', '.'], ['', '>'], [undefined, ','], ['KeyQ', '.']]) {
      cases.push({ ctrlKey, altKey, shiftKey, metaKey, code, key });
    }
  }
  for (const event of [...cases, null, 'x', {}]) assert.equal(View.isEmergencyStopChord(event), isEmergencyStopChord(event), JSON.stringify(event));
  assert.equal(View.isEmergencyStopChord({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: false, code: 'Period', key: '˘' }), true,
    'the character macOS Alt makes does not matter');
  assert.equal(View.isEmergencyStopChord({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: true, code: 'Period' }), false, 'Command held: never');
  assert.deepEqual(View.EMERGENCY_STOP_REQUEST, { path: '/host/control', body: { action: 'emergencyStop' } });
});

test('CU-05: the chord posts one emergencyStop at a time, says the result in Korean, and other keys pass through', async () => {
  const posts = [], notices = [];
  let release;
  const shortcut = View.createEmergencyStopShortcut({
    post: body => { posts.push(body); return new Promise(resolve => { release = resolve; }); },
    notify: notice => notices.push(notice) });
  const chord = { ctrlKey: true, altKey: true, shiftKey: true, metaKey: false, code: 'Period', key: '>' };
  assert.equal(shortcut.keydown({ ...chord, code: 'KeyW' }), false, 'not the chord: untouched');
  assert.equal(shortcut.keydown(chord), true);
  await Promise.resolve();
  assert.deepEqual(posts, [{ action: 'emergencyStop' }], 'no epoch needed: stop is always allowed');
  assert.equal(shortcut.keydown({ ...chord, repeat: true }), true, 'a repeat is taken but not sent');
  assert.equal(shortcut.keydown(chord), true, 'a second press while the first is in flight is not sent');
  assert.equal(posts.length, 1);
  release({ ack: { notDispatched: 2 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shortcut.busy(), false);
  assert.deepEqual(notices.at(-1), { tone: 'status', text: '긴급 중지(Ctrl+Alt+Shift+.): 모든 Agent 입력을 멈췄습니다. 보내지 않은 동작 2개를 버렸습니다.' });
  const failing = View.createEmergencyStopShortcut({ post: async () => { throw Object.assign(new Error('x'), { status: 502 }); }, notify: notice => notices.push(notice) });
  failing.keydown(chord);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notices.at(-1).tone, 'error');
  assert.match(notices.at(-1).text, /^긴급 중지를 보내지 못했습니다\./);
  const offline = View.createEmergencyStopShortcut({ post: null, notify: notice => notices.push(notice) });
  assert.equal(offline.keydown(chord), true);
  assert.equal(notices.at(-1).text, '연결이 없어 긴급 중지를 보내지 못했습니다.');
});

test('CU-05: the EG-Desk window takes the chord in capture, consumes it and posts through the bridge host control', () => {
  const source = readSurfaceSource();
  const install = source.match(/  function installEmergencyStopShortcut\(\) \{\n([\s\S]*?)\n  \}\n/)?.[1] || '';
  assert.match(install, /HostActivityView\.createEmergencyStopShortcut\(/);
  assert.match(install, /return state\.codexBridge\.hostControl\(body\);/);
  assert.match(install, /if \(!shortcut\.keydown\(ev\)\) return;\n      ev\.preventDefault\(\);\n      ev\.stopImmediatePropagation\(\);/);
  assert.match(install, /window\.addEventListener\('keydown', onKeyDown, true\);/);
  assert.match(source, /      installDeskCloseShortcut\(\);\n      installEmergencyStopShortcut\(\);/);
});
