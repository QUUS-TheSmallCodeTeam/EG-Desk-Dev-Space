import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHAT_FRAME_HOME_TITLE, CHAT_FRAME_MIN_WIDTH, CHAT_FRAME_MIN_HEIGHT, chatFrameTitle, resizeFrameRect,
} from '../overlay/resources/EGDeskChatFrame.sys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const spawnStart = surfaceSource.indexOf('  function spawnCodexChatCard(');
const spawnBody = surfaceSource.slice(spawnStart, surfaceSource.indexOf('  // ============ Canvas Entity: Browser Card', spawnStart));

// ------------------------------------------------------------------ the name

test('the bar names the open conversation, and the window itself on the room list', () => {
  assert.deepEqual(chatFrameTitle({ thread: { title: '  Codex ' }, view: 'conversation' }),
    { text: 'Codex', conversation: true });
  assert.deepEqual(chatFrameTitle({ thread: { title: '주간 보고 Board' }, view: 'list' }),
    { text: CHAT_FRAME_HOME_TITLE, conversation: false }, 'the room list is not a conversation');
  for (const input of [undefined, {}, { view: 'conversation' }, { thread: { title: '   ' }, view: 'conversation' },
    { thread: { title: 42 }, view: 'conversation' }]) {
    assert.equal(chatFrameTitle(input).text, '대화', 'no name is never guessed (2026-11-17: window title follows the Dock button 대화)');
    assert.equal(chatFrameTitle(input).conversation, false);
  }
});

// ---------------------------------------------------------------- the resize

test('a dragged edge moves and the opposite edge stays, in all eight directions', () => {
  const start = { left: 100, top: 200, width: 500, height: 600 };
  const limits = { minWidth: 320, minHeight: 420 };
  const cases = [
    [{ right: true }, 40, 99, { left: 100, top: 200, width: 540, height: 600 }],
    [{ bottom: true }, 99, -30, { left: 100, top: 200, width: 500, height: 570 }],
    [{ left: true }, 40, 99, { left: 140, top: 200, width: 460, height: 600 }],
    [{ top: true }, 99, -30, { left: 100, top: 170, width: 500, height: 630 }],
    [{ top: true, left: true }, -20, 10, { left: 80, top: 210, width: 520, height: 590 }],
    [{ top: true, right: true }, 20, 10, { left: 100, top: 210, width: 520, height: 590 }],
    [{ bottom: true, right: true }, 20, 10, { left: 100, top: 200, width: 520, height: 610 }],
    [{ bottom: true, left: true }, 20, 10, { left: 120, top: 200, width: 480, height: 610 }],
  ];
  for (const [edges, dx, dy, expected] of cases) {
    assert.deepEqual(resizeFrameRect(start, edges, dx, dy, limits), expected, JSON.stringify(edges));
  }
});

test('the minimum size stops the drag without moving the far edge', () => {
  const start = { left: 100, top: 200, width: 500, height: 600 };
  const limits = { minWidth: 320, minHeight: 420 };
  assert.deepEqual(resizeFrameRect(start, { left: true, top: true }, 900, 900, limits),
    { left: 280, top: 380, width: 320, height: 420 }, 'right and bottom edges stay at 600 / 800');
  assert.deepEqual(resizeFrameRect(start, { right: true, bottom: true }, -900, -900, limits),
    { left: 100, top: 200, width: 320, height: 420 });
  assert.deepEqual(resizeFrameRect(start, { right: true }, -900, 0),
    { left: 100, top: 200, width: CHAT_FRAME_MIN_WIDTH, height: 600 }, 'the Chat floor is the default');
  assert.equal(resizeFrameRect(start, { bottom: true }, 0, -900).height, CHAT_FRAME_MIN_HEIGHT);
  assert.deepEqual(resizeFrameRect(start, { right: true }, NaN, NaN, { minWidth: NaN }), start, 'a broken step changes nothing');
  assert.deepEqual(resizeFrameRect(start, null, 50, 50, limits), start);
});

// ------------------------------------------------------ the production window

test('the Chat window carries the shared bar: three dots, name, Board, one action', () => {
  assert.ok(spawnStart > 0 && spawnBody.length > 0);
  assert.match(spawnBody, /class: 'egd-canvas-card egd-desk-window egd-chat-card'/, 'counted with the other Desk Windows');
  assert.match(spawnBody, /data: \{ deskWindowKind: 'chat' \}/);
  const header = spawnBody.match(/    const header = el\('div', \{ class: 'egd-chat-card-header' \},[\s\S]*?\n    \);/)?.[0] || '';
  const order = ['egd-card-dots-shell', 'egd-window-grip', "deskIcon('chat', 'egd-ui-icon egd-window-kind-icon')", 'titleLabel',
    'boardMetadata,', 'boardMenu,', 'egd-chat-card-actions'].map(part => header.indexOf(part));
  assert.ok(order.every(index => index >= 0), 'every part of the bar is built');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'dots · grip · icon · name · Board · actions');
  assert.match(header, /el\('div', \{ class: 'egd-card-dots' \}, closeControl, minimizeControl, maximizeControl\)/);
  for (const [name, cls, title] of [['closeControl', 'egd-card-dot egd-card-dot-close egd-desk-window-control', '창 닫기'],
    ['maximizeControl', 'egd-card-dot egd-card-dot-max egd-desk-window-control', '창 최대화']]) {
    const control = spawnBody.match(new RegExp(`    const ${name} = el\\('span', \\{[\\s\\S]*?\\n    \\}\\);`))?.[0] || '';
    assert.ok(control.includes(`class: '${cls}'`) && control.includes("role: 'button'") && control.includes("tabindex: '0'"), name);
    assert.ok(control.includes(`title: '${title}'`) && control.includes(`'aria-label': '${title}'`), `${name} is named`);
  }
  assert.match(spawnBody, /onclick: \(ev\) => \{ ev\.stopPropagation\(\); closeCanvasCard\(card, cleanup\); \}/);
  assert.match(spawnBody, /onclick: \(ev\) => \{ ev\.stopPropagation\(\); toggleCardFullscreen\(card\); \}/);
  assert.match(spawnBody, /if \(ev\.key !== 'Enter' && ev\.key !== ' '\) return;/, 'the dots answer the keyboard');
  // The yellow dot folds the Chat window like every other Desk Window, and both dots name what a press does now.
  const minimize = spawnBody.match(/    const minimizeControl = el\('span', \{[\s\S]*?\n    \}\);/)?.[0] || '';
  assert.ok(minimize.includes("class: 'egd-card-dot egd-card-dot-min egd-desk-window-control',") && minimize.includes("role: 'button'")
    && minimize.includes("tabindex: '0'") && minimize.includes("title: '창 접기'") && minimize.includes("'aria-label': '창 접기'"), 'the yellow dot is a live control');
  assert.ok(!minimize.includes('egd-desk-window-control-disabled') && !minimize.includes('aria-disabled'));
  assert.match(minimize, /onclick: \(ev\) => \{ ev\.stopPropagation\(\); setCollapsed\(!isCollapsed\(\)\); \}/);
  assert.match(spawnBody, /for \(const control of \[closeControl, minimizeControl, maximizeControl\]\) \{/);
  assert.match(spawnBody, /const maximizeLabel = maximized \? '원래 크기로' : '창 최대화';/);
  assert.match(spawnBody, /const minimizeLabel = collapsed \? '창 펼치기' : '창 접기';/);
  assert.match(spawnBody, /if \(maximized && isCollapsed\(\)\) \{ setCollapsed\(false\); return; \}/, 'a maximized Chat window is never left folded');
  assert.match(spawnBody, /if \(next && isCardFullscreen\(card\)\) toggleCardFullscreen\(card\);\n      card\.classList\.toggle\('egd-card-collapsed', next\);/);
  assert.match(spawnBody, /new MutationObserver\(syncWindowControls\)[\s\S]*?controlObserver\?\.observe\(card, \{ attributes: true, attributeFilter: \['class'\] \}\);/);
  assert.match(spawnBody, /requestClose: \(\) => closeCanvasCard\(card, cleanup\),\n      isCollapsed,\n      setCollapsed,\n      syncWindowControls,\n    \};/,
    'double-click on the bar and Desk restore reach the same fold');
  assert.match(spawnBody, /try \{ controlObserver\?\.disconnect\(\); \} catch \{\}/);
  assert.match(surfaceCss, /^\.egd-canvas-card\.egd-card-collapsed:not\(\.egd-card-fullscreen\) > \.egd-chat-card-body \{\n  display: none !important;\n\}/m,
    'folded, the Chat window shows only its bar');
  assert.match(surfaceCss, /^\.egd-canvas-card\.egd-card-collapsed:not\(\.egd-card-fullscreen\) > \.egd-chat-card-head > \.egd-chat-card-header:last-child \{\n  border-bottom-color: transparent;\n  border-radius: 8px;\n\}/m);
  // The same Board control and menu the other Desk Windows use.
  assert.match(spawnBody, /class: 'egd-desk-window-board', role: 'note', hidden: true/);
  assert.match(spawnBody, /class: 'egd-desk-window-board-menu'[\s\S]*?state\.toggleViewBoardMenu\?\.\(card, ev\.currentTarget\)/);
  assert.match(spawnBody, /card\._deskWindowShell = \{/);
  assert.match(spawnBody, /syncDeskWindowBoardMetadata\(card\);/);
  assert.match(spawnBody, /state\.offerBoardMembership\?\.\(card, 'drop'\)/, 'a drop into a Board only offers membership');
  assert.match(spawnBody, /state\.offerBoardMembership\?\.\(card, 'open'\)/);
  // '우측' became a named icon button.
  assert.equal(header.match(/class: 'egd-chat-card-action'/g)?.length, 1);
  assert.ok(header.includes("title: '오른쪽 패널로 옮기기'") && header.includes("'aria-label': '오른쪽 패널로 옮기기'"));
  assert.ok(header.includes("deskIcon('sidepanel')") && !header.includes("'우측'"));
  assert.match(surfaceSource, /\n    sidepanel: \[\[/, 'the icon exists');
});

test('the name follows the open conversation and the edges resize through the shared hit zones', () => {
  assert.match(spawnBody, /const open = codex\.activeThreadId \? getCodexThreadById\(codex, codex\.activeThreadId\) : null;/,
    'only the conversation the person opened is named, never the first room');
  assert.match(spawnBody, /ChatFrame\.chatFrameTitle\(\{ thread: open, view: normalizeHudView\(codex\.hudView\) \}\)/);
  assert.match(spawnBody, /state\.codexBridge\.subscribe\(syncChatFrameTitle\)/);
  assert.match(spawnBody, /unsubscribeFrameTitle\?\.\(\);/, 'closing the window stops the name updates');
  assert.match(spawnBody, /DESK_WINDOW_RESIZE_HITS\.map\(\(\{ cls, edges \}\) => el\('div', \{\n\s+class: `egd-card-resize-hit \$\{cls\}`,\n\s+data: \{ edges: JSON\.stringify\(edges\) \},/);
  assert.match(spawnBody, /ChatFrame\.resizeFrameRect\(resize, resize\.edges, \(ev\.clientX - resize\.x\) \/ s, \(ev\.clientY - resize\.y\) \/ s, resize\.limits\)/);
  assert.match(spawnBody, /if \(ev\.button !== 0 \|\| isCardFullscreen\(card\)\) return;/, 'a maximized window does not resize');
  assert.match(spawnBody, /if \(resize\) markAgendaDirty\('resize-chat-card', card\);/);
});

test('production resize: an edge drag resizes what is shown, keeps the minimum, and records one change', () => {
  const resizeStart = spawnBody.indexOf('    let resize = null;\n    for (const hit of resizeHits) {');
  const resizeEnd = spawnBody.indexOf("    body.addEventListener('wheel', routeWheelToCanvas, { passive: false });", resizeStart);
  const moveStart = spawnBody.indexOf('    const onMove = (ev) => {', resizeEnd);
  const moveEnd = spawnBody.indexOf("    window.addEventListener('mousemove', onMove);", moveStart);
  assert.ok(resizeStart > 0 && resizeEnd > resizeStart && moveStart > resizeEnd && moveEnd > moveStart, 'read the real handlers');
  const build = new Function('resizeHits', 'startPanIfNeeded', 'isCardFullscreen', 'card', 'focusCard', 'window', 'parsePxNumber',
    'ChatFrame', 'canvasZoom', 'markAgendaDirty', 'state',
    `let drag = null;\n${spawnBody.slice(resizeStart, resizeEnd)}\n${spawnBody.slice(moveStart, moveEnd)}\nreturn { onMove, onUp, setDrag(value) { drag = value; } };`);
  const listeners = new Map();
  const hit = edges => ({ dataset: { edges: JSON.stringify(edges) }, addEventListener: (name, listener) => listeners.set(JSON.stringify(edges), listener) });
  const hits = [hit({ left: true, top: true }), hit({ right: true, bottom: true })];
  const card = { id: 'chat-1', offsetLeft: 100, offsetTop: 200, offsetWidth: 500, offsetHeight: 520,
    style: { left: '100px', top: '200px', width: '500px', height: '600px', maxHeight: '520px' } };
  const dirty = [];
  const offers = [];
  let fullscreen = false, focused = 0, panning = false, zoom = 0.5;
  const handlers = build(hits, () => panning, () => fullscreen, card, () => focused++,
    { getComputedStyle: () => ({ minWidth: '320px', minHeight: '420px' }) },
    (value, fallback = 0) => { const parsed = Number.parseFloat(value); return Number.isFinite(parsed) ? parsed : fallback; },
    { resizeFrameRect, CHAT_FRAME_MIN_WIDTH, CHAT_FRAME_MIN_HEIGHT }, () => zoom,
    (reason, entity) => dirty.push([reason, entity.id]), { offerBoardMembership: (view, trigger) => offers.push(trigger) });
  const press = (edges, extra = {}) => {
    const calls = { prevented: 0, stopped: 0 };
    listeners.get(JSON.stringify(edges))({ button: 0, clientX: 300, clientY: 300, ...extra,
      preventDefault: () => calls.prevented++, stopPropagation: () => calls.stopped++ });
    return calls;
  };

  // Not while panning, not with another button, not while maximized.
  panning = true; press({ right: true, bottom: true }); panning = false;
  press({ right: true, bottom: true }, { button: 2 });
  fullscreen = true; press({ right: true, bottom: true }); fullscreen = false;
  handlers.onMove({ clientX: 400, clientY: 400 });
  handlers.onUp();
  assert.deepEqual([card.style.width, card.style.height, card.style.maxHeight, focused, dirty.length], ['500px', '600px', '520px', 0, 0]);

  // The Dock fit showed 520px of a saved 600px: the drag starts from what is shown.
  assert.deepEqual(press({ right: true, bottom: true }), { prevented: 1, stopped: 1 });
  assert.deepEqual([card.style.height, card.style.maxHeight, focused], ['520px', '', 1]);
  handlers.onMove({ clientX: 320, clientY: 330 });
  assert.deepEqual([card.style.left, card.style.top, card.style.width, card.style.height], ['100px', '200px', '540px', '580px'], 'screen px over the camera zoom');
  handlers.onMove({ clientX: -2000, clientY: -2000 });
  assert.deepEqual([card.style.width, card.style.height], ['320px', '420px'], 'the CSS minimum holds');
  handlers.onUp();
  assert.deepEqual(dirty, [['resize-chat-card', 'chat-1']]);
  assert.deepEqual(offers, [], 'a resize never offers Board membership');
  handlers.onMove({ clientX: 900, clientY: 900 });
  assert.deepEqual([card.style.width, card.style.height], ['320px', '420px'], 'released: nothing follows the pointer');

  // The top-left corner moves the origin and keeps the far corner.
  Object.assign(card, { offsetLeft: 100, offsetTop: 200, offsetWidth: 500, offsetHeight: 600 });
  press({ left: true, top: true });
  handlers.onMove({ clientX: 290, clientY: 280 });
  assert.deepEqual([card.style.left, card.style.top, card.style.width, card.style.height], ['80px', '160px', '520px', '640px']);
  handlers.onUp();

  // A header drag that really moved offers membership once; a plain press does not.
  handlers.setDrag({ x: 0, y: 0, left: 100, top: 200 });
  handlers.onUp();
  assert.deepEqual(offers, []);
  handlers.setDrag({ x: 0, y: 0, left: 40, top: 200 });
  handlers.onUp();
  assert.deepEqual(offers, ['drop']);
  assert.deepEqual(dirty.map(([reason]) => reason), ['resize-chat-card', 'resize-chat-card', 'move-chat-card', 'move-chat-card']);
});

test('the Chat bar styles sit on tokens and lay the Board name at the right', () => {
  const rule = selector => surfaceCss.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`, 'm'))?.[1] || '';
  assert.match(rule('.egd-chat-card-head'), /flex: none;/);
  assert.match(rule('.egd-chat-card-title-group'), /flex: 1 1 auto;/, 'the name takes the room; Board and actions keep the right');
  const title = rule('.egd-chat-card-title');
  assert.match(title, /color: var\(--egd-on-surface\);/);
  assert.match(title, /text-overflow: ellipsis;/);
  for (const selector of ['.egd-chat-card-head', '.egd-chat-card-title-group', '.egd-chat-card .egd-desk-window-control:focus-visible']) {
    const body = rule(selector);
    assert.ok(body, `${selector} found`);
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, `${selector} uses tokens only`);
  }
});
