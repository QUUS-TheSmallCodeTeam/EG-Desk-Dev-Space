import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTRAST_RATIOS, CONTRAST_REQUIREMENTS, MORE_CONTRAST_REQUIREMENTS, STATE_TOKEN_TABLE, SYSTEM_COLOR_KEYWORDS,
  auditCssScale, checkSurfaceContrast, compositeOver, contrastRatio, formatHex, hasRootOverrides, mediaApplies,
  mixSrgb, parseColor, readAvatarTones, readCssRules, readRootProperties, readSchemeColors, resolveColor,
  runContrastChecks,
} from '../overlay/resources/EGDeskDesignTokens.sys.mjs';

// The surface stylesheet is read, never written: it is the source of truth
// (D-G5 (가)) and this file holds it to the contrast table.
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const describeRows = rows => rows.map(r => `${r.scheme} ${r.pair}: ${r.ratio ?? r.reason} < ${r.minimum}`).join('\n');

// ------------------------------------------------------------------ colours

test('parseColor reads hex, rgb()/rgba() and transparent; formatHex writes it back', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#49634F'), { r: 73, g: 99, b: 79, a: 1 });
  assert.equal(parseColor('#00000080').a, 128 / 255);
  assert.deepEqual(parseColor('rgba(245, 243, 239, .68)'), { r: 245, g: 243, b: 239, a: 0.68 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColor('Canvas'), null);
  assert.equal(parseColor('currentColor'), null);
  assert.equal(formatHex(parseColor('#a9c5a9')), '#A9C5A9');
});

test('mixSrgb follows CSS color-mix percentages and premultiplied alpha', () => {
  const white = parseColor('#ffffff');
  const black = parseColor('#000000');
  assert.equal(formatHex(mixSrgb(white, 50, black, null)), '#808080');
  assert.equal(formatHex(mixSrgb(white, null, black, 25)), '#BFBFBF');
  const tinted = mixSrgb(parseColor('#49634F'), 8, parseColor('transparent'), null);
  assert.equal(formatHex({ ...tinted, a: 1 }), '#49634F', 'transparent does not darken the hue');
  assert.ok(Math.abs(tinted.a - 0.08) < 1e-9);
  assert.ok(Math.abs(mixSrgb(white, 30, black, 30).a - 0.6) < 1e-9, 'a sum under 100% scales alpha');
});

test('contrastRatio is the WCAG ratio floored to two decimals, translucent colours composited first', () => {
  assert.equal(contrastRatio(parseColor('#000'), parseColor('#fff')), 21);
  assert.equal(contrastRatio(parseColor('#777777'), parseColor('#ffffff')), 4.47);
  assert.equal(contrastRatio(parseColor('#fff'), parseColor('#777777')), 4.47, 'order does not matter');
  const veil = parseColor('rgba(0, 0, 0, .5)');
  assert.equal(contrastRatio(parseColor('#fff'), veil, parseColor('#fff')), contrastRatio(parseColor('#fff'), compositeOver(veil, parseColor('#fff'))));
});

// ---------------------------------------------------------------- CSS read

const sampleCss = `
@namespace url("http://www.w3.org/1999/xhtml");
/* :root { --ignored: #f00; } */
:root, .card { --bg: #ffffff; --ink: var(--ink-base); --ink-base: #222222; --tint: color-mix(in srgb, var(--ink) 10%, transparent); }
.quote::before { content: "{"; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111111; --ink-base: #eeeeee; }
  .x { color: red; }
}
@media (prefers-contrast: more) { :root { --ink-base: #000000; } }
@media (forced-colors: active) { :root { --ink: CanvasText; } }
@media (max-width: 600px) { :root { --bg: #abcdef; } }
.egd-profile-avatar-tone-0 { background: var(--ink); color: var(--bg); }
.wrap .egd-profile-avatar-tone-0 { background: #f00; }
`;

test('readCssRules skips comments and quoted braces and keeps the wrapping media', () => {
  const rules = readCssRules(sampleCss);
  const roots = rules.filter(rule => rule.selectors.includes(':root'));
  assert.equal(roots.length, 5);
  assert.deepEqual(roots[0].selectors, [':root', '.card']);
  assert.deepEqual(roots[1].media, ['(prefers-color-scheme: dark)']);
  assert.ok(rules.some(rule => rule.selectors[0] === '.quote::before'));
  assert.ok(!Object.keys(readRootProperties(sampleCss)).includes('--ignored'));
});

test('mediaApplies matches scheme, contrast and forced colours; other features never feed tokens', () => {
  assert.equal(mediaApplies([], {}), true);
  assert.equal(mediaApplies(['(prefers-color-scheme: dark)'], { scheme: 'dark' }), true);
  assert.equal(mediaApplies(['(prefers-color-scheme: dark)'], {}), false);
  assert.equal(mediaApplies(['(prefers-contrast: more)'], { contrast: 'more' }), true);
  assert.equal(mediaApplies(['(prefers-contrast)'], { forcedColors: true }), true);
  assert.equal(mediaApplies(['(forced-colors: active)'], { forcedColors: true }), true);
  assert.equal(mediaApplies(['(prefers-color-scheme: dark) and (prefers-contrast: more)'], { scheme: 'dark', contrast: 'more' }), true);
  assert.equal(mediaApplies(['(prefers-color-scheme: dark) and (prefers-contrast: more)'], { scheme: 'dark' }), false);
  assert.equal(mediaApplies(['(max-width: 600px)'], {}), false);
  assert.equal(mediaApplies(['not (prefers-color-scheme: dark)'], {}), false);
});

test('readRootProperties cascades by environment; resolveColor follows var() and color-mix()', () => {
  const light = readRootProperties(sampleCss);
  const dark = readRootProperties(sampleCss, { scheme: 'dark' });
  const darkMore = readRootProperties(sampleCss, { scheme: 'dark', contrast: 'more' });
  assert.equal(light['--bg'], '#ffffff');
  assert.equal(dark['--bg'], '#111111');
  assert.equal(formatHex(resolveColor('var(--ink)', light)), '#222222');
  assert.equal(formatHex(resolveColor('var(--ink)', dark)), '#EEEEEE');
  assert.equal(formatHex(resolveColor('var(--ink)', darkMore)), '#000000');
  const tint = resolveColor('var(--tint)', dark);
  assert.equal(formatHex({ ...tint, a: 1 }), '#EEEEEE', 'color-mix re-resolves with the dark ink');
  assert.equal(resolveColor('var(--ink)', readRootProperties(sampleCss, { forcedColors: true })), null, 'system colours are not fixed');
  assert.equal(formatHex(resolveColor('var(--missing, #123456)', light)), '#123456');
  assert.equal(resolveColor('var(--a)', { '--a': 'var(--b)', '--b': 'var(--a)' }), null, 'cycles resolve to null');
  assert.equal(hasRootOverrides(sampleCss, { scheme: 'light', contrast: 'more' }), true);
  assert.equal(hasRootOverrides('/* none */ :root { --a: #fff; }', { scheme: 'light', contrast: 'more' }), false);
});

test('readAvatarTones takes only the plain .egd-profile-avatar-tone-N rules', () => {
  assert.deepEqual(readAvatarTones(sampleCss), [{ tone: 0, background: 'var(--ink)', color: 'var(--bg)' }]);
  const colors = readSchemeColors(sampleCss, { scheme: 'dark' });
  assert.equal(formatHex(colors['avatar.tone-0.background']), '#EEEEEE');
  assert.equal(formatHex(colors['avatar.tone-0.color']), '#111111');
});

test('runContrastChecks uses Primer rows: minimum by type, translucent bg on each canvas, todo and optional', () => {
  const colors = readSchemeColors(sampleCss);
  const rows = runContrastChecks(colors, [
    ['text', '--ink', '--bg'],
    ['border', '--ink', '--tint', { bg: ['--bg'] }],
    [9, '--ink', '--bg', { todo: 'later' }],
    ['text', '--nope', '--bg', { optional: true }],
    ['text', '--ink', '--nope'],
  ], { label: 'light' });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => r.minimum), [CONTRAST_RATIOS.default.text, CONTRAST_RATIOS.default.border, 9, 4.5]);
  assert.equal(rows[0].pass, true);
  assert.equal(rows[1].pair, '--ink vs --tint on --bg');
  assert.equal(rows[2].todo, 'later');
  assert.equal(rows[3].reason, 'unresolved --nope');
  assert.equal(rows[3].pass, false);
  assert.equal(runContrastChecks(colors, [['text', '--ink', '--bg']], { level: 'more' })[0].minimum, 7);
});

// ------------------------------------------------------- surface stylesheet

const surfaceRows = checkSurfaceContrast(surfaceCss);

test('DSN-04 every token the contrast table names resolves in light and dark', () => {
  const unresolved = surfaceRows.filter(row => row.ratio == null);
  assert.deepEqual(unresolved, [], describeRows(unresolved));
  assert.equal(readAvatarTones(surfaceCss).length, 6);
});

test('DSN-04 surface text, accent, state inks and focus outline meet 4.5:1 / 3:1 in light and dark', () => {
  const failing = surfaceRows.filter(row => !row.todo && !row.pass);
  assert.deepEqual(failing, [], describeRows(failing));
  assert.ok(surfaceRows.filter(row => !row.todo).length >= 2 * CONTRAST_REQUIREMENTS.filter(row => !row[3]?.todo).length);
});

for (const todo of [...new Set(CONTRAST_REQUIREMENTS.map(row => row[3]?.todo).filter(Boolean))]) {
  test(`DSN-04 known shortfall: ${todo}`, { todo }, () => {
    const rows = surfaceRows.filter(row => row.todo === todo);
    assert.ok(rows.length > 0);
    const failing = rows.filter(row => !row.pass);
    assert.deepEqual(failing, [], describeRows(failing));
  });
}

test('DSN-04 the S5 state-token table passes the more-contrast rows on today\'s light and dark tokens', () => {
  const extra = { ...STATE_TOKEN_TABLE.base, ...STATE_TOKEN_TABLE.prefersContrast };
  const rows = checkSurfaceContrast(surfaceCss, MORE_CONTRAST_REQUIREMENTS, { contrast: 'more', level: 'more', extra });
  assert.equal(rows.filter(row => row.pair.startsWith('--egd-focus-outline-color')).length, 4);
  const failing = rows.filter(row => !row.pass);
  assert.deepEqual(failing, [], describeRows(failing));
  const base = checkSurfaceContrast(surfaceCss, [['border', '--egd-focus-outline-color', '--egd-surface'],
    ['border', '--egd-focus-outline-color', '--egd-surface-elevated']], { extra: STATE_TOKEN_TABLE.base });
  assert.deepEqual(base.filter(row => !row.pass), [], describeRows(base.filter(row => !row.pass)));
});

test('DSN-04 the forced-colours table uses only system colours or plain numbers', () => {
  for (const [name, value] of Object.entries(STATE_TOKEN_TABLE.forcedColors)) {
    assert.ok(SYSTEM_COLOR_KEYWORDS.includes(value) || /^\d+(\.\d+)?$/.test(value), `${name}: ${value}`);
  }
  for (const name of Object.keys(STATE_TOKEN_TABLE.prefersContrast)) assert.match(name, /^--egd-/);
});

const hasMoreContrast = hasRootOverrides(surfaceCss, { scheme: 'light', contrast: 'more' })
  || hasRootOverrides(surfaceCss, { scheme: 'dark', contrast: 'more' });
test('DSN-04 the surface prefers-contrast block meets 7:1 text / 4.5:1 borders',
  hasMoreContrast ? {} : { todo: 'S5가 prefers-contrast :root 블록을 넣기 전까지' }, () => {
    assert.ok(hasMoreContrast, 'no prefers-contrast :root block in eg-desk-surface.uc.css yet');
    const rows = checkSurfaceContrast(surfaceCss, MORE_CONTRAST_REQUIREMENTS, { contrast: 'more', level: 'more' });
    const failing = rows.filter(row => !row.pass);
    assert.deepEqual(failing, [], describeRows(failing));
  });

// ------------------------------------------------------------- scale audit

test('auditCssScale counts focus offsets, disabled opacity, literal font sizes and radii', () => {
  const audit = auditCssScale(`
    .a:focus-visible { outline: 2px solid red; outline-offset: 2px; }
    .b:focus-visible, .c:focus-visible { outline-offset: -2px; }
    .a:disabled { opacity: .5; } .b[disabled] { opacity: 0.50; } .c[aria-disabled="true"] { opacity: .6; }
    .t { font-size: 12px; border-radius: 8px; } .u { font-size: var(--x); border-radius: 8px; }
    @media (prefers-color-scheme: dark) { .d:focus-visible { outline-offset: 2px; } }`);
  assert.equal(audit.focusVisibleRules, 3);
  assert.deepEqual({ ...audit.focusOutlineOffsets }, { '2px': 2, '-2px': 1 });
  assert.deepEqual({ ...audit.disabledOpacities }, { '0.5': 2, '0.6': 1 });
  assert.deepEqual({ ...audit.fontSizes }, { '12px': 1 });
  assert.deepEqual({ ...audit.borderRadii }, { '8px': 2 });
});

test('DSN-03 S5 target: one focus offset and one disabled opacity across the surface', { todo: 'S5 포커스·비활성 토큰 통일' }, () => {
  const audit = auditCssScale(surfaceCss);
  assert.ok(audit.focusVisibleRules > 0);
  assert.ok(Object.keys(audit.focusOutlineOffsets).length <= 1, JSON.stringify(audit.focusOutlineOffsets));
  assert.ok(Object.keys(audit.disabledOpacities).length <= 1, JSON.stringify(audit.disabledOpacities));
});
