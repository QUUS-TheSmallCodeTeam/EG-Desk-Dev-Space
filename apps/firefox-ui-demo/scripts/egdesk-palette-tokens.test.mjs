import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import {
  compositeOver, contrastRatio, formatHex, mediaApplies, readCssRules, readRootProperties, resolveColor,
} from '../overlay/resources/EGDeskDesignTokens.sys.mjs';

// DSN-02 / DSN-03: colours, shadows and small text outside the approved
// palette. The stylesheet is read, never written.
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rules = readCssRules(surfaceCss);
const declarationsFor = (selector, env = { scheme: 'light' }) => Object.fromEntries(rules
  .filter(rule => rule.selectors.includes(selector) && mediaApplies(rule.media, env))
  .flatMap(rule => rule.declarations));
const schemes = ['light', 'dark'];

test('a Chat room keeps one of the six approved avatar tones, chosen from its id', () => {
  const tones = ChatState.PROFILE_AVATAR_PALETTE.length;
  assert.equal(tones, 6);
  const ids = Array.from({ length: 60 }, (_, index) => `thread-${index}-${(index * 7919).toString(36)}`);
  for (const id of ids) {
    const tone = ChatState.roomAvatarTone(id);
    assert.ok(Number.isInteger(tone) && tone >= 0 && tone < tones, `${id}: ${tone}`);
    assert.equal(ChatState.roomAvatarTone(id), tone, 'the same room keeps its tone');
  }
  assert.equal(new Set(ids.map(ChatState.roomAvatarTone)).size, tones, 'rooms spread over every tone');
  for (const bad of [undefined, null, '', 42, {}]) assert.equal(ChatState.roomAvatarTone(bad), 0);
});

test('the room list draws its avatar with the shared tone classes, not inline colours', () => {
  // Booleans keep a failure from printing the whole surface script.
  assert.equal(/\bavatarColors\b/.test(surfaceSource), false, 'the inline swatch list is gone');
  assert.equal(/#2D5A7B|#7B2D5A|#5A2D7B|#3D6B8B|#8B3D6B/i.test(surfaceSource), false, 'the legacy blue and purple swatches are gone');
  assert.equal(surfaceSource.includes(
    "el('div', { class: `egd-codex-thread-avatar egd-profile-avatar-tone-${ChatState.roomAvatarTone(thread.id)}` }, avatarInitial)"), true,
  'the room row asks ChatState for its tone');
  for (const scheme of schemes) {
    const avatar = declarationsFor('.egd-codex-thread-avatar', { scheme });
    assert.equal(avatar.color, 'var(--egd-avatar-ink)');
    assert.equal(avatar.background, undefined, 'the tone class owns the paint');
  }
  // A later single-class rule would repaint the tone; only size and shape may follow.
  const later = rules.filter(rule => rule.selectors.some(selector => /\.egd-codex-thread-avatar\b/.test(selector)))
    .flatMap(rule => rule.declarations.map(([name]) => name));
  assert.deepEqual(later.filter(name => /^background/.test(name)), []);
});

const FLOATING_SHADOWS = {
  '.egd-browser-menu': 'var(--egd-shadow)',
  '.egd-codex-thread-menu': 'var(--egd-shadow)',
  '.egd-codex-thread-member-menu': 'var(--egd-shadow)',
  '#egd-rail-search-results': 'var(--egd-shadow)',
  '.egd-agenda-close-panel': 'var(--egd-shadow)',
  '#egd-codex-input-panel': 'var(--egd-shadow)',
  '#egd-answer-briefing': 'var(--egd-shadow)',
  '.egd-canvas-card.egd-card-fullscreen': 'var(--egd-card-shadow)',
  '.egd-browser-card.egd-entity-selected:not(.egd-entity-active)': 'var(--egd-card-shadow)',
  '#egd-hud[data-app="chat"]': 'var(--egd-card-shadow)',
  '#egd-canvas-layer > .egd-semantic-cluster': 'var(--egd-chrome-shadow)',
  '.egd-settings-segment-active:hover': 'var(--egd-chrome-shadow)',
  '.egd-resource-gadget': 'var(--egd-chrome-shadow)',
};

test('menus and floating panels take their shadow from the three shadow tokens', () => {
  for (const [selector, shadow] of Object.entries(FLOATING_SHADOWS)) {
    assert.equal(declarationsFor(selector)['box-shadow'], shadow, selector);
  }
  // Each token has a black dark half, so the same panels stay lifted in dark.
  const dark = readRootProperties(surfaceCss, { scheme: 'dark' });
  for (const token of ['--egd-shadow', '--egd-chrome-shadow', '--egd-card-shadow', '--egd-card-shadow-active']) {
    assert.match(dark[token], /rgba\(0, 0, 0, \.\d+\)$/, token);
  }
});

test('no tinted shadow literal remains outside the tokens, the Terminal and the Ontology lens', () => {
  const tinted = [];
  for (const rule of rules) {
    const selectors = rule.selectors.join(', ');
    if (/^:root\b/.test(selectors) || /ontology|terminal/.test(selectors)) continue;
    for (const [name, value] of rule.declarations) {
      if (name !== 'box-shadow') continue;
      for (const [literal] of value.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)) {
        const { r, g, b } = resolveColor(literal, {});
        if (r || g || b) tinted.push(`${selectors}: ${literal}`);
      }
    }
  }
  assert.deepEqual(tinted, []);
});

const RESULT_KINDS = {
  card: 'var(--egd-success-ink)',
  file: 'var(--egd-primary)',
  history: 'var(--egd-secondary)',
  thread: 'var(--egd-warning-ink)',
  web: 'color-mix(in srgb, var(--egd-wood-line) 60%, var(--egd-on-surface))',
};

test('search result kinds keep five separate hues, all mixed from approved tokens', () => {
  for (const scheme of schemes) {
    const properties = readRootProperties(surfaceCss, { scheme });
    const inks = [];
    for (const [kind, ink] of Object.entries(RESULT_KINDS)) {
      const selector = `.egd-rail-search-type-${kind}`;
      const badge = declarationsFor(selector, { scheme });
      assert.equal(badge['--egd-type-ink'], ink, selector);
      assert.equal(badge.color, 'var(--egd-type-ink)', selector);
      assert.equal(badge.background, 'color-mix(in srgb, var(--egd-type-ink) 10%, var(--egd-surface-elevated))', selector);
      const local = { ...properties, '--egd-type-ink': ink };
      const paper = resolveColor('var(--egd-surface-elevated)', local);
      const background = compositeOver(resolveColor(badge.background, local), paper);
      const text = compositeOver(resolveColor(badge.color, local), background);
      assert.ok(contrastRatio(text, background) >= 4.5, `${scheme} ${kind}: ${contrastRatio(text, background)}`);
      inks.push(formatHex(text));
    }
    assert.equal(new Set(inks).size, 5, `${scheme}: ${inks.join(' ')}`);
  }
  const block = surfaceCss.slice(surfaceCss.indexOf('.egd-rail-search-type-agenda {'), surfaceCss.indexOf('.egd-rail-search-main {'));
  assert.ok(block.length > 300);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'no literal colour in the result kinds');
});

test('the minimap marks drawn shapes with the warning token in both schemes', () => {
  const shape = declarationsFor('.egd-minimap-entity-shape');
  assert.equal(shape.border, '1px solid color-mix(in srgb, var(--egd-warning-ink) 64%, transparent)');
  assert.equal(shape.background, 'color-mix(in srgb, var(--egd-warning-ink) 22%, transparent)');
});

test('a Board region shows only its name tag until it is the current Board', () => {
  const region = declarationsFor('.egd-board-region');
  assert.equal(region.border, 'calc(1px * var(--egd-board-label-scale, 1)) solid transparent');
  assert.equal(region.background, 'transparent');
  const active = declarationsFor('.egd-board-region[data-active="true"]');
  assert.equal(active['border-color'], 'var(--egd-primary)');
  assert.equal(active['border-width'], 'calc(2px * var(--egd-board-label-scale, 1))');
  assert.equal(active.background, 'var(--egd-region-fill)');
  // Pointing at, or tabbing to, a name tag shows that Board's extent with the approved faint line.
  const reveal = rules.find(rule => rule.selectors.some(selector => selector.startsWith('.egd-board-region:has(')));
  assert.ok(reveal, 'reveal rule');
  assert.match(reveal.selectors.join(', '), /\.egd-board-region-head:hover/);
  assert.match(reveal.selectors.join(', '), /\.egd-board-region-head:focus-within/);
  assert.deepEqual(reveal.declarations, [['border-color', 'var(--egd-region-line)']]);
  assert.ok(rules.indexOf(reveal) < rules.findIndex(rule => rule.selectors.includes('.egd-board-region[data-active="true"]')),
    'the current Board edge wins over the reveal');
  // Approved .eg-region-label: 11px, 4px from the borderless edge, 13px inside a drawn edge.
  assert.match(declarationsFor('.egd-board-region-title').font, /^600 var\(--egd-text-sm\)\/1\.3 /);
  assert.equal(declarationsFor('.egd-board-region-head').padding, '0 6px 0 4px');
  assert.equal(declarationsFor('.egd-board-region[data-active="true"] .egd-board-region-head')['padding-left'], '13px');
});

const TEXT_STEPS = { '--egd-text-2xs': '10px', '--egd-text-xs': '10.5px', '--egd-text-sm': '11px',
  '--egd-text-md': '11.5px', '--egd-text-base': '12px', '--egd-text-lg': '13px' };
const RADIUS_STEPS = { '--egd-radius-xs': '5px', '--egd-radius-sm': '7px', '--egd-radius-md': '8px',
  '--egd-radius-lg': '10px', '--egd-radius-xl': '14px' };

test('D-G1 text and corner steps are tokens, the same in both schemes', () => {
  for (const scheme of schemes) {
    const properties = readRootProperties(surfaceCss, { scheme });
    for (const [name, value] of Object.entries({ ...TEXT_STEPS, ...RADIUS_STEPS })) assert.equal(properties[name], value, `${scheme} ${name}`);
  }
});

test('badges are at least 10px and labels 11px; only initials inside 14-18px faces stay smaller', () => {
  const small = [];
  for (const rule of rules) {
    const selectors = rule.selectors.join(', ');
    if (/ontology|terminal/.test(selectors)) continue;
    for (const [name, value] of rule.declarations) {
      const size = name === 'font-size' ? value.match(/^([\d.]+)px$/)?.[1]
        : name === 'font' ? value.match(/(?:^|\s)([\d.]+)px(?:\/|\s)/)?.[1] : null;
      if (size != null && Number(size) < 10) small.push(`${selectors} ${size}px`);
    }
  }
  assert.deepEqual(small, [
    '.egd-card-security 8px',
    '.egd-browser-card .egd-browser-agent-face 8px',
    '.egd-codex-thread-menu-avatar 9px',
  ]);
  const size = selector => declarationsFor(selector)['font-size'];
  for (const badge of ['.egd-rail-search-current', '.egd-codex-thread-session-pill', '.egd-codex-thread-unread']) {
    assert.equal(size(badge), 'var(--egd-text-2xs)', badge);
  }
  for (const label of ['.egd-codex-thread-menu-label', '.egd-codex-bubble-read']) {
    assert.equal(size(label), 'var(--egd-text-sm)', label);
  }
  // The Board Thread member chips read their role at the 11px label size.
  assert.equal(size('.egd-codex-thread-member-role'), '11px');
  // These already had a later, larger refinement; it still wins.
  assert.equal(size('.egd-codex-system-chip'), '10px');
  assert.equal(size('.egd-codex-log'), '11px');
  assert.equal(size('.egd-codex-diagnostics-toggle'), '12px');
  assert.match(declarationsFor('.egd-minimap-board-label').font, /^600 var\(--egd-text-2xs\)\/13px /);
  assert.match(declarationsFor('.egd-minimap-briefing-number').font, /^700 var\(--egd-text-2xs\)\/11px /);
  // Fixed heights still hold one line of the larger text.
  for (const [selector, property, minimum] of [['.egd-rail-search-current', 'height', 20], ['.egd-codex-thread-session-pill', 'min-height', 21],
    ['.egd-codex-thread-unread', 'min-height', 18], ['.egd-codex-system-chip', 'min-height', 19], ['.egd-codex-thread-member-role', 'min-height', 15],
    ['.egd-minimap-board-label', 'height', 13], ['.egd-minimap-briefing-number', 'height', 13]]) {
    assert.ok(parseFloat(declarationsFor(selector)[property]) >= minimum, `${selector} ${property}`);
  }
});

test('the Ontology map draws its physical layer in sage; the virtual layer keeps its own purple', () => {
  const ontologySource = readFileSync(new URL('../overlay/resources/surface/EGDeskSurfaceOntology.mjs', import.meta.url), 'utf8');
  for (const [name, source] of [['stylesheet', surfaceCss], ['Ontology module', ontologySource]]) {
    for (const legacy of ['#2D5A7B', '#244F6C', 'rgba(45, 90, 123', 'rgba(35, 76, 106', '#252c33']) {
      assert.equal(source.toLowerCase().includes(legacy.toLowerCase()), false, `${name}: ${legacy}`);
    }
  }
  assert.equal(declarationsFor('.egd-ontology-minimap-legend-swatch-physical').background, 'var(--egd-primary)');
  assert.equal(declarationsFor('.egd-ontology-v2-pip-physical').fill, 'color-mix(in srgb, var(--egd-primary-strong) 84%, transparent)');
  assert.equal(declarationsFor('.egd-ontology-error').color, 'var(--egd-danger-ink)');
  assert.equal(declarationsFor('.egd-ontology-card').background, 'var(--egd-surface)');
  // SVG attributes carry the same sage as literals: --egd-primary and --egd-primary-strong of the light set.
  const light = readRootProperties(surfaceCss, { scheme: 'light' });
  assert.equal(formatHex(resolveColor('var(--egd-primary)', light)), '#49634F');
  assert.equal(formatHex(resolveColor('var(--egd-primary-strong)', light)), '#3F5344');
  assert.ok(ontologySource.includes("'#7E57C2' : '#49634F'") && ontologySource.includes("'#6F469F' : '#3F5344'"));
  assert.ok(ontologySource.includes('rgba(73, 99, 79, ') && ontologySource.includes('rgba(63, 83, 68, '));
  // The lens keeps the light palette in both schemes, so its sage does not change in dark.
  assert.ok(rules.some(rule => rule.selectors.includes('.egd-ontology-card') && rule.media.length === 0
    && rule.declarations.some(([name]) => name === '--egd-primary-strong')));
});

test('room list avatars keep dark initials readable on every tone, in both schemes', () => {
  for (const scheme of schemes) {
    const properties = readRootProperties(surfaceCss, { scheme });
    for (let tone = 0; tone < ChatState.PROFILE_AVATAR_PALETTE.length; tone += 1) {
      const face = declarationsFor(`.egd-profile-avatar-tone-${tone}`, { scheme });
      assert.equal(face.color, 'var(--egd-avatar-ink)', `tone ${tone}`);
      const ratio = contrastRatio(resolveColor(face.color, properties), resolveColor(face.background, properties));
      assert.ok(ratio >= 4.5, `${scheme} tone ${tone}: ${ratio}`);
    }
  }
});

test('the Ontology minimap legend and position text are at least the 10px badge step', () => {
  for (const selector of ['.egd-ontology-minimap-legend-item', '.egd-ontology-minimap-context-coordinate']) {
    assert.equal(declarationsFor(selector)['font-size'], 'var(--egd-text-2xs)', selector);
  }
  // Four legend entries (6px mark, 2px gap, two Hangul letters) still fit the 168px minimap.
  const minimapWidth = parseFloat(declarationsFor('.egd-ontology-minimap').width);
  const legend = declarationsFor('.egd-ontology-minimap-legend');
  const [, sidePadding] = legend.padding.split(' ').map(parseFloat);
  const column = (minimapWidth - 2 - 2 * sidePadding - 3 * parseFloat(legend.gap)) / 4;
  assert.ok(column >= 6 + 2 + 2 * 10, `legend column ${column}px`);
  assert.ok(parseFloat(legend['min-height']) - 12 >= 13, 'one 10px line fits the legend strip');
});

test('no rule repeats an earlier rule with the same selector and the same declarations', () => {
  const seen = new Set();
  const repeated = [];
  for (const rule of rules) {
    const key = JSON.stringify([rule.media, rule.selectors, rule.declarations]);
    if (seen.has(key)) repeated.push(rule.selectors.join(', '));
    seen.add(key);
  }
  assert.deepEqual(repeated, []);
});

test('notices, the recovery bar and the close guard take their shadow and scrim from tokens', () => {
  assert.equal(declarationsFor('#egd-board-notice')['box-shadow'], 'var(--egd-shadow)');
  assert.equal(declarationsFor('#egd-desk-recovery')['box-shadow'], 'var(--egd-shadow)');
  for (const scheme of schemes) {
    assert.equal(declarationsFor('.egd-agenda-close-guard', { scheme })['background'], 'var(--egd-scrim)');
    assert.ok(readRootProperties(surfaceCss, { scheme })['--egd-scrim'], `${scheme} scrim token`);
  }
});

// DSN-03: the pairs recorded in docs/EGDESK_DESIGN_CONTRAST.md stay at 4.5:1 or more.
const TEXT_PAIRS = [
  ['--egd-on-surface', '--egd-surface'], ['--egd-on-surface', '--egd-surface-elevated'],
  ['--egd-on-surface', '--egd-window-alt'], ['--egd-on-surface', '--egd-topbar'],
  ['--egd-on-surface', '--egd-user-bubble'], ['--egd-on-surface', '--egd-note'],
  ['--egd-on-surface-variant', '--egd-surface'], ['--egd-on-surface-variant', '--egd-surface-elevated'],
  ['--egd-on-surface-variant', '--egd-window-alt'], ['--egd-primary', '--egd-surface-elevated'],
  ['--egd-primary', '--egd-primary-container'], ['--egd-on-primary', '--egd-primary'],
  ['--egd-danger-ink', '--egd-danger-bg'], ['--egd-success-ink', '--egd-success-bg'],
  ['--egd-warning-ink', '--egd-surface-elevated'],
];

test('main text and background token pairs keep 4.5:1 in both schemes, as the contrast doc records', () => {
  const doc = readFileSync(new URL('../docs/EGDESK_DESIGN_CONTRAST.md', import.meta.url), 'utf8');
  for (const scheme of schemes) {
    const props = readRootProperties(surfaceCss, { scheme });
    for (const [ink, paper] of TEXT_PAIRS) {
      const bg = resolveColor(props[paper], props);
      const fg = compositeOver(resolveColor(props[ink], props), bg);
      const ratio = contrastRatio(fg, bg);
      assert.ok(ratio >= 4.5, `${scheme} ${ink} on ${paper}: ${ratio.toFixed(2)}`);
      assert.ok(doc.includes(`${formatHex(fg)} / ${formatHex(bg)} | ${ratio.toFixed(2)}`), `${scheme} ${ink} on ${paper} is recorded`);
    }
  }
});

test('step-off text sizes are snapped to the approved scale', () => {
  const offStep = [];
  for (const rule of rules) {
    if (rule.selectors.some(selector => /egd-host-activity/.test(selector))) continue; // newest package, left as is
    for (const [name, value] of rule.declarations) {
      if ((name === 'font-size' || name === 'font') && /(^|\s)(12\.5|13\.5|14\.5|19)px/.test(value)) offStep.push(`${rule.selectors.join(', ')} ${name}: ${value}`);
    }
  }
  assert.deepEqual(offStep, []);
});
