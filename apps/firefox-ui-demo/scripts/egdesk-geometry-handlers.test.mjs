import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as CanvasLayout from '../overlay/resources/EGDeskCanvasLayout.sys.mjs';
import * as RecoveryState from '../overlay/resources/EGDeskRecoveryState.sys.mjs';

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const decl = name => {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
const compile = (names, result, deps) => new Function(...Object.keys(deps), `${names.map(decl).join('\n')}\nreturn ${result};`)(...Object.values(deps));
function fixture() {
  let document;
  class Node {
    constructor(tag, props = {}, ...children) {
      this.tag = tag; this.children = children.filter(Boolean); this.props = props; this.listeners = {};
      this.dataset = props.data || {}; this.id = props.id; this.isConnected = true; this.style = {};
      this.value = props.value || ''; this.checked = false;
      const classes = new Set((props.class || '').split(' '));
      this.classList = { contains: id => classes.has(id), add: id => classes.add(id) };
    }
    appendChild(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; if (this.tag === 'select') this.value = nodes[0]?.value || ''; }
    focus() { document.activeElement = this; }
    remove() { this.isConnected = false; }
    setAttribute(k, v) { this.props[k] = v; }
    removeAttribute(k) { delete this.props[k]; }
    insertBefore(node) { this.children.unshift(node); }
    addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }
    removeEventListener() {}
    matches(s) { return s.replace(':scope > ', '').split('.').slice(1).every(c => this.classList.contains(c)); }
    querySelectorAll(s) { return this.children.filter(n => n instanceof Node && n.isConnected && n.matches(s)); }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    all(f) { return this.children.flatMap(n => n instanceof Node ? [...(n.isConnected && f(n) ? [n] : []), ...n.all(f)] : []); }
    fire(type, fields = {}) { const e = { target: this, preventDefault() {}, stopPropagation() {}, ...fields }; this.props[`on${type}`]?.(e); for (const f of this.listeners[type] || []) f(e); }
    closest(s) { return s.split(', ').some(p => this.matches(p)) ? this : null; }
  }
  const el = (...args) => new Node(...args);
  const root = el('root'), layer = el('layer'), viewport = el('viewport');
  root.appendChild(layer);
  document = { documentElement: root, getElementById: id => root.all(n => n.id === id)[0], querySelectorAll: s => layer.querySelectorAll(s) };
  const card = (id, kind = 'memo', selected = false, data = {}) => {
    const node = el('div', { id, class: `egd-canvas-card egd-${kind}-card${selected ? ' egd-entity-selected' : ''}`, data });
    layer.appendChild(node); return node;
  };
  const by = id => root.all(n => n.dataset.testid === id).at(-1);
  return { document, el, root, layer, viewport, card, by, Node };
}

test('new Board submit checks chosen local members, rejects empty name, and writes the scrubbed subset', () => {
  const f = fixture();
  f.card('suggested', 'memo', true); f.card('kept-chat', 'chat', true); f.card('added', 'browser');
  f.card('restricted', 'memo', true, { jointManaged: 'card' });
  const privateBrowser = f.card('private-browser', 'browser', true);
  privateBrowser._xulBrowser = { browsingContext: { originAttributes: { privateBrowsingId: 1 } } };
  const store = { agendas: {}, meta: {} }, state = { boards: { projections: {} }, agenda: {} };
  const writes = [], versions = [];
  const open = compile(['canSaveLocalBoardView', 'cardKindForPersistence', 'showBoardScopeChooser', 'createNewAgenda',
    'saveCurrentAgendaState', 'serializeAgendaSnapshot', 'safeLocalBoardSnapshot', 'boardGroupsForMembers'], 'createNewAgenda', {
    ...f, state, CanvasLayout, RecoveryState, cardLabelForViewportRail: node => node.id, newAgendaId: () => 'test-board',
    serializeCardState: node => ({ id: node.id, type: node.id === 'kept-chat' ? 'chat' : node.id === 'added' ? 'browser' : 'memo',
      runtimeState: node.id === 'kept-chat' ? { activeThreadId: 'fake-room', threadBinding: { clientThreadId: 'fake-room' } } : { uri: 'https://example.invalid/page?fixture=private#session', credentials: { value: 'fake' } } }),
    coerceAgendaStore: () => structuredClone(store), writeAgendaStoreAndSync: next => (writes.push(next), true),
    syncBoardToStore: (...args) => versions.push(args), syncViewportAgendaRail() {}, scheduleDeskSessionSave() {},
    bindSavedBoardInPlace() {}, boardNotice() {}, boardDoneNotice() {},
  });
  const dialog = open();
  const inputs = dialog.all(n => n.tag === 'input'), name = inputs[0];
  assert.equal(f.document.activeElement, name);
  assert.deepEqual(inputs.slice(1).map(n => [n.dataset.viewId, n.checked]), [['suggested', true], ['kept-chat', true], ['added', false]]);
  const form = dialog.all(n => n.tag === 'form')[0];
  form.fire('submit'); assert.equal(name.props['aria-invalid'], 'true'); assert.equal(writes.length, 0);
  inputs[1].checked = false; inputs[1].fire('change'); inputs[3].checked = true; inputs[3].fire('change');
  name.value = ' Chosen '; form.fire('submit'); assert.equal(writes.length, 1);
  const saved = writes[0].agendas['test-board'];
  assert.deepEqual(saved.agenda.memberCardIds, ['kept-chat', 'added']); assert.equal(saved.agenda.title, 'Chosen');
  assert.deepEqual(saved.cards[0].runtimeState, {}); assert.equal(saved.cards[1].runtimeState.uri, 'https://example.invalid/page');
  assert.doesNotMatch(JSON.stringify(saved), /fake|private|restricted/);
  assert.deepEqual(versions[0][1], saved); assert.equal(dialog.isConnected, false);
});

test('placement menu and group controls attach and detach existing groups, reject cycles and undo without moving Views', () => {
  const f = fixture(), state = { boards: { projections: {} }, canvasGroups: [] };
  for (const id of ['a','b','c','d']) f.card(id, 'memo', true);
  f.card('fixed', 'memo', true, { layoutFixed: 'true' });
  const poses = new Map([...f.layer.children].map((node, i) => [node.id, { x: i * 100, y: 0, width: 80, height: 60 }]));
  const before = structuredClone(poses);
  const install = compile(['installCanvasPlacementOps'], 'installCanvasPlacementOps', { ...f, state, CanvasLayout,
    Element: f.Node, MutationObserver: class {observe() {} disconnect() {}}, window: { innerWidth: 900, innerHeight: 700,
      addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1 },
    registerEscapeLayer() {}, isCardFullscreen: () => false, cardLabelForViewportRail: n => n.id,
    markAgendaDirty() {}, scheduleDeskSessionSave() {}, boardNotice() {}, persistentEntityGeometry: n => poses.get(n.id),
    applyPersistentEntityGeometry: (n, p) => poses.set(n.id, p),
    ViewportExtras: { snapToggleView: () => ({}) },
  });
  install(f.viewport, f.layer);
  state.restoreCanvasGroups([{ id: 'inner', viewIds: ['a','b','fixed'] }, { id: 'outer', viewIds: ['c','d'] }], new Map());
  assert.deepEqual(state.canvasGroups[0].viewIds, ['a','b']);
  f.viewport.fire('contextmenu', { target: f.layer, clientX: 20, clientY: 20 });
  f.by('placement-parent-group').fire('click');
  const child = f.by('canvas-group-child'), parent = f.by('canvas-group-parent');
  child.value = 'inner'; parent.value = 'outer'; f.by('canvas-group-attach').fire('click');
  assert.deepEqual(state.canvasGroups[1].groupIds, ['inner']);
  child.value = 'outer'; parent.value = 'inner'; f.by('canvas-group-attach').fire('click');
  assert.deepEqual(state.canvasGroups[1].groupIds, ['inner']);
  child.value = 'inner'; parent.value = 'outer'; f.by('canvas-group-detach').fire('click');
  assert.equal(state.canvasGroups[1].groupIds, undefined);
  assert.equal(state.undoCanvasLayout(), true); assert.deepEqual(state.canvasGroups[1].groupIds, ['inner']);
  assert.deepEqual(poses, before);
});

test('group depth is capped; valid deep graph round-trips with separate group and View identities', () => {
  const groups = [{ id: 'g1', viewIds: ['g1', 'b'] }];
  for (let i = 2; i <= CanvasLayout.CANVAS_GROUP_MAX_DEPTH; i++) groups.push({ id: `g${i}`, viewIds: [`v${i}`], groupIds: [`g${i - 1}`] });
  const depth = CanvasLayout.CANVAS_GROUP_MAX_DEPTH;
  const root = `g${depth}`;
  const over = CanvasLayout.createCanvasGroup(groups, ['outside'], { id: 'too-deep', groupIds: [root] });
  assert.equal(over.changed, false);
  assert.equal(CanvasLayout.changeCanvasGroupParent(groups, root, 'g1').changed, false);
  assert.equal(CanvasLayout.changeCanvasGroupParent(groups, 'g1', 'g2').changed, false);
  const restored = CanvasLayout.remapCanvasGroups(JSON.parse(JSON.stringify(groups)), new Map([['g1', 'live-member']]), id => `restored-${id}`);
  assert.deepEqual(restored[1].groupIds, ['restored-g1']);
  assert.deepEqual(restored[0].viewIds, ['live-member', 'b']);
  const move = CanvasLayout.expandCanvasGroupSelection(restored, ['live-member', 'b', `v${depth}`]);
  assert.equal(move.length, depth + 1);
  assert.equal(move.length, new Set(move).size);
});
