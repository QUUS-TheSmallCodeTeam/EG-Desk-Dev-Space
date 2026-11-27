import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import * as DockLayout from '../overlay/resources/EGDeskDockLayout.sys.mjs';
import { readSurfaceSource } from './egdesk-surface-source.mjs';

// The production Dock code is cut out of the surface script and run against a
// small stand-in document. No Firefox is started.

const source = readSurfaceSource();
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const topLevel = name => {
  const found = source.match(new RegExp(`  function ${name}\\([^]*?\\n  }\\n`))?.[0];
  assert.ok(found, `${name} is a top-level surface function`);
  return found;
};

function fakeButton(id, kind) {
  const attrs = new Map(), classes = new Set(['egd-dock-btn']);
  return {
    dataset: { id, kind }, title: '', attrs, classes,
    setAttribute: (name, value) => attrs.set(name, String(value)),
    getAttribute: name => attrs.get(name) ?? null,
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) },
  };
}

function dockHarness({ activeTool = 'select', hidden = false, selected = [], annotations = 0 } = {}) {
  const state = { activeTool };
  const calls = [];
  const select = fakeButton('select', 'center'), hand = fakeButton('hand', 'center');
  const create = fakeButton('create', 'menu'), close = fakeButton('trash', 'right');
  let chip = null;
  create.before = node => { chip = node; calls.push(['chip-before-create', node.dataset.id]); };
  const dock = {
    querySelector: selector => {
      if (selector === '.egd-dock-current-tool') return chip;
      if (selector === '.egd-dock-btn[data-id="create"]') return create;
      if (selector === '.egd-dock-btn[data-id="trash"]') return close;
      throw new Error(`unexpected Dock selector ${selector}`);
    },
    querySelectorAll: selector => {
      assert.equal(selector, '.egd-dock-btn[data-kind="center"]');
      return [select, hand, ...(chip ? [chip] : [])];
    },
  };
  const root = { dataset: hidden ? { egdAnnotationsHidden: 'true' } : {} };
  let selection = selected;
  const document = {
    documentElement: root,
    getElementById: id => (id === 'egd-dock' ? dock : id === state.activeEntityId ? { activeMarker: true } : null),
    querySelectorAll: selector => {
      if (selector === '.egd-entity-selected') {
        return selection.map(node => ({
          source: node,
          // A memo is a window and a mark at once; a shape is only a mark.
          classList: { contains: name => name === 'egd-canvas-card' && !!node.window },
          matches: query => { assert.equal(query, '.egd-canvas-shape, .egd-memo-card'); return !node.window || !!node.memo; },
        }));
      }
      if (selector === '.egd-canvas-shape, .egd-memo-card') return { length: annotations };
      throw new Error(`unexpected document selector ${selector}`);
    },
  };
  const el = (tag, props = {}) => {
    const node = fakeButton(props.data?.id, props.data?.kind);
    node.title = props.title;
    for (const name of String(props.class || '').split(' ')) node.classes.add(name);
    for (const [name, value] of Object.entries(props)) if (name.startsWith('aria-')) node.attrs.set(name, value);
    node.remove = () => { chip = null; calls.push(['chip-removed']); };
    node.replaceWith = next => { chip = next; calls.push(['chip-replaced', next.dataset.id]); };
    return node;
  };
  const api = compileFunction(`${['dockAnnotationsHidden', 'dropHiddenDockSelection', 'setDockAnnotationsHidden', 'setDockTool', 'syncDockState'].map(topLevel).join('\n')}
    return { dockAnnotationsHidden, dropHiddenDockSelection, setDockAnnotationsHidden, setDockTool, syncDockState };`,
  ['state', 'document', 'DockLayout', 'DOCK_ANNOTATION_SELECTOR', 'el', 'deskIcon', 'dockEyeIcon', 'syncActiveToolMode', 'setActiveEntity', 'setSelectedEntities'])(
    state, document, DockLayout, '.egd-canvas-shape, .egd-memo-card', el, icon => ({ icon }), () => ({}),
    () => calls.push(['tool-mode', state.activeTool]), entity => { calls.push(['active-entity', entity]); selection = []; },
    (kept, active) => { calls.push(['keep-selected', kept.length, active]); selection = kept.map(node => node.source); });
  return { ...api, state, root, calls, select, hand, create, close, chip: () => chip, setSelection: next => { selection = next; } };
}

test('with nothing selected the close button reads inactive, and says what it will close once something is', () => {
  const dock = dockHarness();
  dock.syncDockState();
  assert.equal(dock.close.getAttribute('aria-disabled'), 'true');
  assert.equal(dock.close.title, '선택한 창 닫기 · 선택한 창이 없습니다');
  dock.setSelection([{ window: true }, { window: true }, { window: false }]);
  dock.syncDockState();
  assert.equal(dock.close.getAttribute('aria-disabled'), 'false');
  assert.equal(dock.close.title, '선택한 창 2개 닫기 · 표식 1개 지우기');
  assert.equal(dock.close.getAttribute('aria-label'), dock.close.title);
});

test('choosing a drawing tool shows it beside 선택 and returning to 선택 removes it', () => {
  const dock = dockHarness();
  dock.syncDockState();
  assert.equal(dock.chip(), null, 'the selection pointer needs no extra button');
  assert.equal(dock.select.getAttribute('aria-pressed'), 'true');

  dock.setDockTool('pencil');
  assert.deepEqual(dock.calls, [['tool-mode', 'pencil'], ['chip-before-create', 'pencil']]);
  const chip = dock.chip();
  assert.equal(chip.title, '지금 도구: 펜 · 눌러서 다른 도구 고르기');
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  assert.ok(chip.classes.has('egd-dock-btn-active'));
  assert.equal(dock.select.getAttribute('aria-pressed'), 'false');
  assert.ok(!dock.select.classes.has('egd-dock-btn-active'));

  dock.setDockTool('arrow');
  assert.deepEqual(dock.calls.at(-1), ['chip-replaced', 'arrow']);
  assert.equal(dock.chip().dataset.id, 'arrow');

  dock.setDockTool('select');
  assert.deepEqual(dock.calls.at(-1), ['chip-removed']);
  assert.equal(dock.chip(), null);
  assert.equal(dock.select.getAttribute('aria-pressed'), 'true');

  dock.setDockTool('hand');
  assert.equal(dock.chip(), null, '이동 is already a Dock button');
  assert.equal(dock.hand.getAttribute('aria-pressed'), 'true');
});

test('hiding marks sets one root attribute, drops a hidden selection, and marks the 새 카드 button', () => {
  const dock = dockHarness({ selected: [{ window: false }], annotations: 3 });
  dock.setDockAnnotationsHidden(true);
  assert.equal(dock.root.dataset.egdAnnotationsHidden, 'true');
  assert.deepEqual(dock.calls, [['active-entity', null]], 'a hidden mark is no longer the selection');
  assert.equal(dock.dockAnnotationsHidden(), true);
  assert.equal(dock.create.title, '새 카드 · 표식·메모 숨김 3개');
  assert.ok(dock.create.classes.has('egd-dock-btn-marks-hidden'));
  assert.equal(dock.close.getAttribute('aria-disabled'), 'true');

  dock.setDockAnnotationsHidden(false);
  assert.equal('egdAnnotationsHidden' in dock.root.dataset, false);
  assert.equal(dock.create.title, '새 카드');
  assert.ok(!dock.create.classes.has('egd-dock-btn-marks-hidden'));
});

test('a hidden mark never stays selected, while selected windows do', () => {
  const dock = dockHarness({ selected: [{ window: true }, { window: false }, { window: true, memo: true }] });
  dock.dropHiddenDockSelection();
  assert.deepEqual(dock.calls, [], 'nothing is hidden, so the selection is left alone');
  dock.setDockAnnotationsHidden(true);
  assert.deepEqual(dock.calls, [['keep-selected', 1, null]], 'the shape and the memo leave the selection, the window stays');
  assert.equal(dock.close.title, '선택한 창 닫기');
  // A later drag selection sweeps over the place where a hidden shape sits.
  dock.setSelection([{ window: false }]);
  dock.dropHiddenDockSelection();
  assert.deepEqual(dock.calls.at(-1), ['active-entity', null]);
  assert.match(source, /requestAnimationFrame\(\(\) => \{ syncFrame = 0; dropHiddenDockSelection\(\); syncDockState\(\); \}\);/, 'checked after each pointer or key release');
});

test('hiding marks leaves a selected window alone, and drawing brings the marks back', () => {
  const dock = dockHarness({ selected: [{ window: true }] });
  dock.setDockAnnotationsHidden(true);
  assert.deepEqual(dock.calls, [], 'only a hidden item loses the selection');
  dock.setDockTool('hand');
  assert.equal(dock.dockAnnotationsHidden(), true, 'moving the Canvas does not un-hide anything');
  dock.setDockTool('square');
  assert.equal(dock.dockAnnotationsHidden(), false, 'a shape drawn while hidden would be invisible');
});

test('Dock buttons route by kind: tools, the 새 카드 menu, windows, close', () => {
  const start = source.indexOf('  function buildDock() {');
  const dockSource = source.slice(start, source.indexOf('    const divider =', start));
  const body = dockSource.match(/onclick: \(\) => \{([\s\S]*?)\n\s*\},\n\s*\}, el\('span', \{ class: 'egd-dock-icon' \}/)?.[1];
  assert.ok(body, 'one click body serves the Dock and its menu');
  const run = (kind, id, { menuOpen = false } = {}) => {
    const calls = [];
    const log = name => (...args) => { calls.push([name, ...args]); };
    compileFunction(`return () => {${body}};`, ['kind', 'item', 'document', 'setDockTool', 'openDockMenu', 'closeDockMenu',
      'spawnBrowserCard', 'spawnTerminalCard', 'spawnSettingsCard', 'openFileFromUserAction', 'openIdeFromUserAction',
      'spawnMemoFromDock', 'spawnOntologyMapCard', 'deleteSelectedEntities', 'toggleHUD'])(
      kind, { id, label: id }, { getElementById: () => (menuOpen ? {} : null) }, log('tool'), log('open-menu'), log('close-menu'),
      log('browser'), log('terminal'), log('settings'), log('file'), log('ide'), log('memo'), log('ontology'), log('close'), log('hud'))();
    return calls;
  };
  assert.deepEqual(run('center', 'pencil'), [['tool', 'pencil']]);
  assert.deepEqual(run('menu', 'create'), [['open-menu']]);
  assert.deepEqual(run('menu', 'create', { menuOpen: true }), [['close-menu']], 'the same button closes its menu');
  assert.deepEqual(run('left', 'memo'), [['memo']]);
  assert.deepEqual(run('left', 'browser'), [['browser']]);
  assert.deepEqual(run('left', 'terminal'), [['terminal', { idle: true }]], 'the Dock opens a Terminal window without starting a session');
  for (const [id, name] of [['shelf', 'file'], ['ide', 'ide'], ['ontology', 'ontology'], ['settings', 'settings']]) {
    assert.deepEqual(run('left', id), [[name]], `${id} keeps its action inside the 새 카드 menu`);
  }
  assert.deepEqual(run('right', 'trash'), [['close']]);
  assert.deepEqual(run('left', 'create'), [], 'no button falls back to an empty side panel');
});

test('the 새 카드 menu holds the moved windows, the drawing tools and the marks toggle', () => {
  const start = source.indexOf('    function openDockMenu(');
  const menuSource = source.slice(start, source.indexOf('    dock._openDockMenu = openDockMenu;', start));
  assert.ok(start > 0 && menuSource.length > 0);
  assert.match(menuSource, /for \(const item of DockLayout\.DOCK_NEW_CARD_ITEMS\) \{\n\s*const row = makeButton\(item, 'left', \{ className: 'egd-dock-menu-item', role: 'menuitem' \}\);/);
  assert.match(menuSource, /for \(const item of DockLayout\.DOCK_DRAW_TOOLS\) \{\n\s*const tool = makeButton\(item, 'center', \{ className: 'egd-dock-menu-tool', role: 'menuitemradio' \}\);/);
  assert.match(menuSource, /role: 'menuitemcheckbox',[\s\S]*?onclick: \(\) => setDockAnnotationsHidden\(!dockAnnotationsHidden\(\)\),/);
  assert.match(menuSource, /if \(event\.key === 'Escape'\) \{\n\s*event\.preventDefault\(\);\n\s*event\.stopPropagation\(\);\n\s*closeDockMenu\(\{ restoreFocus: true \}\);/, 'Esc closes the menu and returns to its button');
  assert.match(menuSource, /DockLayout\.dockMenuMove\(\{/, 'arrow keys follow the layout view model');
  assert.match(menuSource, /document\.addEventListener\('pointerdown', onPointerDown, true\);/, 'a click outside closes the menu');
  assert.match(menuSource, /document\.removeEventListener\('pointerdown', onPointerDown, true\);/, 'closing lets go of the outside-click watch');
  const buildSource = source.slice(source.indexOf('  function buildDock() {'), source.indexOf('  // ============ Left: Desk rail'));
  assert.match(buildSource, /dock\.appendChild\(makeGroup\(DOCK_LEFT, 'left'\)\);\n\s*dock\.appendChild\(divider\(\)\);\n\s*const toolGroup = makeGroup\(DOCK_CENTER, 'center'\);\n\s*const createButton = makeButton\(DockLayout\.DOCK_NEW_CARD, 'menu'\);/);
});

test('no developer note is left on the Dock or its side panel', () => {
  for (const note of ['2단계에서 연결', '전용 패널이 여기 렌더', '도크 왼쪽 앱 클릭', '컨텍스트 패널']) {
    assert.ok(!source.includes(note), `"${note}" is not shown to the user`);
  }
  assert.doesNotMatch(source, /toggleHUD\(item\.id, item\.label\)/);
});

test('Dock styles: inactive close, hidden marks, and a menu drawn only from tokens', () => {
  const rule = selector => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`))?.[1] || '';
  assert.match(css, /\.egd-dock-btn\[aria-disabled="true"\]:active \{[^}]*opacity: var\(--egd-opacity-disabled\);/);
  assert.match(css, /:root\[data-egd-annotations-hidden="true"\] \.egd-canvas-shape,\n:root\[data-egd-annotations-hidden="true"\] \.egd-memo-card \{\n  visibility: hidden !important;\n  pointer-events: none !important;\n\}/);
  const tokens = rule('#egd-dock, .egd-dock-menu');
  for (const [name, value] of [['gap', '6px'], ['pad', '9px'], ['button', '32px'], ['icon', '17px'], ['sep-height', '23px'], ['sep-gap', '3px'], ['radius', '10px']]) {
    assert.match(tokens, new RegExp(`--egd-dock-${name}: ${value};`), `approved Dock ${name}`);
  }
  assert.match(rule('#egd-dock'), /gap: var\(--egd-dock-gap\);\n  padding: 0 var\(--egd-dock-pad\);/);
  const menuStart = css.indexOf('/* [새 카드] menu');
  const menuCss = css.slice(menuStart, css.indexOf('/* ============ Left: Preset Bag', menuStart));
  assert.ok(menuStart > 0 && menuCss.includes('.egd-dock-menu-tool'));
  assert.doesNotMatch(menuCss, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'menu colours come from --egd-* tokens');
  assert.match(menuCss, /\.egd-dock-menu-item:focus-visible,\n\.egd-dock-menu-tool:focus-visible \{[^}]*outline: var\(--egd-focus-outline\);/);
});
