// A36 / B70 / B27 / B06 (UX-03, BRW-01): general words on screen are Korean,
// the way back to a conversation has one name, and close buttons draw the shared
// line icon instead of a letter glyph. The surface source stays the source of
// truth; this file reads it. Controls owned by other screen areas (Chat input
// chips, Thread member menu, Browser toolbar, Terminal) are not listed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCssRules } from '../overlay/resources/EGDeskDesignTokens.sys.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const surfaceJs = read('../overlay/JS/eg-desk-surface.uc.js');
const surfaceRules = readCssRules(read('../overlay/CSS/eg-desk-surface.uc.css'));

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
}
const occurrences = (source, needle) => source.split(needle).length - 1;

test('A36 built-in Agent labels are Korean except the product names Chat and PM', () => {
  const block = between(surfaceJs, 'const CODEX_AGENT_PROFILE_DEFS = [', 'const CODEX_AGENT_PROFILES =');
  const rows = [...block.matchAll(/id: '([^']+)',\n\s+label: '([^']+)'/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(rows, [
    ['conversational-coding', 'Chat'], ['tool-operator', '도구'], ['coding-project-manager', 'PM'],
    ['codebase-explorer', '탐색'], ['implementation-worker', '구현'], ['review-verifier', '검증'],
  ], 'stored ids stay; only the label shown on screen changes');
});

test('A36 Settings and Ontology windows fall back to Korean names', () => {
  assert.ok(surfaceJs.includes("settings: ['.egd-settings-title', '설정'], ontology: ['.egd-ontology-title', '온톨로지']"));
  const rail = between(surfaceJs, 'function cardLabelForViewportRail(card) {', '\n  }\n');
  assert.match(rail, /egd-settings-card'\)\) return '설정';/);
  assert.match(rail, /egd-ontology-card'\)\) return '온톨로지';/);
  for (const english of ["'Settings'", "'Ontology'"]) assert.equal(occurrences(surfaceJs, english), 0, english);
});

test('B70 the way back to a conversation has one name', () => {
  assert.equal(occurrences(surfaceJs, "'대화로 돌아가기'"), 1);
  for (const old of ['채팅으로 돌아가기', "'← 돌아가기'"]) assert.equal(occurrences(surfaceJs, old), 0, old);
  // The Agent form says where its link goes instead of a bare "back".
  assert.ok(surfaceJs.includes("agents.profileId ? '← Agent 상세로' : '← Agent 목록으로'"));
});

// 2026-11-17 UX-03: the window title follows the Dock button '대화' (was '채팅'),
// so the same window has one name; the internal app id stays 'chat'.
test('B27 the side Chat panel is titled 대화 like its Dock button, not 코덱스 채팅 or 채팅', () => {
  assert.equal(occurrences(surfaceJs, '코덱스 채팅'), 0);
  assert.ok(surfaceJs.includes("textContent = appId === 'chat' ? '대화' : appLabel;"));
  assert.ok(surfaceJs.includes("el('span', { class: 'egd-hud-title' }, '대화')"));
  assert.equal(occurrences(surfaceJs, "toggleHUD('chat', '채팅'"), 0);
});

// 2026-11-17 UX-03: the Chat-area controls that were a bare × or a hover-less
// ✓ now carry Korean words, and both back buttons have one name.
test('UX-03 Chat input chips, suggestion close, member menu check and the back button read in Korean', () => {
  assert.equal(occurrences(surfaceJs, "}, '×')"), 0, 'no bare × button text remains');
  assert.ok(surfaceJs.includes("onclick: () => bridge.removeInputSource(thread.id, source.id) }, '빼기')"));
  assert.ok(surfaceJs.includes("onclick: () => bridge.removeBriefingInput(thread.id, reference.sourceId) }, '빼기')"));
  assert.ok(surfaceJs.includes("onclick: () => { void bridge.clearRequestProjectTarget(thread.id); } }, '해제')"));
  assert.ok(surfaceJs.includes("onclick: () => bridge.dismissContextSuggestions(thread.id) }, '닫기')"));
  assert.ok(surfaceJs.includes("'aria-label': '자료 추천 닫기', title: '자료 추천 닫기'"));
  assert.equal(occurrences(surfaceJs, "title: '지금 역할' }, deskIcon('check', 'egd-codex-thread-member-menu-check')"), 2);
  assert.equal(occurrences(surfaceJs, '대화 목록으로 돌아가기'), 0);
  assert.equal(occurrences(surfaceJs, "title: '대화 목록으로',\n              'aria-label': '대화 목록으로',"), 2);
});

test('A36 an unnamed window and a system message fall back to Korean words', () => {
  for (const english of ["'Card'", "'System'"]) assert.equal(occurrences(surfaceJs, english), 0, english);
  const rail = between(surfaceJs, 'function cardLabelForViewportRail(card) {', '\n  }\n');
  assert.match(rail, /if \(!card\) return '창';/);
  assert.match(rail, /getAttribute\('title'\) \|\| '창';/);
  assert.match(between(surfaceJs, 'function codexMessageRoleLabel(role) {', '\n  }\n'), /role === 'system'\) return '시스템';/);
});

test('B06 the open-file arrow on result chips is the shared arrow icon', () => {
  assert.equal(occurrences(surfaceJs, "'↗'"), 0);
  assert.equal(occurrences(surfaceJs, "{ 'aria-hidden': 'true', class: 'egd-codex-result-arrow' }, deskIcon('arrow'))"), 2);
  const rule = surfaceRules.find(candidate => candidate.selectors.includes('.egd-codex-result-arrow .egd-ui-icon'));
  assert.ok(rule, 'the arrow needs a size beside the chip label');
  const declared = Object.fromEntries(rule.declarations);
  assert.equal(declared.width, declared.height);
});

// Each entry: a marker that starts the control, and how many of them exist.
const ICON_CLOSE_CONTROLS = [
  ["class: 'egd-store-panel-close'", 6],
  ["class: 'egd-minimap-close'", 1],
  ["class: 'egd-settings-chip-remove'", 1],
  ["'aria-label': '안내 닫기', onclick: () => notice.remove()", 1],
];

test('B06 panel, minimap, notice and chip close buttons draw the shared close icon', () => {
  for (const [marker, count] of ICON_CLOSE_CONTROLS) {
    const parts = surfaceJs.split(marker);
    assert.equal(parts.length - 1, count, marker);
    for (const tail of parts.slice(1)) {
      // The button call ends at its last argument; a named control ends within a few lines.
      const call = tail.slice(0, tail.search(/\}, (?:deskIcon\('close'\)|'[^']*')\)/) + 40);
      assert.match(call, /\}, deskIcon\('close'\)\)/, `${marker} must end with the close icon`);
      assert.doesNotMatch(call, /'×'/, marker);
    }
  }
});

test('B06 every icon-only close button keeps a spoken name', () => {
  for (const [marker] of ICON_CLOSE_CONTROLS) {
    for (const tail of surfaceJs.split(marker).slice(1)) {
      const at = surfaceJs.indexOf(tail);
      const call = surfaceJs.slice(surfaceJs.lastIndexOf("el('button', {", at), at + tail.indexOf("deskIcon('close')"));
      assert.match(call, /'aria-label': (?:'[^']+'|`[^`]+`)/, marker);
    }
  }
});

test('B06 the close icon has a set size inside each of those buttons', () => {
  for (const selector of ['.egd-store-panel-close .egd-ui-icon', '.egd-minimap-close .egd-ui-icon',
    '.egd-settings-chip-remove .egd-ui-icon', '#egd-board-notice button .egd-ui-icon']) {
    const rule = surfaceRules.find(candidate => candidate.selectors.includes(selector));
    assert.ok(rule, `missing ${selector}`);
    const declared = Object.fromEntries(rule.declarations);
    assert.match(declared.width || '', /^1[0-6]px$/, selector);
    assert.equal(declared.height, declared.width, selector);
    assert.equal(declared.margin, 'auto', `${selector} is centred in its button`);
  }
});
