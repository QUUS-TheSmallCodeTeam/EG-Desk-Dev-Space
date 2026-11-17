// CTX-04: '바뀜' on composer attachments and the pre-send scope preview.
// Pure model (EGDeskInputContext), renderer (EGDeskChatComposer) and the
// production tray functions compiled from the surface script. No bridge,
// network or Firefox.
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileFunction } from 'node:vm'
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs'
import * as ChatComposer from '../overlay/resources/EGDeskChatComposer.sys.mjs'
import { readSurfaceSource } from './egdesk-surface-source.mjs'

class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map(); this.listeners = new Map(); this.className = ''; this.ownText = ''; this.dataset = {} }
  set innerHTML(_) { throw new Error('textContent only') }
  set textContent(value) { this.children = []; this.ownText = String(value) }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  setAttribute(key, value) { this.attributes.set(key, String(value)) }
  getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null }
  append(...nodes) { for (const node of nodes) if (node != null) this.children.push(node) }
  appendChild(node) { this.append(node); return node }
  addEventListener(type, callback) { this.listeners.set(type, callback) }
  fire(type, event = {}) { return this.listeners.get(type)?.(event) }
  all(predicate, out = []) { for (const child of this.children) { if (predicate(child)) out.push(child); child.all(predicate, out) } return out }
  byTestid(id) { return this.all(node => (node.getAttribute('data-testid') ?? node.dataset.testid) === id) }
}
const document = { createElement: tag => new Node(tag) }

const response = { conversationId: 'conv-1', sources: [
  { sourceId: 's1', kind: 'browser', viewId: 'egd-browser-1', state: 'stale', reason: 'navigated', changedAt: 2000, announcedAt: null },
  { sourceId: 's0', kind: 'browser', viewId: 'egd-browser-1', state: 'active', reason: null, changedAt: null, announcedAt: null },
  { sourceId: 's2', kind: 'file', viewId: 'egd-file-card-2', state: 'stale', reason: 'fileChanged', changedAt: 3000, announcedAt: 3500 },
  { sourceId: 's3', kind: 'file', viewId: 'egd-file-card-3', state: 'active', reason: null, changedAt: null, announcedAt: null },
  { sourceId: 's4', kind: 'file', viewId: 'egd-file-card-4', state: 'stale', reason: 'weird', changedAt: 1000 },
  { sourceId: 's5', kind: 'board-element', viewId: 'egd-shape-1', state: 'stale', reason: 'fileChanged', changedAt: 1 },
  { sourceId: 's6', kind: 'file', state: 'stale', reason: 'fileChanged', changedAt: 1 },
] }

test('sourceChangeIndex keys tracked sources by card, stale wins, unknown reasons stay unknown, other conversations are refused', () => {
  const index = InputContext.sourceChangeIndex(response, 'conv-1')
  assert.deepEqual([...index.byView.keys()], ['egd-browser-1', 'egd-file-card-2', 'egd-file-card-3', 'egd-file-card-4'])
  assert.equal(index.byView.get('egd-browser-1').state, 'stale', 'an active older capture never hides a stale one')
  assert.equal(index.byView.get('egd-file-card-4').reason, 'unknown')
  assert.equal(InputContext.sourceChangeIndex(response, 'conv-2'), null)
  assert.equal(InputContext.sourceChangeIndex({ conversationId: 'conv-1' }, 'conv-1'), null)
  const key = InputContext.sourceChangeIndexKey(index)
  assert.equal(InputContext.sourceChangeIndexKey(InputContext.sourceChangeIndex(structuredClone(response), 'conv-1')), key)
  assert.notEqual(InputContext.sourceChangeIndexKey(InputContext.sourceChangeIndex({ ...response, sources: response.sources.slice(1) }, 'conv-1')), key)
  assert.equal(InputContext.sourceChangeText(index.byView.get('egd-browser-1')), '보낸 뒤 페이지가 바뀜')
  assert.equal(InputContext.sourceChangeText(index.byView.get('egd-file-card-2')), '보낸 뒤 파일이 바뀜')
  assert.equal(InputContext.sourceChangeText(index.byView.get('egd-file-card-3')), '')
})

test('attachmentChange marks only an attachment whose card went stale; absence is never freshness', () => {
  const index = InputContext.sourceChangeIndex(response, 'conv-1')
  assert.equal(InputContext.attachmentChange({ sourceRef: { viewId: 'egd-browser-1' } }, index).label, '바뀜')
  assert.match(InputContext.attachmentChange({ sourceRef: { viewId: 'egd-browser-1' } }, index).title, /보낸 뒤 페이지가 바뀜 · 이전에 보낸 뒤 바뀜/)
  assert.equal(InputContext.attachmentChange({ sourceRef: { viewId: 'egd-file-card-3' } }, index), null)
  assert.equal(InputContext.attachmentChange({ sourceRef: { viewId: 'unknown' } }, index), null)
  assert.equal(InputContext.attachmentChange({ sourceRef: {} }, index), null)
  assert.equal(InputContext.attachmentChange({ sourceRef: { viewId: 'egd-browser-1' } }, null), null)
})

test('sendScopePreview lists what is sent (removable) and changed earlier sources (attachable while on screen)', () => {
  const index = InputContext.sourceChangeIndex(response, 'conv-1')
  const model = InputContext.sendScopePreview({
    inputSources: [{ id: 'a1', kind: 'browser', label: 'Browser · docs', sourceRef: { viewId: 'egd-browser-1' } }, { id: 'a2', kind: 'file', label: 'plan.md', sourceRef: { viewId: 'egd-file-card-9' } }],
    briefingInputs: [{ sourceId: 'brief-1' }],
    changeIndex: index, labelFor: viewId => viewId === 'egd-file-card-2' ? 'report.md' : null, canAttach: viewId => viewId === 'egd-file-card-2',
  })
  assert.deepEqual(model.items.map(item => [item.origin, item.label, item.changed, item.action]), [
    ['attached', 'Browser · docs', true, 'remove'], ['attached', 'plan.md', false, 'remove'], ['briefing', '브리핑 근거', false, 'remove'],
    ['changed', 'report.md', true, 'add'], ['changed', '파일', true, null]])
  assert.equal(model.summary, '이번에 Agent가 볼 자료 3개 · 보낸 뒤 바뀐 자료 2개')
  assert.match(model.boundary, /Desk 전체는 보내지 않습니다/)
  assert.match(model.changedNote, /바뀌었다는 사실만/)
  const empty = InputContext.sendScopePreview({})
  assert.deepEqual([empty.items.length, empty.summary, empty.changedNote], [0, '붙인 자료 없음 · 메시지만 보냅니다', ''])
  const throwing = InputContext.sendScopePreview({ changeIndex: index, labelFor: () => { throw new Error('x') }, canAttach: () => { throw new Error('x') } })
  assert.ok(throwing.items.every(item => item.action === null), 'a failing screen check offers no action')
})

test('renderSendScope draws the preview, keeps its open state and routes remove/add to the host', () => {
  const index = InputContext.sourceChangeIndex(response, 'conv-1')
  const model = InputContext.sendScopePreview({ inputSources: [{ id: 'a1', kind: 'browser', label: '<b>x</b>', sourceRef: { viewId: 'egd-browser-1' } }],
    changeIndex: index, canAttach: () => true, labelFor: () => 'report.md' })
  const calls = []
  const node = ChatComposer.renderSendScope({ document, model, open: true, onRemove: item => calls.push(['remove', item.sourceId]), onAdd: item => calls.push(['add', item.viewId]), onToggle: open => calls.push(['toggle', open]) })
  assert.equal(node.getAttribute('data-testid'), 'chat-send-scope')
  assert.equal(node.open, true)
  assert.equal(node.getAttribute('data-count'), '1')
  const rows = node.byTestid('chat-send-scope-item')
  assert.deepEqual(rows.map(row => row.getAttribute('data-origin')), ['attached', 'changed', 'changed'])
  assert.equal(rows[0].byTestid('chat-send-scope-changed')[0].textContent, '바뀜')
  assert.match(rows[0].textContent, /<b>x<\/b>/, 'labels stay text')
  rows[0].byTestid('chat-send-scope-remove')[0].fire('click')
  rows[1].byTestid('chat-send-scope-add')[0].fire('click')
  node.open = false; node.fire('toggle')
  assert.deepEqual(calls, [['remove', 'a1'], ['add', 'egd-file-card-2'], ['toggle', false]])
  assert.equal(ChatComposer.renderSendScope({ document, model: null }), null)
  const noHandlers = ChatComposer.renderSendScope({ document, model })
  assert.equal(noHandlers.byTestid('chat-send-scope-remove').length, 0)
})

test('production tray: \'바뀜\' chip on a changed attachment and a preview whose actions use the existing attach/remove paths', () => {
  const source = readSurfaceSource()
  const declaration = name => { const match = source.match(new RegExp(`^  function ${name}\\([^]*?^  \\}`, 'm')); assert.ok(match, name); return match[0] }
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'data') Object.assign(node.dataset, value)
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value)
    }
    for (const child of children.flat()) { if (child == null) continue; if (typeof child === 'string') node.ownText += child; else node.append(child) }
    return node
  }
  const views = { 'egd-browser-1': { id: 'egd-browser-1' }, 'egd-file-card-2': { id: 'egd-file-card-2' } }
  const state = { contextSourceChanges: { room: { conversationId: 'conv-1', index: InputContext.sourceChangeIndex(response, 'conv-1') } } }
  const notices = [], calls = []
  const deps = { state, el, InputContext, ChatComposer, document: { ...document, getElementById: id => views[id] || null },
    openChatInputPanel() {}, buildChatRequestProjectControl: () => el('span', { class: 'project' }), boardNotice: text => notices.push(text),
    contextCandidateLabel: view => view ? `label:${view.id}` : null, contextResolverKindForView: view => view ? 'file' : null,
    chatInputSourceForView: view => view ? { kind: 'file', viewId: view.id } : null, userSelectedChatSources: (threadId, sources) => sources.map(item => ({ ...item, selected: threadId })) }
  const api = compileFunction(`${['buildChatInputTray', 'chatSourceChangeIndex'].map(declaration).join('\n')}
const chatSendScopeOpen = new Set();
${declaration('buildChatSendScope')}
return { buildChatInputTray };`, Object.keys(deps))(...Object.values(deps))
  const bridge = { refreshContextSources: id => calls.push(['refresh', id]), removeInputSource: (id, sourceId) => calls.push(['remove', id, sourceId]),
    removeBriefingInput: (id, sourceId) => calls.push(['removeBriefing', id, sourceId]), addInputSources: (id, sources) => calls.push(['add', id, sources]) }
  const thread = { id: 'room', conversationId: 'conv-1', inputSources: [{ id: 'a1', kind: 'browser', label: 'Browser · docs', sourceRef: { viewId: 'egd-browser-1' } }], briefingInputs: [] }
  const tray = api.buildChatInputTray(thread, bridge)
  const chip = tray.byTestid('chat-attachment')[0]
  assert.equal(chip.dataset.changed, 'true')
  assert.equal(chip.byTestid('chat-attachment-changed')[0].textContent, '바뀜')
  const scope = tray.byTestid('chat-send-scope')[0]
  assert.ok(scope, 'the preview is in the tray')
  assert.equal(scope.open, undefined, 'closed until opened')
  scope.byTestid('chat-send-scope-remove')[0].fire('click')
  const add = scope.byTestid('chat-send-scope-add')
  assert.equal(add.length, 1, 'only the changed card still on screen can be attached again')
  add[0].fire('click')
  assert.deepEqual(calls, [['refresh', 'room'], ['remove', 'room', 'a1'], ['add', 'room', [{ kind: 'file', viewId: 'egd-file-card-2', selected: 'room' }]]])
  scope.open = true; scope.fire('toggle')
  assert.equal(api.buildChatInputTray(thread, bridge).byTestid('chat-send-scope')[0].open, true, 'open state survives a redraw')
  // Another conversation's cache is never applied; no bridge hook → no preview.
  const other = api.buildChatInputTray({ ...thread, conversationId: 'conv-x' }, bridge)
  assert.equal(other.byTestid('chat-attachment')[0].dataset.changed, undefined)
  assert.equal(api.buildChatInputTray(thread, {}).byTestid('chat-send-scope').length, 0)
})

// ============ CTX-04 run-time refresh: tool results ask again, still at most every 15 s ============

test('CTX-04 refresh plan: a draw reads once per 15 s; a run signal inside the window leaves one trailing read', () => {
  const key = '{"conversationId":"c1"}';
  const plan = InputContext.contextSourceRefreshPlan;
  assert.equal(InputContext.CONTEXT_SOURCE_REFRESH_MS, 15000);
  assert.deepEqual(plan({ cached: null, key, now: 0 }), { read: true, delayMs: null }, 'first read');
  assert.deepEqual(plan({ cached: { key: 'other', at: 0 }, key, now: 1 }), { read: true, delayMs: null }, 'another scope reads at once');
  const cached = { key, at: 10_000, loading: false };
  assert.deepEqual(plan({ cached, key, now: 14_000 }), { read: false, delayMs: null }, 'a draw inside the window waits');
  assert.deepEqual(plan({ cached, key, now: 14_000, signal: true }), { read: false, delayMs: 11_000 }, 'a tool result inside the window: one read when it ends');
  assert.deepEqual(plan({ cached, key, now: 14_000, signal: true, trailing: true }), { read: false, delayMs: null }, 'never a second trailing read');
  assert.deepEqual(plan({ cached, key, now: 25_000, signal: true }), { read: true, delayMs: null }, 'after the window a signal reads at once');
  assert.deepEqual(plan({ cached, key, now: 25_000 }), { read: true, delayMs: null });
  assert.deepEqual(plan({ cached: { ...cached, loading: true }, key, now: 40_000 }), { read: false, delayMs: null }, 'one read in flight at a time');
  assert.deepEqual(plan({ cached: { ...cached, loading: true }, key, now: 12_000, signal: true }), { read: false, delayMs: 13_000 },
    'a signal during a read can postdate it: read again when the window ends');
  for (const name of ['activity.completed', 'context.read.completed', 'context.sources.changed', 'run.completed']) {
    assert.equal(InputContext.contextSourceRefreshSignal(name), true, name);
  }
  for (const name of ['message.delta', 'message.completed', 'run.started', 'plan.updated', undefined]) {
    assert.equal(InputContext.contextSourceRefreshSignal(name), false, String(name));
  }
});

test('CTX-04 refresh wiring: the bridge cache uses the plan, keeps one trailing timer per room, and run tool results signal it', () => {
  const source = readSurfaceSource();
  const fn = source.match(/    function refreshContextSources\(threadId, \{ signal = false \} = \{\}\) \{\n([\s\S]*?)\n    \}\n/)?.[1] || '';
  assert.match(fn, /InputContext\.contextSourceRefreshPlan\(\{ cached, key, now: Date\.now\(\), signal, trailing: contextSourceTrailing\.has\(threadId\) \}\)/);
  assert.match(fn, /contextSourceTrailing\.set\(threadId, window\.setTimeout\(\(\) => \{\n            contextSourceTrailing\.delete\(threadId\);\n            refreshContextSources\(threadId, \{ signal: true \}\);/);
  assert.ok(fn.indexOf('window.clearTimeout(contextSourceTrailing.get(threadId));') < fn.indexOf('fetchJson(`/context/sources?'),
    'a read now replaces a pending trailing read');
  assert.doesNotMatch(fn, /Date\.now\(\) - cached\.at < 15000/, 'one rule: the plan');
  assert.match(source, /if \(run\?\.localThreadId && InputContext\.contextSourceRefreshSignal\(event\.event\)\) refreshContextSources\(run\.localThreadId, \{ signal: true \}\);/);
  const forget = source.match(/    function forgetContextSuggestions\(\) \{\n([\s\S]*?)\n    \}\n/)?.[1] || '';
  assert.match(forget, /for \(const timer of contextSourceTrailing\.values\(\)\) window\.clearTimeout\(timer\);\n      contextSourceTrailing\.clear\(\);/,
    'an account or bridge change drops pending reads');
});
