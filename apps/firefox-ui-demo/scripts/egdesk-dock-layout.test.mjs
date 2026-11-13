import test from 'node:test';
import assert from 'node:assert/strict';
import * as Dock from '../overlay/resources/EGDeskDockLayout.sys.mjs';
import * as Surface from '../overlay/resources/EGDeskSurfaceState.sys.mjs';

// The approved Dock is eight buttons. Everything else the old nineteen-button
// Dock offered is reached from the [새 카드] menu; nothing is removed.

test('the Dock shows the approved eight buttons in the approved order', () => {
  assert.deepEqual(Dock.dockButtonIds(), ['chat', 'memo', 'browser', 'terminal', 'select', 'hand', 'create', 'trash']);
  assert.equal(Dock.dockButtonIds().length, Dock.DOCK_BUTTON_LIMIT);
  assert.deepEqual(Dock.DOCK_OPEN_ITEMS.map(item => item.label), ['대화', '메모', 'Browser', '터미널']);
  assert.deepEqual(Dock.DOCK_TOOL_ITEMS.map(item => item.label), ['선택', '이동']);
  assert.equal(Dock.DOCK_NEW_CARD.label, '새 카드');
  assert.deepEqual(Dock.DOCK_CLOSE_ITEMS.map(item => [item.id, item.label, item.icon]), [['trash', '선택한 창 닫기', 'close']]);
  for (const group of [Dock.DOCK_OPEN_ITEMS, Dock.DOCK_TOOL_ITEMS, Dock.DOCK_CLOSE_ITEMS]) {
    assert.ok(group.length <= 5, 'no Dock group grows past five buttons');
  }
});

test('every tool the old Dock had is still reachable, with its old id', () => {
  const previous = ['chat', 'shelf', 'ontology', 'browser', 'ide', 'terminal', 'settings', 'memo', 'create',
    'pencil', 'hand', 'square', 'ellipse', 'line', 'arrow', 'label', 'highlight', 'select', 'trash'];
  const reachable = [...Dock.dockButtonIds(), ...Dock.DOCK_NEW_CARD_ITEMS.map(item => item.id), ...Dock.DOCK_DRAW_TOOLS.map(item => item.id)];
  assert.deepEqual([...reachable].sort(), [...previous].sort());
  assert.equal(new Set(reachable).size, reachable.length, 'no tool is offered twice');
  assert.deepEqual(Dock.DOCK_NEW_CARD_ITEMS.map(item => [item.id, item.label]),
    [['shelf', '파일'], ['ide', '개발 (IDE)'], ['ontology', '온톨로지'], ['settings', '설정']]);
  assert.deepEqual(Dock.DOCK_DRAW_TOOLS.map(item => [item.id, item.label]),
    [['pencil', '펜'], ['square', '사각형'], ['ellipse', '원'], ['line', '선'], ['arrow', '화살표'], ['label', '글자'], ['highlight', '강조']]);
});

test('Dock tools are known Canvas tools and the Desk opens on the selection pointer', () => {
  const tools = [...Dock.DOCK_TOOL_ITEMS, ...Dock.DOCK_DRAW_TOOLS];
  for (const tool of tools) assert.ok(Surface.CANVAS_TOOL_IDS.includes(tool.id), `${tool.id} is a known Canvas tool`);
  assert.deepEqual(tools.filter(tool => tool.active).map(tool => tool.id), ['select']);
  assert.notEqual(tools.find(tool => tool.id === 'select').icon, tools.find(tool => tool.id === 'arrow').icon,
    'the selection pointer and the arrow mark never share an icon');
});

test('the current drawing tool appears on the Dock and leaves with the selection pointer', () => {
  assert.equal(Dock.dockCurrentDrawTool('select'), null);
  assert.equal(Dock.dockCurrentDrawTool('hand'), null, 'the two tools already on the Dock need no second button');
  assert.equal(Dock.dockCurrentDrawTool('nonsense'), null);
  assert.equal(Dock.dockCurrentDrawTool(undefined), null);
  const pencil = Dock.dockCurrentDrawTool('pencil');
  assert.deepEqual([pencil.id, pencil.icon], ['pencil', 'pencil']);
  assert.equal(pencil.title, '지금 도구: 펜 · 눌러서 다른 도구 고르기');
  for (const tool of Dock.DOCK_DRAW_TOOLS) assert.equal(Dock.dockCurrentDrawTool(tool.id).id, tool.id);
});

test('the close button is inactive with nothing selected and says what it will close', () => {
  assert.deepEqual(Dock.dockCloseState(), { disabled: true, title: '선택한 창 닫기 · 선택한 창이 없습니다' });
  assert.deepEqual(Dock.dockCloseState({ windows: 0, marks: 0 }), { disabled: true, title: '선택한 창 닫기 · 선택한 창이 없습니다' });
  assert.deepEqual(Dock.dockCloseState({ windows: 1 }), { disabled: false, title: '선택한 창 닫기' });
  assert.deepEqual(Dock.dockCloseState({ windows: 3 }), { disabled: false, title: '선택한 창 3개 닫기' });
  assert.deepEqual(Dock.dockCloseState({ marks: 2 }), { disabled: false, title: '선택한 표식 2개 지우기' });
  assert.deepEqual(Dock.dockCloseState({ windows: 1, marks: 2 }), { disabled: false, title: '선택한 창 1개 닫기 · 표식 2개 지우기' });
  assert.deepEqual(Dock.dockCloseState({ windows: -4, marks: Number.NaN }), { disabled: true, title: '선택한 창 닫기 · 선택한 창이 없습니다' });
});

test('the marks toggle names the next action and how many are hidden', () => {
  assert.deepEqual(Dock.dockAnnotationToggle({ hidden: false, count: 4 }),
    { label: '표식·메모 숨기기', detail: '', pressed: false, newCardTitle: '새 카드' });
  assert.deepEqual(Dock.dockAnnotationToggle({ hidden: true, count: 4 }),
    { label: '표식·메모 보이기', detail: '숨김 4개', pressed: true, newCardTitle: '새 카드 · 표식·메모 숨김 4개' });
  assert.deepEqual(Dock.dockAnnotationToggle({ hidden: true, count: 0 }),
    { label: '표식·메모 보이기', detail: '숨김', pressed: true, newCardTitle: '새 카드 · 표식·메모 숨김' });
  assert.deepEqual(Dock.dockAnnotationToggle(), { label: '표식·메모 숨기기', detail: '', pressed: false, newCardTitle: '새 카드' });
});

test('arrow keys walk the menu: cards down, the tool row sideways, then the toggle', () => {
  // 4 card rows (0-3), 7 tools (4-10), the toggle (11).
  const move = (index, key, extra = {}) => Dock.dockMenuMove({ index, key, cards: 4, tools: 7, ...extra });
  assert.equal(move(0, 'ArrowDown'), 1);
  assert.equal(move(3, 'ArrowDown'), 4, 'below the last card is the tool row');
  assert.equal(move(3, 'ArrowDown', { activeTool: 2 }), 6, 'the tool row is entered on the tool in use');
  assert.equal(move(6, 'ArrowDown'), 11, 'one press leaves the tool row');
  assert.equal(move(11, 'ArrowDown'), 0, 'the menu wraps');
  assert.equal(move(0, 'ArrowUp'), 11);
  assert.equal(move(11, 'ArrowUp'), 4);
  assert.equal(move(11, 'ArrowUp', { activeTool: 6 }), 10);
  assert.equal(move(7, 'ArrowUp'), 3);
  assert.equal(move(4, 'ArrowRight'), 5);
  assert.equal(move(10, 'ArrowRight'), 4, 'the tool row wraps on its own');
  assert.equal(move(4, 'ArrowLeft'), 10);
  assert.equal(move(1, 'ArrowRight'), -1, 'sideways keys do nothing on a card row');
  assert.equal(move(11, 'ArrowLeft'), -1);
  assert.equal(move(5, 'Home'), 0);
  assert.equal(move(5, 'End'), 11);
  assert.equal(move(-1, 'ArrowDown'), 0, 'focus outside the items starts at the top');
  assert.equal(move(-1, 'ArrowUp'), 11);
  assert.equal(move(2, 'a'), -1);
  assert.equal(move(2, 'Tab'), -1, 'Tab is left to the browser');
  assert.equal(Dock.dockMenuMove({ index: 0, key: 'ArrowDown', cards: 0, tools: 0 }), 0, 'a menu with only the toggle stays on it');
});
