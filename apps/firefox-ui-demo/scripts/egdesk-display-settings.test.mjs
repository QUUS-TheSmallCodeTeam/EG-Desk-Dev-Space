import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as Display from '../overlay/resources/EGDeskDisplaySettings.sys.mjs';
import { readCssRules } from '../overlay/resources/EGDeskDesignTokens.sys.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const surfaceCss = fs.readFileSync(path.join(root, 'overlay/CSS/eg-desk-surface.uc.css'), 'utf8');
const surfaceSource = fs.readFileSync(path.join(root, 'overlay/JS/eg-desk-surface.uc.js'), 'utf8');

test('display settings default to following the system and drop unknown values', () => {
  assert.deepEqual(Display.DISPLAY_DEFAULTS, { theme: 'system', motion: 'system' });
  assert.deepEqual(Display.normalizeDisplaySettings(null), { theme: 'system', motion: 'system' });
  assert.deepEqual(Display.normalizeDisplaySettings({ theme: 'dark', motion: 'reduce' }), { theme: 'dark', motion: 'reduce' });
  assert.deepEqual(Display.normalizeDisplaySettings({ theme: 'sepia', motion: 'fast', extra: 1 }), { theme: 'system', motion: 'system' });
  assert.deepEqual(Display.normalizeDisplaySettings('dark'), { theme: 'system', motion: 'system' });
});

test('stored text round-trips; defaults store nothing so the pref can be cleared', () => {
  assert.equal(Display.serializeDisplaySettings({ theme: 'system', motion: 'system' }), null);
  const text = Display.serializeDisplaySettings({ theme: 'light', motion: 'reduce' });
  assert.equal(typeof text, 'string');
  assert.deepEqual(Display.parseDisplaySettings(text), { theme: 'light', motion: 'reduce' });
  for (const broken of [null, '', '{', '[]', '"dark"', '{"theme":7}']) {
    assert.deepEqual(Display.parseDisplaySettings(broken), { theme: 'system', motion: 'system' });
  }
});

test('root attributes: a forced choice sets the attribute, following the system removes it', () => {
  assert.deepEqual(Display.displayRootAttributes({ theme: 'system', motion: 'system' }),
    { 'data-egd-theme': null, 'data-egd-motion': null });
  assert.deepEqual(Display.displayRootAttributes({ theme: 'light', motion: 'system' }),
    { 'data-egd-theme': 'light', 'data-egd-motion': null });
  assert.deepEqual(Display.displayRootAttributes({ theme: 'dark', motion: 'reduce' }),
    { 'data-egd-theme': 'dark', 'data-egd-motion': 'reduce' });
  assert.deepEqual(Display.displayRootAttributes({ theme: 'nope' }), { 'data-egd-theme': null, 'data-egd-motion': null });
});

test('choices are Korean, exactly one is selected, and the system choice comes first', () => {
  const theme = Display.themeChoices({ theme: 'dark' });
  assert.deepEqual(theme.map(c => [c.id, c.label, c.selected]),
    [['system', '시스템 따라가기', false], ['light', '밝게', false], ['dark', '어둡게', true]]);
  const motion = Display.motionChoices({});
  assert.deepEqual(motion.map(c => [c.id, c.label, c.selected]),
    [['system', '시스템 따라가기', true], ['reduce', '항상 줄이기', false]]);
  for (const choice of [...theme, ...motion]) {
    assert.ok(choice.note && !/[A-Za-z]{4,}/.test(choice.note.replace(/EG-Desk|Chat|Desk|Board/g, '')), `plain Korean note: ${choice.note}`);
  }
  assert.equal(Display.CHAT_INPUT_HINT, 'Enter로 보내기 · Shift+Enter 줄바꿈');
});

test('radio keys move within the group and wrap; other keys do nothing', () => {
  const ids = ['system', 'light', 'dark'];
  assert.equal(Display.choiceForKey(ids, 'system', 'ArrowRight'), 'light');
  assert.equal(Display.choiceForKey(ids, 'dark', 'ArrowDown'), 'system');
  assert.equal(Display.choiceForKey(ids, 'system', 'ArrowLeft'), 'dark');
  assert.equal(Display.choiceForKey(ids, 'light', 'ArrowUp'), 'system');
  assert.equal(Display.choiceForKey(ids, 'light', 'Home'), 'system');
  assert.equal(Display.choiceForKey(ids, 'light', 'End'), 'dark');
  assert.equal(Display.choiceForKey(ids, 'light', 'Enter'), null);
  assert.equal(Display.choiceForKey(ids, 'gone', 'ArrowRight'), 'system');
  assert.equal(Display.choiceForKey([], 'x', 'ArrowRight'), null);
});

test('reset is offered only when something differs from the defaults', () => {
  assert.deepEqual(Display.displayResetView({ theme: 'system', motion: 'system' }),
    { disabled: true, label: '화면 설정 초기화', note: '지금은 처음 상태입니다.' });
  const changed = Display.displayResetView({ theme: 'dark', motion: 'reduce' });
  assert.equal(changed.disabled, false);
  assert.equal(changed.note, '화면 모드: 어둡게 · 동작 줄이기: 항상 줄이기 → 둘 다 시스템 따라가기로 돌아갑니다.');
  assert.equal(Display.displayResetView({ theme: 'light' }).note, '화면 모드: 밝게 → 시스템 따라가기로 돌아갑니다.');
});

test('data categories name what is kept where; only the display category resets here', () => {
  const rows = Display.dataCategories();
  assert.deepEqual(rows.map(r => r.id), ['display', 'account', 'agents', 'records']);
  assert.deepEqual(rows.map(r => r.title), ['화면·입력', '계정 연결', 'Agent 정의', '업무 기록']);
  assert.deepEqual(rows.filter(r => r.reset === 'here').map(r => r.id), ['display']);
  for (const row of rows) {
    assert.ok(row.holds && row.where && row.resetNote, `${row.id} explains itself`);
    assert.ok(['here', 'elsewhere', 'none'].includes(row.reset));
  }
  const records = rows.find(r => r.id === 'records');
  assert.equal(records.reset, 'none');
  assert.match(records.resetNote, /지우지 않습니다/);
});

// --- CSS: a forced theme reuses the approved light and dark token sets ---

const rules = readCssRules(surfaceCss);
const flat = selectors => selectors.map(selector => selector.replace(/\s+/g, ' '));
const sameSelectors = (a, b) => JSON.stringify(flat(a)) === JSON.stringify(flat(b));
const isDarkMedia = rule => rule.media.length === 1 && rule.media[0] === '(prefers-color-scheme: dark)';
const LIGHT = ':root[data-egd-theme="light"]';
const DARK = ':root[data-egd-theme="dark"]';

test('forced dark repeats the system dark token block value for value', () => {
  const systemDark = rules.filter(rule => isDarkMedia(rule) && rule.selectors.length === 1 && rule.selectors[0] === ':root');
  assert.equal(systemDark.length, 1, 'one system dark :root block');
  const forcedDark = rules.filter(rule => rule.media.length === 0 && rule.selectors.length === 1 && rule.selectors[0] === DARK);
  assert.equal(forcedDark.length, 1, 'one forced dark block');
  assert.ok(systemDark[0].declarations.length > 20);
  assert.deepEqual(forcedDark[0].declarations, systemDark[0].declarations,
    'edit both dark blocks together: the system block and :root[data-egd-theme="dark"]');
});

test('forced light restates every token the dark blocks change, so light wins on a dark system', () => {
  const darkNames = rules.find(rule => isDarkMedia(rule) && rule.selectors.includes(':root')).declarations.map(([name]) => name);
  const lightNames = new Set(rules.filter(rule => rule.media.length === 0 && rule.selectors.includes(LIGHT) && rule.selectors.includes(':root'))
    .flatMap(rule => rule.declarations.map(([name]) => name)));
  assert.deepEqual(darkNames.filter(name => !lightNames.has(name)), []);
});

test('contrast and forced-colour overrides still beat a forced theme', () => {
  for (const feature of ['(prefers-contrast: more)', '(forced-colors: active)']) {
    const block = rules.find(rule => rule.media.length === 1 && rule.media[0] === feature && rule.selectors.includes(':root'));
    assert.ok(block, feature);
    assert.ok(block.selectors.includes(':root[data-egd-theme]'), `${feature} needs the forced-theme selector to keep its specificity`);
  }
});

test('every other dark-only rule yields to forced light and has a forced-dark twin', () => {
  const others = rules.filter(rule => isDarkMedia(rule) && !rule.selectors.includes(':root'));
  // The search kind rule left with its dark-only wash: result kinds now follow tokens in both schemes.
  assert.ok(others.length >= 1, 'the inherited-ink rule');
  for (const rule of others) {
    const zero = rule.selectors.every(selector => selector.startsWith(':where(:root:not([data-egd-theme="light"])) '));
    const plain = rule.selectors.every(selector => selector.startsWith(':root:not([data-egd-theme="light"]) '));
    assert.ok(zero || plain, `dark-only rule must not apply under forced light: ${rule.selectors[0].slice(0, 80)}`);
    const twinSelectors = rule.selectors.map(selector => zero
      ? selector.replace(':where(:root:not([data-egd-theme="light"])) ', ':where(:root[data-egd-theme="dark"]) ')
      : selector.replace(':root:not([data-egd-theme="light"]) ', `${DARK} `));
    const twin = rules.find(candidate => candidate.media.length === 0 && sameSelectors(candidate.selectors, twinSelectors));
    assert.ok(twin, `forced dark twin missing for ${rule.selectors[0].slice(0, 80)}`);
    assert.deepEqual(twin.declarations, rule.declarations);
  }
});

test('forced light gives EG-Desk surfaces light native controls and the light ink', () => {
  const dark = rules.find(rule => rule.media.length === 0 && rule.selectors[0].startsWith(':where(:root[data-egd-theme="dark"]) :where('));
  const light = rules.find(rule => rule.media.length === 0 && rule.selectors[0].startsWith(':where(:root[data-egd-theme="light"]) :where('));
  assert.ok(dark && light);
  assert.deepEqual(flat(light.selectors).map(s => s.replace('"light"', '"dark"')), flat(dark.selectors), 'same surfaces in both forced rules');
  assert.deepEqual(light.declarations, [['color-scheme', 'light'], ['color', 'var(--egd-on-surface)']]);
  assert.deepEqual(dark.declarations, [['color-scheme', 'dark'], ['color', 'var(--egd-on-surface)']]);
});

test('a forced theme gives every floating EG-Desk panel the chosen ink instead of the system text colour', () => {
  // Menus, dialogs and panels hang directly off the window root. Without this
  // they inherit the system's text colour: dark text on a forced dark panel.
  for (const theme of ['dark', 'light']) {
    const rule = rules.find(candidate => candidate.media.length === 0 &&
      candidate.selectors[0].startsWith(`:where(:root[data-egd-theme="${theme}"]) > :where(`));
    assert.ok(rule, `floating panel rule for ${theme}`);
    assert.deepEqual(flat(rule.selectors),
      [`:where(:root[data-egd-theme="${theme}"]) > :where(:is([id^="egd-"], [class^="egd-"]):not(#egd-canvas-viewport, .egd-browser-card, .egd-terminal-card, .egd-ontology-card))`]);
    assert.deepEqual(rule.declarations, [['color-scheme', theme], ['color', 'var(--egd-on-surface)']]);
  }
  // The canvas host stays out: Browser page content, the Terminal and the
  // Ontology lens keep their own colours, as the scope note in Settings says.
  assert.match(surfaceSource, /host\.appendChild\(canvasViewport\);/);
});

test('"항상 줄이기" applies the same stillness as the system reduced-motion rule', () => {
  const reduced = rule => rule.media.length === 1 && rule.media[0] === '(prefers-reduced-motion: reduce)';
  // The system-wide rule names every EG-Desk element; narrower rules are checked below.
  const system = rules.filter(rule => reduced(rule) && rule.selectors.includes('[class*="egd-"]')
    && rule.declarations.some(([name]) => name === 'transition'));
  assert.equal(system.length, 1);
  const prefix = ':root[data-egd-motion="reduce"] ';
  const forced = rules.find(rule => rule.media.length === 0 && rule.selectors.every(s => s.startsWith(prefix))
    && rule.declarations.some(([name]) => name === 'transition'));
  assert.ok(forced, 'forced reduced-motion rule');
  assert.deepEqual(forced.selectors.map(s => s.slice(prefix.length)), system[0].selectors);
  assert.deepEqual(forced.declarations, system[0].declarations);
  for (const selector of ['.egd-codex-typing-dots span', '.egd-browser-loading .egd-card-progress::before']) {
    const a = rules.find(rule => rule.media[0] === '(prefers-reduced-motion: reduce)' && rule.selectors.includes(selector));
    const b = rules.find(rule => rule.media.length === 0 && rule.selectors.includes(prefix + selector));
    assert.ok(a && b, selector);
    assert.deepEqual(b.declarations, a.declarations);
  }
  // A narrower rule needs its own forced twin unless it only repeats what the
  // forced rule above already sets on every EG-Desk element.
  for (const rule of rules.filter(rule => reduced(rule) && rule !== system[0])) {
    const twin = rules.find(candidate => candidate.media.length === 0 && sameSelectors(candidate.selectors, rule.selectors.map(s => prefix + s)));
    if (twin) assert.deepEqual(twin.declarations, rule.declarations);
    else for (const [name, value] of rule.declarations) {
      assert.ok(forced.declarations.some(([n, v]) => n === name && v === value), `forced twin missing for ${rule.selectors[0]} ${name}`);
    }
  }
});

// --- uc.js wiring ---

const slice = (start, end) => {
  const from = surfaceSource.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = surfaceSource.indexOf(end, from);
  assert.ok(to > from, `missing ${end}`);
  return surfaceSource.slice(from, to);
};

function fakeRoot() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: name => attrs.delete(name),
    getAttribute: name => attrs.has(name) ? attrs.get(name) : null,
  };
}

function loadDisplayRuntime(initialPref) {
  const prefs = new Map(initialPref == null ? [] : [['egdesk.displaySettings.v1', initialPref]]);
  const rootEl = fakeRoot();
  const services = { prefs: {
    prefHasUserValue: key => prefs.has(key),
    getStringPref: (key, fallback = '') => prefs.has(key) ? prefs.get(key) : fallback,
    setStringPref: (key, value) => prefs.set(key, value),
    clearUserPref: key => prefs.delete(key),
  } };
  const source = slice('  // DSN-01 화면·입력: the chosen screen mode', '  function el(tag, props = {}, ...children) {');
  const api = new Function('ChromeUtils', 'servicesRef', 'document', 'window',
    `${source}\nreturn { readDisplaySettings, applyDisplaySettings, saveDisplaySettings, prefersReducedMotion };`)(
    { importESModule: () => Display }, () => services, { documentElement: rootEl },
    { matchMedia: () => ({ matches: false }), document: { documentElement: rootEl } });
  return { api, prefs, rootEl };
}

test('the saved screen mode is applied to the window root before any EG-Desk surface is built', () => {
  const { api, prefs, rootEl } = loadDisplayRuntime(JSON.stringify({ theme: 'dark', motion: 'reduce' }));
  assert.equal(rootEl.getAttribute('data-egd-theme'), 'dark');
  assert.equal(rootEl.getAttribute('data-egd-motion'), 'reduce');
  assert.equal(api.prefersReducedMotion(), true, 'camera moves follow "항상 줄이기" as well');

  assert.deepEqual(api.saveDisplaySettings({ theme: 'light', motion: 'system' }), { theme: 'light', motion: 'system' });
  assert.equal(rootEl.getAttribute('data-egd-theme'), 'light');
  assert.equal(rootEl.getAttribute('data-egd-motion'), null);
  assert.equal(api.prefersReducedMotion(), false);
  assert.deepEqual(JSON.parse(prefs.get('egdesk.displaySettings.v1')), { theme: 'light', motion: 'system' });
  assert.deepEqual(api.readDisplaySettings(), { theme: 'light', motion: 'system' });

  api.saveDisplaySettings({ theme: 'system', motion: 'system' });
  assert.equal(prefs.has('egdesk.displaySettings.v1'), false, 'reset leaves no stored value behind');
  assert.equal(rootEl.attrs.size, 0);
});

test('a broken or missing stored value follows the system', () => {
  for (const stored of [null, '{', '{"theme":"neon"}']) {
    const { api, rootEl } = loadDisplayRuntime(stored);
    assert.deepEqual(api.readDisplaySettings(), { theme: 'system', motion: 'system' });
    assert.equal(rootEl.attrs.size, 0);
  }
});

test('Settings lists 계정 · Agent 관리 · 화면·입력 · 데이터와 초기화 and opens each by name', () => {
  const settings = slice('  function spawnSettingsCard(options = {}) {', '\n  function resolveBrowserCard(');
  const defs = /const tabDefs = \[([\s\S]*?)\n    \];/.exec(settings)?.[1] || '';
  assert.deepEqual([...defs.matchAll(/\{ id: '([a-z]+)', label: '([^']+)'/g)].map(m => [m[1], m[2]]),
    [['account', '계정'], ['agents', 'Agent 관리'], ['display', '화면·입력'], ['data', '데이터와 초기화']]);
  assert.match(settings, /let activeTab = \['agents', 'display', 'data'\]\.includes\(options\.tab\) \? options\.tab : 'account';/);
  assert.match(settings, /\(tabDefs\.find\(t => t\.id === activeTab\) \|\| tabDefs\[0\]\)\.render\(\);/, 'the first paint uses the requested tab');
  assert.match(settings, /const renderAccountTab = \(\) => \{\s*if \(activeTab !== 'account'\) return;/,
    'a late account reply cannot repaint another tab');
  assert.match(settings, /role: 'radiogroup'/);
  assert.match(settings, /role: 'radio'/);
  assert.match(settings, /DisplaySettings\.choiceForKey\(/);
  assert.match(settings, /saveDisplaySettings\(\{ \.\.\.readDisplaySettings\(\), \[key\]: id \}\)/);
  assert.match(settings, /saveDisplaySettings\(DisplaySettings\.DISPLAY_DEFAULTS\)/);
  assert.doesNotMatch(settings, /기록 삭제|모두 지우기|전체 초기화/, 'no irreversible delete button before the owner decides');
});

test('a screen-mode choice saves the merged setting, redraws, and keeps focus on the chosen radio', () => {
  const source = slice('    const displayChoiceGroup = ', '    // The one reset this window performs');
  const el = (tag, props = {}, ...children) => ({ tag, props, children: children.filter(child => child != null),
    appendChild(child) { this.children.push(child); } });
  let stored = { theme: 'system', motion: 'reduce' };
  const saved = [], focused = [];
  let redraws = 0;
  const contentArea = { querySelector: selector => ({ focus: () => focused.push(selector) }) };
  const group = new Function('el', 'DisplaySettings', 'readDisplaySettings', 'saveDisplaySettings', 'renderDisplayTab', 'contentArea',
    `${source}\nreturn displayChoiceGroup;`)(el, Display, () => stored,
    next => { saved.push(next); stored = next; }, () => { redraws++; }, contentArea);

  const section = group('theme', '화면 모드', Display.themeChoices(stored), '범위 안내');
  assert.equal(section.props['aria-label'], '화면 모드');
  const radios = section.children[1];
  assert.equal(radios.props.role, 'radiogroup');
  assert.deepEqual(radios.children.map(radio => [radio.props.role, radio.props['aria-checked'], radio.props.tabindex, radio.children[0]]),
    [['radio', 'true', '0', '시스템 따라가기'], ['radio', 'false', '-1', '밝게'], ['radio', 'false', '-1', '어둡게']]);
  assert.equal(section.children[2].children[0], '이 PC의 밝게·어둡게 설정을 따릅니다.', 'the selected choice explains itself');
  assert.equal(section.children[3].children[0], '범위 안내');

  radios.children[2].props.onclick();
  assert.deepEqual(saved.at(-1), { theme: 'dark', motion: 'reduce' }, 'the other setting is kept');
  assert.equal(redraws, 1);
  assert.equal(focused.at(-1), '[data-testid="settings-display-theme-dark"]');

  const key = (radio, name) => {
    const ev = { key: name, prevented: 0, preventDefault() { this.prevented++; }, stopPropagation() {} };
    radio.props.onkeydown(ev);
    return ev.prevented;
  };
  assert.equal(key(radios.children[0], 'ArrowRight'), 1);
  assert.deepEqual(saved.at(-1), { theme: 'light', motion: 'reduce' });
  assert.equal(focused.at(-1), '[data-testid="settings-display-theme-light"]');
  const before = saved.length;
  assert.equal(key(radios.children[0], 'Tab'), 0, 'Tab leaves the group as usual');
  assert.equal(key(radios.children[0], 'Escape'), 0, 'Esc still reaches the window');
  assert.equal(saved.length, before);
});
