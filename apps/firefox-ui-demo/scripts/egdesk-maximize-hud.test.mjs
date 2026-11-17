import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAXIMIZE_HUD_EDGE_PX, MAXIMIZE_HUD_PEEK_OPEN_DELAY_MS, MAXIMIZE_HUD_PEEK_CLOSE_GRACE_MS,
  presentationBadge, nextHudState, hudKeptOnRestore, pointerInsidePeekZone, peekClosesOnPointerLeave,
  pinControlCopy,
} from '../overlay/resources/EGDeskMaximizeHud.sys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');

// ------------------------------------------------------------------ badge copy

test('badge: a maximized View reads "○○ · 크게 보는 중" and a focus View reads "○○ · 집중 보기", never English', () => {
  const maximized = presentationBadge('회의 자료', 'maximized');
  assert.equal(maximized.text, '회의 자료 · 크게 보는 중');
  assert.equal(maximized.title, '회의 자료 창을 크게 보는 중 — 누르면 원래 크기로 돌아갑니다');
  const focus = presentationBadge('회의 자료', 'focus');
  assert.equal(focus.text, '회의 자료 · 집중 보기');
  assert.equal(focus.title, '회의 자료 창을 집중 보기 중 — 누르면 원래 크기로 돌아갑니다');
  assert.equal(presentationBadge('', 'maximized').text, '창 · 크게 보는 중', 'an unnamed View still says what is happening');
  assert.equal(presentationBadge('Terminal', 'maximized').text, '터미널 · 크게 보는 중', 'type names follow the Dock wording');
  assert.equal(presentationBadge('Settings', 'focus').text, '설정 · 집중 보기');
  assert.equal(presentationBadge('Card', 'maximized').text, '창 · 크게 보는 중');
  for (const badge of [maximized, focus]) assert.doesNotMatch(badge.text + badge.title, /Maximized|Focus|Fullscreen/i);
});

test('badge: a long View name is shortened so the state words always stay visible; the tooltip keeps the full name', () => {
  const long = '2026년 5월 태화 월간 운영 리포트 최종본 검토용';
  const badge = presentationBadge(long, 'maximized');
  assert.equal(badge.text, '2026년 5월 태화 월간 운영… · 크게 보는 중');
  assert.ok(badge.title.startsWith(`${long} 창을 크게 보는 중`), 'the tooltip names the whole View');
  assert.equal(presentationBadge('가'.repeat(18), 'focus').text, `${'가'.repeat(18)} · 집중 보기`, 'a name at the limit is left alone');
  assert.equal(presentationBadge('  회의   자료  ', 'maximized').text, '회의 자료 · 크게 보는 중', 'stray spacing is tidied');
});

// ------------------------------------------------------------- HUD mode reducer

const hidden = { mode: 'maximized', hudMode: 'hidden', peekSource: null };

test('timings: the right edge waits about 300ms to open and about 400ms to close, on an 8px strip', () => {
  assert.equal(MAXIMIZE_HUD_EDGE_PX, 8);
  assert.equal(MAXIMIZE_HUD_PEEK_OPEN_DELAY_MS, 300);
  assert.equal(MAXIMIZE_HUD_PEEK_CLOSE_GRACE_MS, 400);
});

test('edge hover peeks, leaving hides again, and the View is never resized by a peek', () => {
  const peek = nextHudState(hidden, 'edge-dwell');
  assert.deepEqual(peek, { mode: 'maximized', hudMode: 'peek', peekSource: 'edge', avoidHud: false });
  assert.equal(peekClosesOnPointerLeave(peek), true);
  const left = nextHudState(peek, 'pointer-leave');
  assert.deepEqual(left, { mode: 'maximized', hudMode: 'hidden', peekSource: null, avoidHud: false });
  assert.equal(hudKeptOnRestore(peek), false, 'a hover peek is transient and does not survive restore');
});

test('the Dock chat button opens Chat in one step and that Chat survives returning to the original size', () => {
  const opened = nextHudState(hidden, 'dock-open');
  assert.deepEqual(opened, { mode: 'maximized', hudMode: 'peek', peekSource: 'dock', avoidHud: false });
  assert.equal(peekClosesOnPointerLeave(opened), false, 'an explicitly opened Chat does not vanish when the pointer moves away');
  assert.deepEqual(nextHudState(opened, 'pointer-leave'), opened);
  assert.equal(hudKeptOnRestore(opened), true);
  assert.equal(nextHudState(nextHudState(hidden, 'edge-dwell'), 'dock-open').peekSource, 'dock', 'a click upgrades a hover peek');
});

test('pin docks Chat beside the View (only then is the View refitted) and pin again returns to an overlay peek', () => {
  const peek = nextHudState(hidden, 'edge-dwell');
  const pinned = nextHudState(peek, 'pin-toggle');
  assert.deepEqual(pinned, { mode: 'maximized', hudMode: 'pinned', peekSource: null, avoidHud: true });
  assert.equal(hudKeptOnRestore(pinned), true);
  for (const event of ['pointer-leave', 'dismiss', 'edge-dwell', 'dock-open']) {
    assert.deepEqual(nextHudState(pinned, event), pinned, `${event} leaves a pinned Chat alone`);
  }
  const unpinned = nextHudState(pinned, 'pin-toggle');
  assert.deepEqual(unpinned, { mode: 'maximized', hudMode: 'peek', peekSource: 'dock', avoidHud: false });
  assert.deepEqual(nextHudState(hidden, 'pin-toggle'), { ...hidden, avoidHud: false }, 'nothing to pin while Chat is hidden');
});

test('outside click or Esc dismisses either kind of peek; closing Chat always hides', () => {
  for (const source of ['edge-dwell', 'dock-open']) {
    assert.equal(nextHudState(nextHudState(hidden, source), 'dismiss').hudMode, 'hidden');
  }
  assert.equal(nextHudState(nextHudState(nextHudState(hidden, 'edge-dwell'), 'pin-toggle'), 'hud-closed').hudMode, 'hidden');
  assert.equal(hudKeptOnRestore(nextHudState(nextHudState(hidden, 'dock-open'), 'hud-closed')), false);
});

test('focus view never shows Chat: every event keeps it hidden', () => {
  const focus = { mode: 'focus', hudMode: 'hidden', peekSource: null };
  for (const event of ['edge-dwell', 'dock-open', 'pin-toggle', 'pointer-leave', 'dismiss']) {
    assert.equal(nextHudState(focus, event).hudMode, 'hidden');
  }
  assert.equal(nextHudState({ mode: 'focus', hudMode: 'pinned', peekSource: null }, 'enter-focus').hudMode, 'hidden');
  assert.equal(nextHudState(undefined, 'edge-dwell').hudMode, 'peek', 'missing state defaults to a maximized, hidden HUD');
  assert.deepEqual(nextHudState(hidden, 'unknown-event'), { ...hidden, avoidHud: false });
});

test('pointer zone: the Chat panel, its slack and the gutter to the right edge count as inside', () => {
  const hud = { left: 874, top: 72, right: 1270, bottom: 706 };
  assert.equal(pointerInsidePeekZone({ x: 1279, y: 300 }, hud), true, 'the right edge strip that opened the peek');
  assert.equal(pointerInsidePeekZone({ x: 900, y: 300 }, hud), true);
  assert.equal(pointerInsidePeekZone({ x: 860, y: 300 }, hud), true, 'inside the slack');
  assert.equal(pointerInsidePeekZone({ x: 820, y: 300 }, hud), false);
  assert.equal(pointerInsidePeekZone({ x: 1000, y: 20 }, hud), false, 'top bar');
  assert.equal(pointerInsidePeekZone({ x: 1000, y: 760 }, hud), false, 'Dock');
  assert.equal(pointerInsidePeekZone({ x: 1000, y: 300 }, null), false);
  assert.equal(pointerInsidePeekZone(null, hud), false);
});

test('pin control copy is Korean and tells both states apart', () => {
  assert.deepEqual(pinControlCopy('peek'), { label: '고정', title: '채팅을 옆에 고정 — 크게 보는 창이 그만큼 좁아집니다', pressed: false });
  assert.deepEqual(pinControlCopy('pinned'), { label: '고정 해제', title: '고정 해제 — 채팅이 창 위로 겹쳐 보입니다', pressed: true });
});

// ---------------------------------------------------------------- surface wiring

const functionBody = name => {
  const header = `  function ${name}(`;
  const start = surfaceSource.indexOf(header);
  assert.ok(start >= 0, `${name} must exist`);
  const end = surfaceSource.indexOf('\n  }', start);
  return surfaceSource.slice(start, end + 4);
};

test('surface: the English "Maximized" badge is gone and the badge is a real button outside the Board switcher', () => {
  assert.doesNotMatch(surfaceSource, /· Maximized/);
  assert.doesNotMatch(surfaceSource, /el\('span', \{ class: 'egd-rail-card-badge'/, 'no button nested in the Board switcher button');
  const ensure = functionBody('ensureCardPresentationBadge');
  assert.match(ensure, /el\('button', \{[^}]*class: 'egd-rail-card-badge'/);
  assert.match(ensure, /exitCardFullscreen\(\)/);
  assert.match(ensure, /집중 보기/);
  assert.match(functionBody('syncViewportAgendaRail'), /MaximizeHud\.presentationBadge\(/);
});

test('surface: the top-bar badge buttons take clicks instead of dragging the window', () => {
  const rule = css.match(/button\.egd-rail-card-badge,\s*button\.egd-rail-focus-view \{([^}]+)\}/);
  assert.ok(rule, 'the two top-bar buttons share one rule');
  assert.match(rule[1], /-moz-window-dragging:\s*no-drag/, 'the top bar itself is a window drag handle');
  assert.match(rule[1], /cursor:\s*pointer/);
});

test('surface: while a window is shown large the top-bar name and badge keep their full text', () => {
  // The quiet record status leaves instead of shrinking to a stub; a failure still shows.
  assert.match(css, /@media \(max-width: 1599px\) \{\n  :root\.egd-card-fullscreen-active \.egd-rail-record-status:not\(\[data-state="failed"\]\) \{ display: none; \}\n\}/);
  // Shrink is shared in proportion, so each tier must outweigh the next by far: record status, Board name, badge.
  const shrink = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = css.match(new RegExp(`\\n\\s*${escaped} \\{[^}]*?flex(?:-shrink)?: (?:0 )?(\\d+)`));
    assert.ok(found, `${selector} declares its shrink weight`);
    return Number(found[1]);
  };
  const record = shrink('.egd-rail-record-status');
  const switcherLarge = shrink(':root.egd-card-fullscreen-active .egd-rail-switcher');
  const recordLarge = shrink(':root.egd-card-fullscreen-active .egd-rail-record-status:not([data-state="failed"])');
  assert.ok(record >= 10000, 'the record status takes the whole squeeze before the Board name loses a pixel');
  assert.ok(switcherLarge >= 10000, 'the Board name gives way before the badge');
  assert.ok(recordLarge >= switcherLarge * 10000, 'the record status still gives way before the Board name');
  assert.match(css, /\.egd-rail-presentation \{[^}]*flex: 0 1 auto;/, 'the badge group shrinks last, with weight 1');
});

test('surface: maximize keeps Desk chrome for every View type; only focus view hides it', () => {
  const enter = functionBody('enterCardFullscreen');
  assert.match(enter, /mode: focusView \? 'focus' : 'maximized'/);
  assert.match(enter, /if \(focusView\) \{[^}]*egd-card-focus-active/s);
  assert.doesNotMatch(enter, /if \(card\.classList\.contains\('egd-browser-card'\)\) \{\s*document\.documentElement\.classList\.add\('egd-browser-fullscreen-active'\)/,
    'a Browser is no longer forced edge-to-edge by its type');
  const layout = functionBody('syncCardFullscreenLayout');
  assert.match(layout, /avoidHud: fullscreen\.hudMode === 'pinned'/, 'only a pinned Chat refits the maximized View');
  const hiddenRule = css.match(/:root\.egd-card-focus-active #egd-desk-rail,([\s\S]*?)\{([^}]+)\}/);
  assert.ok(hiddenRule, 'focus view hides Desk chrome');
  for (const id of ['egd-dock', 'egd-preset-bag', 'egd-hud', 'egd-zoom-indicator', 'egd-desk-minimap']) {
    assert.match(hiddenRule[1], new RegExp(`#${id}\\b`));
  }
  assert.match(css, /:root:not\(\.egd-card-focus-active\) #egd-focus-view-exit,\s*:root\.egd-initial-browser-focus #egd-focus-view-exit \{\s*display: none/,
    'the exit button exists only in a user-chosen focus view');
});

test('surface: the badge names a Browser by its page title and a memo by its memo title', () => {
  assert.match(functionBody('syncViewportAgendaRail'), /MaximizeHud\.presentationBadge\(presentationBadgeLabel\(card\), state\.cardFullscreen\.mode\)/);
  const label = Function('cardLabelForViewportRail', `${functionBody('presentationBadgeLabel')}\nreturn presentationBadgeLabel;`)(() => '줄 이름');
  const view = (classes, titles = {}) => ({
    classList: { contains: name => classes.includes(name) },
    querySelector: selector => (selector in titles ? { textContent: titles[selector] } : null),
  });
  const badge = card => presentationBadge(label(card), 'maximized').text;
  assert.equal(badge(view(['egd-canvas-card', 'egd-browser-card'], { '.egd-card-page-title': ' DuckDuckGo ' })), 'DuckDuckGo · 크게 보는 중');
  assert.equal(badge(view(['egd-canvas-card', 'egd-browser-card'], { '.egd-card-page-title': '' })), 'Browser · 크게 보는 중', 'a page with no title yet');
  assert.equal(badge(view(['egd-canvas-card', 'egd-browser-card'])), 'Browser · 크게 보는 중');
  assert.equal(badge(view(['egd-canvas-card', 'egd-memo-card'], { '.egd-memo-title': '메모 #1' })), '메모 #1 · 크게 보는 중');
  assert.equal(badge(view(['egd-canvas-card', 'egd-memo-card'])), '메모 · 크게 보는 중');
  assert.equal(badge(view(['egd-canvas-card', 'egd-file-card'])), '줄 이름 · 크게 보는 중', 'other Views keep the name they already had');
});

test('surface: while one View is shown large the other windows, shapes and memo lines around it are not shown', () => {
  const rule = css.match(/:root\.egd-card-fullscreen-active #egd-canvas-layer :is\(([^{]+)\) \{([^}]+)\}/);
  assert.ok(rule, 'one root class hides the surroundings');
  assert.match(rule[1], /\.egd-canvas-card:not\(\.egd-card-fullscreen\)/, 'the View shown large itself stays');
  for (const selector of ['.egd-canvas-shape', '.egd-memo-tether']) assert.ok(rule[1].includes(selector), selector);
  assert.match(rule[2], /visibility: hidden;/);
  assert.doesNotMatch(rule[2], /display|left|top|width|height/, 'nothing is moved, resized or removed, so restoring shows everything as it was');
  assert.match(functionBody('exitCardFullscreen'), /classList\.remove\('egd-card-fullscreen-active'\)/);
});

test('surface: restoring keeps a Chat the user opened or pinned and never reopens the minimap twice', () => {
  const exit = functionBody('exitCardFullscreen');
  assert.match(exit, /restoreHudAfterCardFullscreen\(fullscreen\)/);
  const restoreHud = functionBody('restoreHudAfterCardFullscreen');
  assert.match(restoreHud, /const keepOpen = !!fullscreen\.hudKeptOnRestore \|\| !fullscreen\.previousHudHidden;/);
  assert.match(restoreHud, /if \(!keepOpen && state\.hudOpen\) \{\s*toggleHUD\(null\);/, 'a peeked-only Chat is closed rather than left open but hidden');
  assert.match(restoreHud, /setHudPresentationHidden\(!keepOpen\)/);
  assert.match(exit, /previousMinimapOpen && !document\.getElementById\('egd-desk-minimap'\)/);
  for (const name of ['egd-card-focus-active', 'egd-maximize-hud-peek', 'egd-maximize-hud-pinned']) {
    assert.match(exit, new RegExp(`classList\\.remove\\('${name}'\\)`), `${name} is cleared on restore`);
  }
});

test('surface: the minimap button works while a View is maximized and marks that View', () => {
  assert.doesNotMatch(functionBody('toggleDeskMinimap'), /if \(state\.cardFullscreen\) return;/);
  assert.match(functionBody('buildMinimapEntityMarker'), /state\.cardFullscreen\?\.cardId === entity\.id \? ' egd-minimap-entity-maximized'/);
  assert.match(css, /\.egd-minimap-entity-maximized \{/);
  // Choosing another place on the map restores the maximized View first; choosing the View itself keeps it.
  assert.match(functionBody('moveCameraToMinimapNode'),
    /if \(state\.cardFullscreen && state\.cardFullscreen\.cardId !== node\?\.id\) exitCardFullscreen\(\);\s*const rect = persistentEntityGeometry\(node\)/);
  const pan = functionBody('installDeskMinimapPan');
  assert.match(pan, /const setFromEvent = \(ev\) => \{\s*if \(state\.cardFullscreen\) \{[^}]*exitCardFullscreen\(\);\s*if \(drag\) drag\.mode = 'center';/);
});

test('surface: the right edge strip is not offered when Chat lives on the Canvas, and the Browser menu offers focus view', () => {
  assert.match(functionBody('maximizeHudPeekAvailable'), /chatDockMode === 'canvas' && document\.getElementById\(state\.codex\.chatCardEntityId \|\| ''\)/);
  const edgeSync = functionBody('syncMaximizeHudEdge');
  assert.match(edgeSync, /getElementById\('egd-maximize-hud-edge'\)/);
  assert.match(edgeSync, /const unavailable = !maximizeHudPeekAvailable\(\);\s*if \(edge && edge\.hidden !== unavailable\) edge\.hidden = unavailable;/);
  assert.match(functionBody('syncViewportAgendaRail'), /presentation\.hidden = false;\s*syncMaximizeHudEdge\(\);/, 'entering maximize refreshes the strip');
  assert.match(functionBody('syncMaximizeHudPinControl'), /syncMaximizeHudEdge\(\);/);
  assert.match(functionBody('openMaximizeHudPeek'), /if \(!maximizeHudPeekAvailable\(\)\) return false;/);
  assert.match(css, /#egd-maximize-hud-edge\[hidden\] \{ display: none !important; \}/);
  // Browser window menu: Korean names for both modes (leaving focus view has its own always-visible button).
  assert.match(surfaceSource, /item\(isCardFullscreen\(card\) \? '원래 크기로' : '크게 보기',/);
  assert.match(surfaceSource, /item\('집중 보기', '상단 바와 Dock을 숨기고 화면 전체로 봅니다', \(\) => enterCardFocusView\(card\)\)/);
  assert.doesNotMatch(surfaceSource, /Desk Window 최대화 전환|'창 복귀'/, 'no developer wording left on the maximize entry');
  assert.match(functionBody('isCardFocusView'), /isCardFullscreen\(card\) && state\.cardFullscreen\.mode === 'focus'/);
});

test('surface: the Dock chat button reveals a Chat that maximize only hid, before any teardown runs', () => {
  const toggle = functionBody('toggleHUD');
  const reveal = toggle.indexOf('revealPresentationHiddenHud(');
  assert.ok(reveal > 0);
  assert.ok(reveal < toggle.indexOf('_codexCleanup'), 'reveal happens before the mounted Chat is torn down');
});

test('surface: peek timers use the shared constants, reduced motion is immediate, and floating controls are labelled', () => {
  const install = functionBody('installMaximizeHudControls');
  assert.match(install, /MaximizeHud\.MAXIMIZE_HUD_PEEK_OPEN_DELAY_MS/);
  assert.match(install, /MaximizeHud\.MAXIMIZE_HUD_PEEK_CLOSE_GRACE_MS/);
  assert.match(install, /'aria-label': '채팅 엿보기'/);
  assert.match(install, /집중 보기 종료/);
  // UX-06: Escape closes the peek only through the one Escape layer registry.
  assert.doesNotMatch(install, /ev\.key !== 'Escape'/);
  assert.match(surfaceSource, /id: 'chat-peek', kind: 'peek',[\s\S]{0,240}SurfaceKeys\.chatPeekEscapeOpen\([\s\S]{0,200}dismiss: \(\) => closeMaximizeHudPeek\(\)/);
  // The edge strip, exit button and Chat panel are all #egd-* ids, so the one
  // global reduced-motion rule makes the peek appear and leave at once.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{\s*\[id\^="egd-"\], \[id\^="egd-"\] \*, \[id\^="egd-"\]::before,[^{]*\{([^}]+)\}/);
  assert.ok(reduced, 'the global reduced-motion rule covers #egd-* elements and their ::before');
  assert.match(reduced[1], /transition:\s*none\s*!important/);
  for (const id of ['egd-maximize-hud-edge', 'egd-focus-view-exit']) assert.match(install, new RegExp(`id: '${id}'`));
  for (const selector of ['#egd-maximize-hud-edge:hover', '#egd-maximize-hud-edge:focus-visible', '.egd-hud-maximize-pin:hover',
    '.egd-hud-maximize-pin:focus-visible', '#egd-focus-view-exit:hover', '#egd-focus-view-exit:focus-visible',
    '.egd-rail-card-badge:hover', '.egd-rail-card-badge:focus-visible', '.egd-rail-focus-view:hover', '.egd-rail-focus-view:focus-visible']) {
    assert.ok(css.includes(selector), `${selector} state exists`);
  }
});
