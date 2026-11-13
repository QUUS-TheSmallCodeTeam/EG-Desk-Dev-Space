import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import * as SurfaceState from '../overlay/resources/EGDeskSurfaceState.sys.mjs';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs';
import {
  CONTRAST_RATIOS, CONTRAST_REQUIREMENTS, MORE_CONTRAST_REQUIREMENTS, STATE_TOKEN_TABLE, SYSTEM_COLOR_KEYWORDS,
  auditCssScale, checkSurfaceContrast, compositeOver, contrastRatio, formatHex, hasRootOverrides, mediaApplies,
  mixSrgb, parseColor, readAvatarTones, readCssRules, readRootProperties, readSchemeColors, resolveColor,
  runContrastChecks,
} from '../overlay/resources/EGDeskDesignTokens.sys.mjs';

// The surface stylesheet is read, never written: it is the source of truth
// (D-G5 (가)) and this file holds it to the contrast table.
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const surfaceScript = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const surfaceRules = readCssRules(surfaceCss);

const describeRows = rows => rows.map(r => `${r.scheme} ${r.pair}: ${r.ratio ?? r.reason} < ${r.minimum}`).join('\n');

const environments = ['light', 'dark'].flatMap(scheme => [
  { scheme }, { scheme, contrast: 'more' }, { scheme, forcedColors: true },
  { scheme, contrast: 'more', forcedColors: true },
]);
const environmentName = env => [env.scheme, env.contrast, env.forcedColors && 'forced'].filter(Boolean).join('+');
const rulesFor = (selector, env) => surfaceRules.filter(rule => rule.selectors.includes(selector)
  && (env == null || mediaApplies(rule.media, env)));
const declarationsFor = (selector, env) => Object.fromEntries(rulesFor(selector, env).flatMap(rule => rule.declarations));

// A narrow test-side substitution for non-colour state tokens. Missing or
// cyclic variables fail here instead of turning Number(var(...)) into NaN.
// This is not a replacement for the production colour/CSS parsers.
function resolveStateValue(value, properties, seen = new Set()) {
  assert.equal(typeof value, 'string', 'a state declaration must exist');
  const resolved = value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name) => {
    assert.ok(!seen.has(name), `cyclic state token ${name}`);
    assert.ok(Object.hasOwn(properties, name), `missing state token ${name}`);
    return resolveStateValue(properties[name], properties, new Set([...seen, name]));
  });
  assert.doesNotMatch(resolved, /var\(/, `unsupported or unresolved state value: ${resolved}`);
  return resolved;
}

const isDisabledSelector = selector => /:disabled\b|\[disabled(?:\s*=[^\]]+)?\]|\[aria-disabled\s*=\s*["']?true["']?\s*\]|\.egd-desk-window-control-disabled\b/i
  .test(selector.replace(/:not\([^)]*\)/g, ''));
const disabledOpacityRules = surfaceRules.filter(rule => rule.selectors.some(isDisabledSelector)
  && rule.declarations.some(([name]) => name === 'opacity'));

function resolvedDisabledOpacities(env) {
  const root = readRootProperties(surfaceCss, env);
  return disabledOpacityRules.filter(rule => mediaApplies(rule.media, env)).flatMap(rule => {
    const properties = { ...root, ...Object.fromEntries(rule.declarations.filter(([name]) => name.startsWith('--'))) };
    return rule.declarations.filter(([name]) => name === 'opacity').map(([, value]) => {
      const resolved = resolveStateValue(value, properties);
      assert.match(resolved, /^(?:0?(?:\.\d+)|\d+(?:\.\d+)?)$/, `${environmentName(env)} invalid opacity ${resolved}`);
      const opacity = Number(resolved);
      assert.ok(Number.isFinite(opacity) && opacity > 0 && opacity <= 1,
        `${environmentName(env)} ${rule.selectors.join(', ')}: opacity must be visible, got ${resolved}`);
      return opacity;
    });
  });
}

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
  const failing = surfaceRows.filter(row => !row.pass);
  assert.deepEqual(failing, [], describeRows(failing));
  assert.ok(surfaceRows.length >= 2 * CONTRAST_REQUIREMENTS.length);
});

// Keep the two formerly failing groups as permanent, unmasked regressions.
const contrastRegressions = new Map([
  ['avatar contrast (D-G2)', ['avatar.tone-2.color', 'avatar.tone-3.color']],
  ['focus-border contrast (S5)', ['--egd-focus-border']],
]);
for (const [name, foregrounds] of contrastRegressions) {
  test(`DSN-04 regression: ${name}`, () => {
    const rows = surfaceRows.filter(row => foregrounds.some(foreground => row.pair.startsWith(`${foreground} vs `)));
    assert.ok(rows.length >= 2 * foregrounds.length);
    const failing = rows.filter(row => !row.pass);
    assert.deepEqual(failing, [], describeRows(failing));
  });
}

test('DSN-04 the S5 state-token table passes the more-contrast rows on today\'s light and dark tokens', () => {
  const extra = { ...STATE_TOKEN_TABLE.base, ...STATE_TOKEN_TABLE.prefersContrast };
  const rows = checkSurfaceContrast(surfaceCss, MORE_CONTRAST_REQUIREMENTS, { contrast: 'more', level: 'more', extra });
  const outlineRows = rows.filter(row => row.pair.startsWith('--egd-focus-outline-color'));
  assert.equal(outlineRows.length, 2 * MORE_CONTRAST_REQUIREMENTS.filter(([, foreground]) => foreground === '--egd-focus-outline-color').length);
  assert.ok(outlineRows.length >= 4);
  for (const scheme of ['light+more', 'dark+more']) {
    for (const background of ['--egd-surface', '--egd-surface-elevated']) {
      assert.ok(outlineRows.some(row => row.scheme === scheme && row.pair === `--egd-focus-outline-color vs ${background}`),
        `${scheme} lost focus coverage on ${background}`);
    }
  }
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
  && hasRootOverrides(surfaceCss, { scheme: 'dark', contrast: 'more' });
test('DSN-04 the surface prefers-contrast block meets 7:1 text / 4.5:1 borders',
  () => {
    assert.ok(hasMoreContrast, 'both schemes require a prefers-contrast :root block');
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

test('DSN-03 S5 target: one focus offset and one disabled opacity across the surface', () => {
  const audit = auditCssScale(surfaceCss);
  assert.ok(audit.focusVisibleRules > 0);
  assert.ok(Object.keys(audit.focusOutlineOffsets).length <= 1, JSON.stringify(audit.focusOutlineOffsets));
  assert.ok(Object.keys(audit.disabledOpacities).length <= 1, JSON.stringify(audit.disabledOpacities));
  // Keep the original <= 1 limits, but never accept the single key "NaN"
  // as proof that CSS variable opacities agree or even resolve.
  for (const env of environments) {
    const opacities = resolvedDisabledOpacities(env);
    assert.ok(opacities.length > 0, `${environmentName(env)} has no disabled opacity declarations`);
    assert.ok(new Set(opacities).size <= 1, `${environmentName(env)}: ${opacities.join(', ')}`);
  }
});

// ------------------------------------------------------ D-G regressions

test('D-G5 contrast thresholds and all six avatar requirement rows stay mandatory', () => {
  assert.deepEqual(CONTRAST_RATIOS, { default: { text: 4.5, border: 3 }, more: { text: 7, border: 4.5 } });
  for (const requirements of [CONTRAST_REQUIREMENTS, MORE_CONTRAST_REQUIREMENTS]) {
    for (const [, ink, background, options] of requirements) {
      assert.ok(!options?.todo && !options?.optional, `${ink} vs ${background} must not be bypassed`);
    }
  }
  for (let tone = 0; tone < 6; tone++) {
    assert.ok(CONTRAST_REQUIREMENTS.some(([type, ink, bg, options]) => type === 'text'
      && ink === `avatar.tone-${tone}.color` && bg === `avatar.tone-${tone}.background` && !options?.optional),
    `missing mandatory avatar tone ${tone} requirement`);
  }
});

test('D-G5 the state table retains the agreed focus geometry and disabled opacity values', () => {
  const base = {
    '--egd-focus-outline-width': '2px',
    '--egd-focus-outline-offset': '2px',
    '--egd-focus-outline-inset': 'calc(-1 * var(--egd-focus-outline-width))',
    '--egd-focus-outline-color': 'var(--egd-primary)',
    '--egd-focus-outline': 'var(--egd-focus-outline-width) solid var(--egd-focus-outline-color)',
    '--egd-opacity-disabled': '0.5',
  };
  for (const [name, value] of Object.entries(base)) assert.equal(STATE_TOKEN_TABLE.base[name], value, name);
  assert.equal(STATE_TOKEN_TABLE.prefersContrast['--egd-opacity-disabled'], '0.6');
  assert.equal(STATE_TOKEN_TABLE.forcedColors['--egd-opacity-disabled'], '1');
  assert.equal(STATE_TOKEN_TABLE.forcedColors['--egd-text-disabled'], 'GrayText');
});

test('D-G5 CSS itself implements every state-table token in light/dark, more and forced environments', () => {
  for (const env of environments) {
    const expected = {
      ...STATE_TOKEN_TABLE.base,
      ...(env.contrast === 'more' ? STATE_TOKEN_TABLE.prefersContrast : {}),
      ...(env.forcedColors ? STATE_TOKEN_TABLE.forcedColors : {}),
    };
    // No `extra` overlay: a proposal in the table cannot make absent CSS pass.
    const actual = readRootProperties(surfaceCss, env);
    const ontology = { ...actual, ...declarationsFor('.egd-ontology-card', env) };
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(actual[name], value, `${environmentName(env)} ${name}`);
      assert.equal(ontology[name], value, `${environmentName(env)} Ontology-local ${name}`);
    }
    if (env.contrast === 'more' || env.forcedColors) {
      assert.ok(hasRootOverrides(surfaceCss, env), `${environmentName(env)} needs actual media root overrides`);
    }
  }
});

// Only the observed simple avatar compounds are cascaded here. In particular,
// two classes outrank the later button.egd-codex-message-avatar reset. Browser
// rendering and ancestor/layout behaviour remain separate integration checks.
function avatarPaint(tone, env, chat) {
  const classes = new Set(['egd-profile-avatar', `egd-profile-avatar-tone-${tone}`,
    ...(chat ? ['egd-codex-message-avatar'] : [])]);
  const paints = new Map();
  for (const rule of surfaceRules) {
    if (!mediaApplies(rule.media, env)) continue;
    for (const selector of rule.selectors) {
      const match = /^(button|span|div)?((?:\.[\w-]+)+)$/.exec(selector);
      if (!match || (match[1] && match[1] !== (chat ? 'button' : 'span'))) continue;
      const names = match[2].slice(1).split('.');
      if (!names.every(name => classes.has(name))) continue;
      const specificity = names.length * 100 + (match[1] ? 1 : 0);
      for (const [name, value] of rule.declarations) {
        const property = name === 'background-color' ? 'background' : name;
        if (!['background', 'color'].includes(property)) continue;
        if (!paints.has(property) || specificity >= paints.get(property).specificity) {
          paints.set(property, { value, specificity, selector });
        }
      }
    }
  }
  const properties = readRootProperties(surfaceCss, env);
  return Object.fromEntries(['background', 'color'].map(name => {
    const paint = paints.get(name);
    assert.ok(paint, `${environmentName(env)} tone ${tone} ${name} missing`);
    const color = resolveColor(paint.value, properties);
    assert.ok(color, `${environmentName(env)} ${paint.selector} ${name}: ${paint.value}`);
    return [name, color];
  }));
}

test('D-G2 every profile and higher-specificity chat tone has pale paint, dark ink and 4.5:1 contrast', () => {
  const failures = [];
  const black = parseColor('#000');
  const white = parseColor('#fff');
  for (const scheme of ['light', 'dark']) {
    const env = { scheme };
    assert.deepEqual(readAvatarTones(surfaceCss, env).map(({ tone }) => tone), [0, 1, 2, 3, 4, 5]);
    const properties = readRootProperties(surfaceCss, env);
    for (let tone = 0; tone < 6; tone++) {
      const chatSelector = `.egd-codex-message-avatar.egd-profile-avatar-tone-${tone}`;
      const chatDeclarations = declarationsFor(chatSelector, env);
      assert.ok(chatDeclarations.background || chatDeclarations['background-color'], `${chatSelector} paint is missing`);
      assert.ok(chatDeclarations.color, `${chatSelector} ink is missing`);
      const profile = avatarPaint(tone, env, false);
      const chat = avatarPaint(tone, env, true);
      assert.deepEqual(chat, profile, `${scheme} tone ${tone}: chat specificity must preserve the profile colours`);
      for (const [kind, paint] of [['profile', profile], ['chat', chat]]) {
        for (const canvas of ['--egd-surface', '--egd-surface-elevated']) {
          const background = compositeOver(paint.background, resolveColor(properties[canvas], properties));
          const ink = compositeOver(paint.color, background);
          const ratio = contrastRatio(ink, background);
          // Hue-independent light/dark bounds also reject an inverted pair
          // that happens to pass WCAG. Existing palette mixes are welcome.
          if (contrastRatio(background, black) < 10) failures.push(`${scheme} ${kind} tone ${tone} on ${canvas}: background is not pale`);
          if (contrastRatio(ink, white) < 7) failures.push(`${scheme} ${kind} tone ${tone} on ${canvas}: ink is not dark`);
          if (ratio < 4.5) failures.push(`${scheme} ${kind} tone ${tone} on ${canvas}: ${ratio} < 4.5`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('D-G3 CSS focus-border reaches 3:1 on both field surfaces without table overlays', () => {
  const rows = checkSurfaceContrast(surfaceCss, [
    ['border', '--egd-focus-border', '--egd-surface-elevated'],
    ['border', '--egd-focus-border', '--egd-window-alt'],
  ]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter(row => !row.pass), [], describeRows(rows.filter(row => !row.pass)));
});

test('D-G3 search and Browser address focus use the resolved border instead of translucent or idle overrides', () => {
  const selectors = ['.egd-agenda-switch-search:focus-within', '.egd-codex-thread-search:focus',
    '.egd-browser-card .egd-card-omnibox:focus-within'];
  for (const env of environments) {
    const properties = readRootProperties(surfaceCss, env);
    for (const selector of selectors) {
      const edge = declarationsFor(selector, env)['border-color'];
      assert.equal(edge, 'var(--egd-focus-border)', `${environmentName(env)} ${selector}`);
      if (env.forcedColors) {
        assert.equal(resolveStateValue(edge, properties), 'CanvasText');
      } else {
        for (const background of ['--egd-surface', '--egd-surface-elevated', '--egd-window-alt']) {
          const minimum = env.contrast === 'more' ? 4.5 : 3;
          const ratio = contrastRatio(resolveColor(edge, properties), resolveColor(properties[background], properties));
          assert.ok(ratio >= minimum, `${environmentName(env)} ${selector} on ${background}: ${ratio} < ${minimum}`);
        }
      }
    }
  }
});

// Preserve existing focus coverage, including the narrow-viewport dock rule.
// Counting only surviving declarations would let deleting a focus rule pass.
const insetFocusSelectors = [
  '.egd-board-menu-item:focus-visible',
  '.egd-browser-menu-item:focus-visible',
  '.egd-browser-agent-timeline .egd-browser-agent-timeline-close:focus-visible',
  '.egd-minimap-stack-row:focus-visible',
  '.egd-codex-thread-item:focus-visible',
  '.egd-codex-notices:focus-visible',
  '.egd-context-suggest-row:focus-within',
  '.egd-ontology-stage-mini-tool:focus-visible',
  '.egd-rail-search-result:focus-visible',
];
// The focused row passes its local inset variable to descendants. Its button
// needs an explicit outward reset while the row itself keeps the inset ring.
const focusOffsetResets = new Map([['.egd-context-suggest button:focus-visible', '2px']]);
const focusSelectors = [
  ...insetFocusSelectors,
  '.egd-semantic-proxy:focus-visible', '.egd-semantic-cluster:focus-visible',
  '.egd-board-region-title:focus-visible', '.egd-board-region-menu-button:focus-visible',
  '.egd-store-panel button:focus-visible', '.egd-portable-input:focus-visible',
  '#egd-chat-return .egd-chat-return-button:focus-visible', '.egd-zoom-button:focus-visible',
  '.egd-chat-card-action:focus-visible', '.egd-hud-pin:focus-visible', '.egd-hud-close:focus-visible',
  '.egd-browser-card .egd-desk-window-control:focus-visible',
  '.egd-browser-card .egd-card-nav-btn:focus-visible', '.egd-browser-card .egd-card-menu:focus-visible',
  '.egd-browser-card .egd-browser-agent-badge:focus-visible', '.egd-browser-card .egd-browser-agent-hand:focus-visible',
  '.egd-rail-icon:focus-visible', '.egd-rail-switcher:focus-visible', '.egd-minimap-board-label:focus-visible',
  '.egd-dock-btn:focus-visible', '.egd-bag-chip:focus-visible', '.egd-bag-add:focus-visible',
  '.egdesk-file-tree-item:focus-visible', '.egd-settings-btn:focus-visible', '.egd-settings-link:focus-visible',
  '.egd-settings-segment:focus-visible', '.egd-settings-swatch:focus-visible', '.egd-settings-agent-row:focus-visible',
  '.egd-codex-chat-shell button:focus-visible', '.egd-codex-messages:focus-visible', '.egd-resource-button:focus-visible',
  '#egd-dock:focus-visible', 'button.egd-codex-session-badge-link:focus-visible', '.egd-settings-switch:focus-visible',
  '.egd-codex-agent-peek-trigger:focus-visible', 'button.egd-codex-working-bubble:focus-visible',
  '.egd-codex-computer-use:focus-visible', 'button.egd-codex-answer-fold-card:focus-visible',
  'button.egd-codex-answer-fold-toggle:focus-visible', 'button.egd-result-card-back:focus-visible',
  '.egd-context-suggest button:focus-visible', '.egd-codex-activity-focus',
  // Minimap marks are SVG under the stylesheet's HTML default namespace.
  '*|*.egd-ontology-minimap-layer-pane:focus-visible', '*|*.egd-ontology-minimap-node:focus-visible',
];

test('DSN-03 all existing focus selectors consume the canonical outline and offset', () => {
  for (const selector of focusSelectors) {
    assert.ok(rulesFor(selector).length > 0, `lost focus selector ${selector}`);
    const declarations = declarationsFor(selector);
    assert.equal(declarations.outline, 'var(--egd-focus-outline)', `${selector} outline`);
    assert.equal(declarations['outline-offset'], 'var(--egd-focus-outline-offset)', `${selector} offset`);
  }
  for (const rule of surfaceRules) {
    const selectors = rule.selectors.filter(selector => /:focus-(visible|within)\b/.test(selector)
      || selector === '.egd-codex-activity-focus');
    if (!selectors.length) continue;
    for (const [name, value] of rule.declarations) {
      const label = `${selectors.join(', ')} ${name}`;
      if (name === 'outline') assert.equal(value, 'var(--egd-focus-outline)', label);
      if (name === 'outline-offset') assert.equal(value, 'var(--egd-focus-outline-offset)', label);
      if (name === 'outline-width') assert.equal(value, 'var(--egd-focus-outline-width)', label);
      if (name === 'outline-color') assert.equal(value, 'var(--egd-focus-outline-color)', label);
      if (name === 'outline-style') assert.equal(value, 'solid', label);
    }
  }
});

test('DSN-03 clipping-sensitive focus rings keep the inset through a local offset token', () => {
  const sharedNames = new Set(Object.keys(STATE_TOKEN_TABLE.base));
  const insetScopes = new Set(insetFocusSelectors.flatMap(selector => [selector, selector.replace(/:focus-(visible|within)\b/g, '')]));
  for (const rule of surfaceRules) {
    for (const [name, value] of rule.declarations) {
      if (!sharedNames.has(name)) continue;
      for (const selector of rule.selectors) {
        if (selector === ':root' || selector === '.egd-ontology-card') continue;
        assert.equal(name, '--egd-focus-outline-offset', `${selector} must not shadow shared state token ${name}`);
        if (focusOffsetResets.has(selector)) assert.equal(value, focusOffsetResets.get(selector), `${selector} outward reset`);
        else {
          assert.ok(insetScopes.has(selector), `${selector} is not an approved inset scope`);
          assert.equal(value, 'var(--egd-focus-outline-inset)', `${selector} local offset`);
        }
      }
    }
  }
  for (const selector of focusSelectors) {
    const local = {
      ...declarationsFor(selector.replace(/:focus-(visible|within)\b/g, '')),
      ...declarationsFor(selector),
    };
    if (insetFocusSelectors.includes(selector)) {
      assert.equal(local['--egd-focus-outline-offset'], 'var(--egd-focus-outline-inset)', `${selector} must stay inset`);
    } else if (focusOffsetResets.has(selector)) {
      assert.equal(local['--egd-focus-outline-offset'], focusOffsetResets.get(selector), `${selector} must reset inherited inset`);
    } else {
      assert.equal(local['--egd-focus-outline-offset'], undefined, `${selector} acquired an unapproved offset`);
    }
    for (const env of environments) {
      const environmentLocal = {
        ...declarationsFor(selector.replace(/:focus-(visible|within)\b/g, ''), env),
        ...declarationsFor(selector, env),
      };
      const properties = { ...readRootProperties(surfaceCss, env), ...Object.fromEntries(
        Object.entries(environmentLocal).filter(([name]) => name.startsWith('--'))) };
      assert.equal(resolveStateValue('var(--egd-focus-outline-width)', properties), '2px', `${selector} width`);
      assert.equal(resolveStateValue('var(--egd-focus-outline-offset)', properties),
        insetFocusSelectors.includes(selector) ? 'calc(-1 * 2px)' : '2px', `${environmentName(env)} ${selector}`);
    }
  }
});

const disabledOpacitySelectors = [
  '.egd-desk-window-control-disabled',
  '.egd-store-panel button[disabled]', '.egd-card-nav-btn:disabled', '.egd-rail-icon:disabled',
  '.egd-codex-chip:disabled', '#egd-codex-activity-panel button:disabled', '.egd-codex-result-chip:disabled',
  '.egd-file-chat-attach:disabled', '.egdesk-file-tree-item[aria-disabled="true"]', '.egdesk-file-view button:disabled',
  '.egd-codex-send:disabled', '.egd-settings-btn[disabled]', '.egd-settings-link[disabled]',
  '.egd-codex-stop:disabled', '.egd-codex-user-input input:disabled', '.egd-codex-thread-menu-item:disabled',
  '.egd-codex-thread-menu-item:disabled:hover', 'button.egd-task-confirm-go[aria-disabled="true"]',
  'button.egd-task-hold-resume[aria-disabled="true"]', 'button.egd-task-approve[aria-disabled="true"]',
  'button.egd-task-reject[aria-disabled="true"]', 'button.egd-plan-approve[aria-disabled="true"]',
  'button.egd-plan-reject[aria-disabled="true"]', 'button.egd-plan-confirm-go[aria-disabled="true"]',
  '.egd-settings-switch:disabled', '.egd-context-suggest-add:disabled',
];

test('DSN-03 disabled declarations retain coverage and use one visible resolved opacity per environment', () => {
  for (const selector of disabledOpacitySelectors) {
    assert.equal(declarationsFor(selector).opacity, 'var(--egd-opacity-disabled)', `${selector} opacity`);
  }
  assert.ok(disabledOpacityRules.length > 0);
  for (const rule of disabledOpacityRules) {
    for (const [name, value] of rule.declarations) {
      if (name === 'opacity') assert.equal(value, 'var(--egd-opacity-disabled)', rule.selectors.join(', '));
    }
  }
  for (const env of environments) {
    const opacities = resolvedDisabledOpacities(env);
    assert.ok(opacities.length > 0);
    assert.deepEqual([...new Set(opacities)], [env.forcedColors ? 1 : env.contrast === 'more' ? 0.6 : 0.5], environmentName(env));
  }
});

test('D-G5 non-colour state checks reject unresolved and cyclic variables instead of NaN false passes', () => {
  assert.equal(resolveStateValue('var(--disabled)', { '--disabled': '0.6' }), '0.6');
  assert.throws(() => resolveStateValue('var(--missing)', {}), /missing state token/);
  assert.throws(() => resolveStateValue('var(--a)', { '--a': 'var(--b)', '--b': 'var(--a)' }), /cyclic state token/);
  assert.equal(isDisabledSelector('.button:not(:disabled):hover'), false);
  assert.equal(isDisabledSelector('.button:hover:not([disabled])'), false);
  assert.equal(isDisabledSelector(".button[aria-disabled='true']"), true);
});

// Expand the flat :is() lists used by the disabled override, without pretending
// to be a browser selector engine. An unsupported selector cannot supply proof
// of coverage. Keep !important visible for this check: readCssRules normally
// strips it because colour arithmetic does not need declaration priority.
const importantMarker = '__egd_test_important__';
const priorityRules = readCssRules(surfaceCss.replace(/!\s*important\b/gi, importantMarker));
function expandFlatIs(selector) {
  const group = /:is\(([^()]*)\)/.exec(selector);
  if (!group) return [selector];
  return group[1].split(',').flatMap(choice => expandFlatIs(
    selector.slice(0, group.index) + choice.trim() + selector.slice(group.index + group[0].length)));
}
const disabledTarget = selector => selector.replace(/:hover\b/g, '').replace(/^button(?=\.)/, '').trim();

test('D-G3 forced colours keep automatic adjustment and visible GrayText on every disabled control', () => {
  // Include width/motion media that mediaApplies deliberately does not model.
  for (const rule of surfaceRules) {
    for (const [name, value] of rule.declarations) {
      if (name === 'forced-color-adjust') assert.notEqual(value.toLowerCase(), 'none', rule.selectors.join(', '));
    }
  }
  const targets = [...new Set([
    ...disabledOpacitySelectors,
    '.egd-card-nav-btn:disabled:hover', '.egd-codex-chat-shell button:disabled',
    'button.egd-codex-engine-choice:disabled', 'button.egd-codex-stateless-toggle:disabled',
  ].map(disabledTarget))];
  for (const env of environments.filter(env => env.forcedColors)) {
    const properties = readRootProperties(surfaceCss, env);
    assert.equal(resolveStateValue('var(--egd-text-disabled)', properties), 'GrayText');
    assert.equal(resolveStateValue('var(--egd-opacity-disabled)', properties), '1');
    const inkCoverage = new Set();
    const childInkCoverage = new Set();
    for (const [index, rule] of surfaceRules.entries()) {
      if (!mediaApplies(rule.media, env)) continue;
      for (const [name, value] of rule.declarations) {
        if (name === 'forced-color-adjust') {
          assert.equal(resolveStateValue(value, properties).toLowerCase(), 'auto', rule.selectors.join(', '));
        }
      }
      const disabled = rule.selectors.filter(isDisabledSelector);
      if (!disabled.length) continue;
      const declarations = Object.fromEntries(rule.declarations);
      const priorities = Object.fromEntries(priorityRules[index].declarations);
      if (priorities.color?.endsWith(importantMarker)) {
        // Any important disabled ink active here must remain system GrayText;
        // a later important brand colour must not defeat the forced override.
        assert.equal(resolveStateValue(declarations.color, properties), 'GrayText', disabled.join(', '));
      }
      if (!rule.media.some(media => /forced-colors/.test(media))) continue;
      if (declarations.color == null) continue;
      assert.equal(resolveStateValue(declarations.color, properties), 'GrayText', disabled.join(', '));
      assert.ok(priorities.color?.endsWith(importantMarker), 'forced disabled ink must survive later component colours');
      for (const selector of disabled.flatMap(expandFlatIs)) {
        if (selector.endsWith(' *')) childInkCoverage.add(disabledTarget(selector.slice(0, -2)));
        else {
          inkCoverage.add(disabledTarget(selector));
          assert.equal(resolveStateValue(declarations.opacity, properties), '1', `${selector} forced opacity`);
          assert.ok(priorities.opacity?.endsWith(importantMarker), `${selector} forced opacity priority`);
        }
      }
    }
    for (const target of targets) {
      assert.ok(inkCoverage.has(target), `${environmentName(env)} missing forced disabled ink for ${target}`);
      assert.ok(childInkCoverage.has(target), `${environmentName(env)} child ink can override GrayText in ${target}`);
    }
  }
});

const idleInputEdges = [
  ['#egd-board-scope input', 'border', '1px solid var(--egd-line-strong)'],
  ['.egd-portable-input', 'border', '1px solid var(--egd-outline)'],
  ['.egd-card-omnibox', 'border', '1px solid var(--egd-outline)'],
  ['.egd-browser-card .egd-card-omnibox', 'border-color', 'var(--egd-outline-variant)'],
  ['.egd-rail-search', 'border', '1px solid var(--egd-outline)'],
  ['.egd-agenda-switch-search', 'border', '1px solid var(--egd-outline)'],
  ['.egd-codex-thread-search', 'border', '1px solid var(--egd-chat-outline-soft)'],
  ['.egd-codex-input-row', 'border', '1px solid var(--egd-outline)'],
  ['.egd-settings-form-input', 'border', '1px solid var(--egd-outline)'],
  ['.egd-settings-form-textarea', 'border', '1px solid var(--egd-outline)'],
  ['.egd-codex-user-input input[type="text"]', 'border', '1px solid var(--egd-outline)'],
  ['.egd-codex-user-input input[type="password"]', 'border', '1px solid var(--egd-outline)'],
];

test('D-G3 ordinary light/dark input edges retain the approved quiet palette and 1px geometry', () => {
  const palette = {
    light: { '--egd-outline': '#DEDFD8', '--egd-outline-variant': '#EAEAE4' },
    dark: { '--egd-outline': '#4A4E47', '--egd-outline-variant': '#41463F' },
  };
  for (const scheme of ['light', 'dark']) {
    const properties = readRootProperties(surfaceCss, { scheme });
    for (const [name, value] of Object.entries(palette[scheme])) assert.equal(properties[name].toUpperCase(), value, `${scheme} ${name}`);
    assert.equal(properties['--egd-line-strong'], 'color-mix(in srgb, var(--egd-wood-line) 45%, var(--egd-surface-elevated))');
    for (const [selector, property, value] of idleInputEdges) {
      const declarations = declarationsFor(selector, { scheme });
      assert.equal(declarations[property], value, `${scheme} ${selector} ${property}`);
      if (property === 'border') assert.ok(declarations['border-color'] == null,
        `${scheme} ${selector}: idle border colour was overridden`);
      assert.ok(declarations['border-width'] == null || declarations['border-width'] === '1px', `${selector} border width`);
    }
  }
});

test('D-G3 ordinary input edges become stronger through more/forced media, without widening controls', () => {
  for (const env of environments.filter(env => env.contrast === 'more' || env.forcedColors)) {
    const properties = readRootProperties(surfaceCss, env);
    for (const [selector, property] of idleInputEdges) {
      const declarations = declarationsFor(selector, env);
      const border = declarations.border;
      if (property === 'border') assert.match(border, /^1px solid /, `${environmentName(env)} ${selector} geometry`);
      assert.ok(declarations['border-width'] == null || declarations['border-width'] === '1px', `${selector} border width`);
      const expression = declarations['border-color'] || border?.replace(/^1px solid /, '');
      assert.ok(expression, `${selector} lost its edge`);
      if (env.forcedColors) {
        assert.ok(['CanvasText', 'FieldText', 'ButtonBorder'].includes(resolveStateValue(expression, properties)),
          `${environmentName(env)} ${selector}: edge must use a visible system colour`);
      } else {
        const edge = resolveColor(expression, properties);
        assert.ok(edge, `${selector} unresolved edge: ${expression}`);
        for (const canvas of ['--egd-surface-elevated', '--egd-window-alt']) {
          const background = resolveColor(properties[canvas], properties);
          const ratio = contrastRatio(edge, background);
          assert.ok(ratio >= 4.5, `${environmentName(env)} ${selector} on ${canvas}: ${ratio} < 4.5`);
        }
      }
    }
  }
});

test('wide Briefing keeps navigation outside the independently scrollable body', () => {
  const wide = '#egd-answer-briefing[data-compact="false"]';
  const panel = declarationsFor(wide), header = declarationsFor(`${wide} > .egd-briefing-header`);
  const body = declarationsFor(`${wide} > .egd-briefing-body`);
  assert.equal(panel.display, 'flex');
  assert.equal(panel['flex-direction'], 'column');
  assert.equal(panel.overflow, 'hidden');
  assert.equal(panel['max-height'], 'min(48vh, calc(100vh - 150px))');
  assert.equal(header.flex, '0 0 auto');
  assert.equal(header['min-width'], '0');
  assert.equal(body.flex, '1 1 auto');
  assert.equal(body['min-width'], '0');
  assert.equal(body['min-height'], '0');
  assert.equal(body.padding, '4px');
  assert.equal(body.margin, '-4px');
  assert.equal(body.overflow, 'auto');
  assert.equal(body['overscroll-behavior'], 'contain');
  assert.equal(body['scroll-padding'], '4px');
});

test('Briefing scroll containment leaves wide placement and the compact layout unchanged', () => {
  const base = declarationsFor('#egd-answer-briefing');
  assert.equal(base.position, 'fixed');
  assert.equal(base.left, '118px');
  assert.equal(base.bottom, '108px');
  assert.equal(base.width, 'min(440px, calc(100vw - 150px))');
  assert.equal(base.padding, '14px');
  assert.equal(base['max-height'], '48vh');
  const compact = '#egd-answer-briefing[data-compact="true"]';
  const narrow = Object.fromEntries(rulesFor(compact).filter(rule => rule.media.includes('(max-width: 56rem)')).flatMap(rule => rule.declarations));
  assert.equal(narrow['box-sizing'], 'border-box');
  assert.equal(narrow.gap, '8px');
  assert.equal(narrow.padding, '8px');
  assert.equal(narrow.overflow, 'hidden');
  const body = declarationsFor(`${compact} .egd-briefing-body`);
  assert.equal(body.order, '-1');
  assert.equal(body['overflow-y'], 'auto');
  const wide = declarationsFor('#egd-answer-briefing[data-compact="false"]');
  for (const property of ['left', 'right', 'top', 'bottom', 'width', 'height', 'padding', 'transform']) assert.equal(wide[property], undefined);
});

// Run the production composer handlers and bridge send together. The DOM,
// project preparation and transport boundaries below are local fixtures; the
// transport records the request and returns a synthetic acceptance only.
function chatComposerFixture({ reply, inputSources = [], captureInputs = null } = {}) {
  const target = { boardId: 'fixture-board', projectId: 'fixture-project', rootId: 'fixture-root' };
  const activeThread = { id: 'room-a', clientBindingId: 'wire-a', title: '합성 방', engineId: 'codex',
    messages: [], inputSources: structuredClone(inputSources), briefingInputs: [], requestProjectTarget: target };
  const state = { codex: { activeThreadId: activeThread.id, activityRoomGeneration: 7, threads: [activeThread],
    threadDrafts: { 'room-a': '합성 질문' }, threadDraftRevisions: { 'room-a': 1 },
    authStatus: { isLoggedIn: true, authMode: 'chatgpt', accountEmail: 'fixture@example.test', identityStatus: 'known' }, connected: true, liveRevision: 0 } };
  const protocol = ChatState.createChatProtocolState(), reservations = new Map(), requests = [], owners = [], notices = [], listeners = new Set();
  state.codex.chatProtocol = protocol;
  state.codex.codexAccountKey = ChatState.codexAccountKey(state.codex.authStatus);
  const thread = id => state.codex.threads.find(item => item.id === id) || null;
  const updateThreadById = (id, update) => { state.codex.threads = state.codex.threads.map(item => item.id === id ? update(item) : item); };
  const draft = (codex, id) => codex.threadDrafts[id] || '';
  const deps = { state, ChatState, InputContext, protocol, memoAskSendReservations: reservations,
    getActiveCodexThread: codex => thread(codex.activeThreadId), getCodexThreadById: (_codex, id) => thread(id), getCodexThreadDraft: draft,
    clearMemoManualSendNotice: () => false, showMemoManualSendNotice: item => notices.push(item.id),
    threadBusy: () => false, chatRoomProjectSendBlock: () => null, chatRequestProjectDisplays: new Map(),
    epochScope: ChatState.createChatEpochScope(), ensureNativeReadyForSend: async () => true, updateThreadById,
    emit() { for (const listener of [...listeners]) listener(state.codex); },
    captureThreadInputs: async (_thread, inputs) => {
      if (captureInputs) return captureInputs(inputs);
      assert.deepEqual(inputs, []); return [];
    },
    codexThreadAgentProfile: () => null, SELF_MEMBER: 'self',
    createCodexMessage: (role, content, status, options) => ({ role, content, status, ...options }),
    appendMessageToThread: (id, message) => updateThreadById(id, item => ({ ...item, messages: [...item.messages, message] })),
    codexThreadRuntimeConfig: () => ({}), browserToolSelectedSources: () => [], rootSseReady: () => ({ sourceReady: true }),
    fetchJson: async (path, options) => {
      assert.equal(path, '/chat/send', 'the fixture must never perform an external call');
      assert.equal(options.method, 'POST');
      const request = JSON.parse(options.body);
      requests.push(request);
      return reply ? reply(request) : { accepted: true, conversationId: 'fixture-conversation', runId: 'fixture-run' };
    },
    syncProtocolRun() {},
  };
  const receiptNames = ['createAcceptedReceiptWatch', 'rememberAcceptedInputReceipt'];
  const receiptSources = receiptNames.map(name => {
    const start = surfaceScript.indexOf(`  function ${name}(`);
    const end = surfaceScript.indexOf('\n  }', start);
    assert.ok(start >= 0 && end > start, `production ${name}`);
    return surfaceScript.slice(start, end + 4);
  });
  Object.assign(deps, compileFunction(`${receiptSources.join('\n')}\nreturn { ${receiptNames.join(', ')} };`,
    ['state', 'ChatState', 'getCodexThreadById'])(state, ChatState, deps.getCodexThreadById));
  const watchStart = surfaceScript.indexOf('    const memoReadWatches = new Map();');
  const watchEnd = surfaceScript.indexOf('    const confirmedLegacyImports', watchStart);
  assert.ok(watchStart >= 0 && watchEnd > watchStart, 'production room identity watches');
  deps.watchMemoRead = compileFunction(`${surfaceScript.slice(watchStart, watchEnd)}\nreturn watchMemoRead;`,
    ['state', 'ChatState', 'getCodexThreadById', 'memoAskRuntimeIdentity'])(
    state, ChatState, deps.getCodexThreadById, () => null);
  const captureStart = surfaceScript.indexOf('      captureManualSendOwner(');
  const captureEnd = surfaceScript.indexOf('\n      },', captureStart);
  assert.ok(captureStart >= 0 && captureEnd > captureStart, 'production composer owner capture');
  const captureOwner = compileFunction(`return { ${surfaceScript.slice(captureStart, captureEnd + 8)} };`,
    Object.keys(deps))(...Object.values(deps)).captureManualSendOwner;
  const methodStart = surfaceScript.indexOf('      async sendMessage(');
  const methodEnd = surfaceScript.indexOf('\n      },', methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'production send method');
  const send = compileFunction(`return { ${surfaceScript.slice(methodStart, methodEnd + 8)} };`,
    Object.keys(deps))(...Object.values(deps)).sendMessage;
  let pending = null;
  const codexBridge = {
    sendMessage(options) { owners.push(options.manualOwner); pending = send.call(this, options); return pending; },
    subscribe(listener) { listeners.add(listener); listener(state.codex); return () => listeners.delete(listener); },
    captureManualSendOwner: captureOwner,
    setDraft(value, id) { state.codex.threadDrafts[id] = value; },
  };
  state.codexBridge = codexBridge;
  const el = (tag, props, ...children) => ({ tag, props, children, events: {}, isConnected: false,
    addEventListener(type, handler) { this.events[type] = handler; } });
  const composerStart = surfaceScript.indexOf('            const manualOwner = ');
  const composerEnd = surfaceScript.indexOf('            let composerWidth = 0;', composerStart);
  assert.ok(composerStart >= 0 && composerEnd > composerStart, 'production composer event handlers');
  const composer = compileFunction(`let compositionInProgress = false, deferredCodex = null;\n${surfaceScript.slice(composerStart, composerEnd)}\nreturn { input, sendButton, manualOwner };`,
    ['activeThread', 'codex', 'ChatState', 'el', 'deskIcon', 'getCodexThreadDraft', 'composerViewport', 'codexBridge', 'body'])(
    activeThread, state.codex, ChatState, el, name => ({ icon: name }), draft, { cancel() {} }, codexBridge, {});
  return { ...composer, state, protocol, reservations, requests, owners, notices, pending: () => pending };
}

test('approved Chat refinement keeps accessible composer and real HUD actions', () => {
  const input = declarationsFor('.egd-codex-input', { scheme: 'light' });
  assert.equal(input['min-height'], '40px');
  assert.equal(input['max-height'], '9.6em');
  assert.equal(input['font-size'], '15px');
  assert.equal(input['line-height'], '1.6');
  const send = declarationsFor('.egd-codex-send', { scheme: 'light' });
  assert.equal(send['min-width'], '34px');
  assert.equal(send['min-height'], '34px');
  const { input: composer, sendButton } = chatComposerFixture();
  assert.equal(composer.props['aria-label'], '합성 방에 보낼 메시지');
  assert.match(composer.props['aria-description'], /Enter로 줄바꿈.*Enter로 전송/);
  assert.equal(composer.props.data.testid, 'chat-composer');
  assert.equal(sendButton.props['aria-label'], '메시지 보내기');
  assert.equal(sendButton.props.type, 'button');
  assert.equal(sendButton.props.data.testid, 'chat-send');
  assert.equal(sendButton.children[0].icon, 'send');
  assert.equal(typeof sendButton.props.onclick, 'function');
  assert.match(surfaceScript, /class: 'egd-hud-pin',[^]*?'aria-label': '캔버스로 이동'[^]*?detachCodexChatFromHud\(\)[^]*?deskIcon\('detach'\)/);
  assert.match(surfaceScript, /class: 'egd-hud-close',[^]*?'aria-label': '닫기'[^]*?toggleHUD\(null\)[^]*?deskIcon\('close'\)/);
  assert.match(surfaceScript, /data: \{ testid: 'chat-attach-open' \}/);
  assert.match(surfaceScript, /renderEngineChip\(activeThread\)/);
  assert.match(surfaceScript, /codexUsageRing\(codex\.authStatus\)/);
});

test('the actual composer button and keyboard handlers dispatch once with their room owner', async t => {
  for (const mode of ['button', 'control-enter', 'command-enter']) await t.test(mode, async () => {
    const h = chatComposerFixture();
    let prevented = false;
    if (mode === 'button') h.sendButton.props.onclick();
    else h.input.events.keydown({ key: 'Enter', ctrlKey: mode === 'control-enter', metaKey: mode === 'command-enter',
      preventDefault() { prevented = true; } });
    assert.equal(prevented, mode !== 'button');
    const result = await h.pending();
    assert.equal(result.accepted, true);
    assert.equal(h.owners.length, 1);
    const { threadId, binding, roomGeneration, current, release } = h.owners[0];
    assert.deepEqual({ threadId, binding, roomGeneration }, { threadId: 'room-a', binding: 'wire-a', roomGeneration: 7 });
    assert.equal(typeof current, 'function');
    assert.equal(typeof release, 'function');
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].clientThreadId, 'wire-a');
    assert.equal(h.requests[0].message, '합성 질문');
    assert.deepEqual(h.requests[0].projectTarget, { boardId: 'fixture-board', projectId: 'fixture-project', rootId: 'fixture-root' });
    assert.equal(h.protocol.requests[result.requestId].status, 'accepted');
    assert.equal(h.state.codex.threads[0].messages.length, 1);
  });
});

test('ordinary composer: acceptance does not clear a newer draft or manual selection', async () => {
  const original = { id: 'synthetic-input-a', kind: 'board-element', sourceRef: { viewId: 'synthetic-view-a' } };
  const newer = { id: 'synthetic-input-b', kind: 'board-element', sourceRef: { viewId: 'synthetic-view-b' } };
  let release;
  const pendingReply = new Promise(resolve => { release = resolve; });
  const response = { accepted: true, conversationId: 'fixture-conversation', runId: 'fixture-run' };
  const h = chatComposerFixture({ inputSources: [original], captureInputs: inputs => {
    assert.deepEqual(inputs, [original]);
    const scope = ChatState.chatContextRequestScope(h.state.codex.threads[0], h.state.codex);
    return [InputContext.capturedInputReference(original, { id: original.id, sourceId: 'synthetic-snapshot-a',
      snapshotId: 'synthetic-snapshot-a', hash: 'synthetic-hash-a', sourceRef: original.sourceRef,
      clientThreadId: scope.clientThreadId, engine: { engineId: scope.engineId, engineProfileId: scope.engineProfileId } }, scope)];
  }, reply: () => pendingReply });
  h.sendButton.props.onclick();
  try {
    for (let count = 0; count < 50 && !h.requests.length; count++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.requests.length, 1); assert.deepEqual(h.requests[0].contextSnapshotIds, ['synthetic-snapshot-a']);
    h.state.codex.threadDrafts['room-a'] = '새 초안 B'; h.state.codex.threadDraftRevisions['room-a']++;
    h.state.codex.threads[0].inputSources = [newer];
    release(response);
    const result = await h.pending();
    assert.equal(result.accepted, true); assert.equal(h.requests.length, 1);
    assert.equal(h.state.codex.threadDrafts['room-a'], '새 초안 B');
    assert.deepEqual(h.state.codex.threads[0].inputSources, [newer]);
    assert.deepEqual(h.state.codex.threads[0].briefingInputs, []);
    assert.equal(h.protocol.requests[result.requestId].acceptedInputMessageId, undefined, 'acceptance is not invented receipt proof');
  } finally { release(response); h.manualOwner.release(); }
});

test('composer does not dispatch for newline, modified shortcuts or IME composition', async () => {
  const h = chatComposerFixture();
  for (const fields of [{ key: 'Enter' }, { key: 'Enter', ctrlKey: true, shiftKey: true },
    { key: 'Enter', metaKey: true, altKey: true }, { key: 'Enter', ctrlKey: true, isComposing: true },
    { key: 'Enter', ctrlKey: true, keyCode: 229 }]) {
    h.input.events.keydown({ ...fields, preventDefault() { assert.fail('this key must remain available to the editor'); } });
  }
  h.input.events.compositionstart();
  h.sendButton.props.onclick();
  h.input.events.keydown({ key: 'Enter', ctrlKey: true, preventDefault() { assert.fail('IME must retain Enter'); } });
  assert.equal(h.owners.length, 0);
  assert.equal(h.requests.length, 0);
  h.input.events.compositionend();
  h.input.events.keydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
  assert.equal((await h.pending()).accepted, true);
  assert.equal(h.requests.length, 1);
});

test('a reserved room blocks the real composer send without queueing or changing its draft', async () => {
  const h = chatComposerFixture();
  h.reservations.set('room-a', { scope: { current: () => true } });
  h.sendButton.props.onclick();
  await h.pending();
  assert.deepEqual(h.notices, ['room-a']);
  assert.equal(h.state.codex.threadDrafts['room-a'], '합성 질문');
  assert.equal(h.requests.length, 0);
  h.reservations.delete('room-a');
  await Promise.resolve();
  assert.equal(h.requests.length, 0, 'releasing a reservation must not automatically resend');
  h.sendButton.props.onclick();
  assert.equal((await h.pending()).accepted, true);
  assert.equal(h.requests.length, 1, 'an explicit retry sends once');
});

test('an old composer cannot send to a different room, binding or room generation', async t => {
  for (const change of ['room', 'binding', 'generation']) for (const reserved of [false, true]) await t.test(`${change}, reserved=${reserved}`, async () => {
    const h = chatComposerFixture();
    if (change === 'room') {
      h.state.codex.threads.push({ id: 'room-b', clientBindingId: 'wire-b', messages: [], inputSources: [], briefingInputs: [] });
      h.state.codex.threadDrafts['room-b'] = '다른 방 초안';
      h.state.codex.activeThreadId = 'room-b';
      h.state.codex.activityRoomGeneration++;
    } else if (change === 'binding') h.state.codex.threads[0].clientBindingId = 'replacement-wire';
    else h.state.codex.activityRoomGeneration += 2;
    if (reserved) h.reservations.set(h.state.codex.activeThreadId, { scope: { current: () => true } });
    const before = structuredClone(h.state.codex.threadDrafts);
    h.sendButton.props.onclick();
    await h.pending();
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.state.codex.threadDrafts, before);
    assert.deepEqual(h.notices, []);
  });
});

test('composer send preserves the distinction between refusal and an unknown outcome', async t => {
  const cases = [
    { name: 'refusal', reply: () => ({ accepted: false, error: 'fixture refusal' }), status: 'failed', error: /fixture refusal/ },
    { name: 'timeout', reply: () => { throw new Error('fixture timeout'); }, status: 'unconfirmed', error: /접수 여부를 확인하지 못했습니다.*fixture timeout/ },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const h = chatComposerFixture({ reply: scenario.reply });
    h.sendButton.props.onclick();
    const result = await h.pending();
    assert.equal(result.accepted, false);
    assert.equal(result.status, scenario.status);
    assert.equal(h.protocol.requests[result.requestId].status, scenario.status);
    assert.match(h.state.codex.threads[0].sendError, scenario.error);
    assert.equal(h.requests.length, 1);
    if (scenario.status === 'failed') {
      assert.equal(h.state.codex.threadDrafts['room-a'], '합성 질문');
      assert.deepEqual(h.state.codex.threads[0].requestProjectTarget,
        { boardId: 'fixture-board', projectId: 'fixture-project', rootId: 'fixture-root' });
    }
    await Promise.resolve();
    assert.equal(h.requests.length, 1, 'neither failure mode retries automatically');
  });
});

test('an observed account change and return invalidates the original composer owner', async () => {
  const h = chatComposerFixture();
  assert.equal(h.manualOwner.current(), true);
  h.state.codex.authStatus.accountEmail = 'other-fixture@example.test';
  assert.equal(h.manualOwner.current(), false);
  h.state.codex.authStatus.accountEmail = 'fixture@example.test';
  assert.equal(h.manualOwner.current(), false, 'a return to the old value does not revive the owner');
  h.sendButton.props.onclick();
  await h.pending();
  assert.equal(h.requests.length, 0);
  assert.equal(h.state.codex.threadDrafts['room-a'], '합성 질문');
});

test('Desk chrome keeps its existing geometry and legible local outline glyphs', () => {
  const rail = declarationsFor('#egd-desk-rail', { scheme: 'light' });
  assert.equal(rail.height, '52px');
  assert.equal(rail.width, '100%');
  assert.equal(rail['border-radius'], '0');
  assert.equal(declarationsFor('#egd-preset-bag', { scheme: 'light' }).width, '64px');
  assert.equal(declarationsFor('#egd-dock', { scheme: 'light' })['min-height'], '46px');
  const dockButton = declarationsFor('.egd-dock-btn', { scheme: 'light' });
  assert.equal(dockButton.width, '32px');
  assert.equal(dockButton['min-height'], '32px');
  const start = surfaceScript.indexOf('  const DESK_ICON_SHAPES = {');
  const end = surfaceScript.indexOf('\n\n  function deskIcon(', start);
  const iconFunction = surfaceScript.match(/^  function deskIcon\([^]*?^  \}/m)?.[0];
  assert.ok(start > 0 && end > start && iconFunction, 'the real local icon renderer');
  const svgEl = (tag, attrs) => ({ tag, attrs, children: [], appendChild(child) { this.children.push(child); } });
  const makeIcon = compileFunction(`${surfaceScript.slice(start, end)}\n${iconFunction}\nreturn deskIcon;`, ['svgEl'])(svgEl);
  for (const name of ['chat', 'file', 'folder', 'pointer', 'grip', 'send', 'detach', 'close']) {
    const icon = makeIcon(name);
    assert.equal(icon.tag, 'svg');
    assert.equal(icon.attrs.viewBox, '0 0 24 24');
    assert.equal(icon.attrs.stroke, 'currentColor');
    assert.equal(icon.attrs['stroke-width'], '1.8');
    assert.equal(icon.attrs['aria-hidden'], 'true');
    assert.ok(icon.children.length, name);
  }
});

test('Browser semantic presentation uses the shared detail policy at 69% and 50%', () => {
  const start = surfaceScript.indexOf('        const projectedFont =', surfaceScript.indexOf('    const render = () => {', surfaceScript.indexOf('function installSemanticZoom')));
  const end = surfaceScript.indexOf('        if (level !== entry.level)', start);
  assert.ok(start > 0 && end > start, 'read the real semantic render branch');
  const renderLevel = compileFunction(`${surfaceScript.slice(start, end)}\nreturn level;`,
    ['entry', 'card', 'rect', 'zoom', 'SurfaceState', 'isCardFullscreen', 'detailWidth', 'detailHeight']);
  const level = ({ zoom, measured = null, previous = 'outline', width = 720, height = 500, fullscreen = false }) => renderLevel(
    { kind: 'browser', bodyFontPx: 11, level: previous },
    { _browserPresentation: { font: () => measured } },
    { width: width * zoom, height: height * zoom }, zoom, SurfaceState, () => fullscreen, 240, 180);
  for (const zoom of [.69, .5]) {
    assert.equal(level({ zoom }), 'detail', `unmeasured Browser at ${zoom}`);
    assert.equal(level({ zoom, measured: 10 * zoom }), 'detail', `measured Browser at ${zoom}`);
    assert.equal(level({ zoom, width: 320, height: 420 }), 'detail', `minimum View at ${zoom}`);
  }
  for (const previous of ['outline', 'detail']) {
    for (const zoom of [1, .69, .5]) {
      assert.equal(level({ zoom, previous, width: 448, height: 343, measured: 4.02594 * zoom }), 'detail',
        'tiny internally fitted page text must not blank a usable native Browser card');
    }
  }
  assert.equal(level({ zoom: .5, measured: 4.7 }), 'detail', 'nominal card font is an LOD-only floor');
  assert.equal(level({ zoom: .28, measured: 3.1 }), 'outline', 'the common 3.3px entry floor is retained below nominal readability');
  assert.equal(level({ zoom: .28, measured: 3.1, previous: 'detail' }), 'detail', 'the common 2.9px exit band is retained');
  assert.equal(level({ zoom: .3 }), 'detail', 'nominal Browser detail now enters at 30%');
  assert.equal(level({ zoom: .25 }), 'outline', 'genuinely small content can still abstract');
  assert.equal(level({ zoom: .01, fullscreen: true }), 'detail', 'fullscreen retains its existing exception');
});

test('Browser measurement candidate follows the shared projected-size policy; focus remains readable', () => {
  const helper = surfaceScript.match(/^  function browserPresentationMayNeedMetrics\([^]*?^  \}/m)?.[0];
  assert.ok(helper, 'production measurement candidate');
  const mayMeasure = compileFunction(`${helper}\nreturn browserPresentationMayNeedMetrics;`, ['SurfaceState'])(SurfaceState);
  const candidate = (width, height) => mayMeasure({ width, height, detailWidth: 240, detailHeight: 180 });
  assert.equal(candidate(320 * .5, 420 * .5), true, 'a small View at 50% can acquire real metrics');
  assert.equal(candidate(100, 80), true, 'projections inside the new retention band can acquire metrics');
  assert.equal(candidate(88, 66), false, 'projections below the 88.704x66.528px retention band do not request metrics');
  assert.equal(candidate(0, 210), false);
  assert.match(surfaceScript, /!card\._browserState\?\.loading &&\s*browserPresentationMayNeedMetrics\(\{ \.\.\.rect, detailWidth, detailHeight \}\)/);
  const focus = surfaceScript.match(/    const focusProjection = \(entry, \{ revealHeader = false \} = \{\}\) => \{([^]*?)\n    \};/)?.[1];
  assert.ok(focus, 'production focus-to-readable path');
  assert.match(focus, /measuredWorldFont \? 0 : entry\.kind === 'browser' \? 0\.83 : 0\.76/);
  assert.match(focus, /10\.6 \/ \(measuredWorldFont \|\| entry\.bodyFontPx\)/);
  assert.match(focus, /\(detailWidth \+ 1\) \/ world\.width, \(detailHeight \+ 1\) \/ world\.height/);
});

test('active and selected cards keep a blue selection edge across zoom and compact views', () => {
  const selectors = ['.egd-canvas-card.egd-entity-active', '.egd-canvas-card.egd-entity-selected:not(.egd-entity-active)',
    '.egd-browser-card.egd-entity-active', '.egd-browser-card.egd-entity-selected:not(.egd-entity-active)', '.egd-chat-card.egd-entity-active'];
  for (const scheme of ['light', 'dark']) {
    const env = { scheme };
    for (const selector of selectors) assert.equal(declarationsFor(selector, env)['border-color'], 'var(--egd-card-selection)', selector);
    for (const selector of selectors.slice(0, 2)) assert.equal(declarationsFor(selector, env).outline,
      'calc(2px / var(--egd-camera-zoom, 1)) solid var(--egd-card-selection)', selector);
    const root = readRootProperties(surfaceCss, env);
    const selection = resolveColor('var(--egd-card-selection)', root);
    for (const background of ['--egd-surface-elevated', '--egd-wood']) {
      assert.ok(contrastRatio(selection, resolveColor(`var(${background})`, root)) >= 4.5, `${scheme} ${background}`);
    }
  }
  const proxy = declarationsFor('.egd-canvas-card:is(.egd-entity-active, .egd-entity-selected) > .egd-semantic-proxy');
  assert.equal(proxy['border-width'], '2px');
  assert.equal(proxy['border-color'], 'var(--egd-card-selection)');
  assert.equal(readRootProperties(surfaceCss, { forcedColors: true })['--egd-card-selection'], 'Highlight');
});

test('resource strip keeps readable compact values and a neutral disk glyph', () => {
  const env = { scheme: 'light' };
  const gadget = declarationsFor('.egd-resource-gadget', env);
  const button = declarationsFor('.egd-resource-gadget .egd-resource-button', env);
  const readout = declarationsFor('.egd-resource-readout', env);
  const disk = declarationsFor('.egd-resource-disk.egd-resource-unmeasured', env);
  assert.equal(gadget.width, 'max-content');
  assert.equal(button.display, 'inline-flex');
  assert.equal(readout['flex-direction'], 'column');
  assert.equal(disk.background, 'transparent');
  assert.match(disk.border, /solid var\(--egd-on-surface-variant\)/);
  assert.match(surfaceCss, /\.egd-rail-right \.egd-resource-gadget \{ display: grid; grid-template-columns: repeat\(2, max-content\)/);
  assert.match(surfaceCss, /\.egd-rail-right \{ flex: 0 1 auto; min-width: 0; overflow-x: auto;/);
});

test('Focus resource layout reserves unscaled space and keeps its details inside the viewport', () => {
  const focus = '.egd-browser-card.egd-card-fullscreen';
  assert.equal(declarationsFor(`${focus} .egd-resource-gadget`).zoom, 'calc(1 / var(--egd-camera-zoom, 1))');
  assert.equal(declarationsFor('.egd-resource-gadget').zoom, undefined, 'normal rail must not change scale');
  assert.equal(declarationsFor('.egd-browser-card .egd-desk-window-toolbar .egd-resource-button').font,
    '600 10px/1.05 var(--egd-font)', 'toolbar inheritance must not enlarge resource text');
  const detail = declarationsFor(`${focus} .egd-resource-detail`);
  assert.equal(detail['max-height'], 'max(100px, calc(100vh - 180px))');
  assert.equal(detail['overflow-y'], 'auto');
  assert.equal(detail['overscroll-behavior'], 'contain');
  const narrowToolbar = rulesFor(`${focus} .egd-desk-window-toolbar`).find(rule => rule.media.includes('(max-width: 700px)'));
  assert.ok(narrowToolbar, 'narrow Focus needs its own toolbar layout');
  assert.equal(new Map(narrowToolbar.declarations).get('grid-template-columns'), 'auto minmax(0, 1fr) auto auto');
  assert.equal(new Map(narrowToolbar.declarations).get('height'), 'auto');
  const narrowGadget = rulesFor(`${focus} .egd-resource-gadget`).find(rule => rule.media.includes('(max-width: 700px)'));
  assert.equal(new Map(narrowGadget.declarations).get('grid-column'), '1 / -1');
  assert.equal(new Map(narrowGadget.declarations).get('grid-row'), '2');
  const edge = declarationsFor(`${focus}:is(.egd-entity-active, .egd-entity-selected)`);
  assert.equal(edge['outline-offset'], 'calc(-2px / var(--egd-camera-zoom, 1))');
  assert.deepEqual(Object.keys(edge), ['outline-offset'], 'inset paint must not change world geometry');
  const paint = declarationsFor(`${focus}:is(.egd-entity-active, .egd-entity-selected)::after`);
  assert.equal(paint.border, 'calc(2px / var(--egd-camera-zoom, 1)) solid var(--egd-card-selection)');
  assert.equal(paint.inset, '0');
  assert.equal(paint.position, 'absolute');
  assert.equal(paint['pointer-events'], 'none', 'selection paint must not intercept toolbar or page input');
});
