// DSN-03·04: the colour-contrast check and the token table the surface CSS is
// measured against. The CSS (overlay/CSS/eg-desk-surface.uc.css) stays the
// source of truth (D-G5 recommendation (가)); this module reads it, resolves
// var() and color-mix(), and checks foreground/background pairs.
//
// Patterns followed (rewritten here, not copied):
// - primer/primitives (MIT, https://github.com/primer/primitives) scripts/colorContrast.config.ts
//   and scripts/colorContrast.ts: [minimum, foreground, background, {bg}] requirement
//   rows, 4.5/3 default and 7/4.5 high-contrast ratios, semi-transparent colours
//   composited over canvas colours, ratios floored to two decimals.
// - Firefox design-system tokens (MPL-2.0, pattern only)
//   toolkit/themes/shared/design-system/dist/tokens-shared.css: one focus-outline
//   group, one disabled opacity, and overrides re-declared once under
//   prefers-contrast and forced-colors.
// Nothing here touches the DOM, so the surface, node tests and QA scripts can all
// import it.

export const CONTRAST_RATIOS = Object.freeze({
  default: Object.freeze({ text: 4.5, border: 3 }),
  more: Object.freeze({ text: 7, border: 4.5 }),
});

// Colours the system supplies in forced-colours / high-contrast mode.
export const SYSTEM_COLOR_KEYWORDS = Object.freeze([
  'AccentColor', 'AccentColorText', 'ActiveText', 'ButtonBorder', 'ButtonFace', 'ButtonText',
  'Canvas', 'CanvasText', 'Field', 'FieldText', 'GrayText', 'Highlight', 'HighlightText',
  'LinkText', 'Mark', 'MarkText', 'SelectedItem', 'SelectedItemText', 'VisitedText',
]);

const SURFACES = ['--egd-surface', '--egd-surface-elevated', '--egd-window-alt', '--egd-topbar'];

// Pairs every scheme must meet. A row with `todo` is a known shortfall that the
// named step will fix; tests report it without failing.
export const CONTRAST_REQUIREMENTS = Object.freeze([
  // Body and muted text on the main surfaces.
  ...SURFACES.map(bg => ['text', '--egd-on-surface', bg]),
  ['text', '--egd-on-surface', '--egd-hover'],
  ['text', '--egd-on-surface', '--egd-user-bubble'],
  ['text', '--egd-on-surface', '--egd-note'],
  ['text', '--egd-on-surface', '--egd-note-soft'],
  ['text', '--egd-on-surface', '--egd-primary-container'],
  ...SURFACES.map(bg => ['text', '--egd-on-surface-variant', bg]),
  ['text', '--egd-secondary', '--egd-surface-elevated'],
  // Accent text and the filled primary button.
  ['text', '--egd-primary', '--egd-surface'],
  ['text', '--egd-primary', '--egd-surface-elevated'],
  ['text', '--egd-on-primary', '--egd-primary'],
  // State inks.
  ['text', '--egd-danger-ink', '--egd-danger-bg'],
  ['text', '--egd-danger-ink', '--egd-surface-elevated'],
  ['text', '--egd-warning-ink', '--egd-surface-elevated'],
  ['text', '--egd-warning-ink', '--egd-note'],
  ['text', '--egd-success-ink', '--egd-success-bg'],
  ['text', '--egd-success-ink', '--egd-surface-elevated'],
  // Agent avatar initials (.egd-profile-avatar-tone-N rules).
  ['text', 'avatar.tone-0.color', 'avatar.tone-0.background'],
  ['text', 'avatar.tone-1.color', 'avatar.tone-1.background'],
  ['text', 'avatar.tone-2.color', 'avatar.tone-2.background', { todo: 'S1 아바타 대비 교정(D-G2)' }],
  ['text', 'avatar.tone-3.color', 'avatar.tone-3.background', { todo: 'S1 아바타 대비 교정(D-G2)' }],
  ['text', 'avatar.tone-4.color', 'avatar.tone-4.background'],
  ['text', 'avatar.tone-5.color', 'avatar.tone-5.background'],
  // Keyboard focus: 32 :focus-visible rules draw 2px var(--egd-primary).
  ['border', '--egd-primary', '--egd-surface'],
  ['border', '--egd-primary', '--egd-surface-elevated'],
  ['border', '--egd-primary', '--egd-window-alt'],
  // Search fields and selected rows draw --egd-focus-border instead.
  ['border', '--egd-focus-border', '--egd-surface-elevated', { todo: 'S5 포커스 토큰 통일' }],
  ['border', '--egd-focus-border', '--egd-window-alt', { todo: 'S5 포커스 토큰 통일' }],
]);

// prefers-contrast: more (macOS 대비 증가, Windows 고대비). Checked only when the
// CSS declares such a :root block; `optional` rows are skipped if the token is
// not declared yet.
export const MORE_CONTRAST_REQUIREMENTS = Object.freeze([
  ...SURFACES.map(bg => ['text', '--egd-on-surface', bg]),
  ...SURFACES.map(bg => ['text', '--egd-on-surface-variant', bg]),
  ['text', '--egd-secondary', '--egd-surface-elevated'],
  ['border', '--egd-outline', '--egd-surface'],
  ['border', '--egd-outline', '--egd-surface-elevated'],
  ['border', '--egd-line-strong', '--egd-surface-elevated'],
  ['border', '--egd-focus-outline-color', '--egd-surface', { optional: true }],
  ['border', '--egd-focus-outline-color', '--egd-surface-elevated', { optional: true }],
  ['border', '--egd-focus-border', '--egd-surface-elevated'],
]);

// [제안] Token table for S5. Names are EG-Desk's own; the grouping follows the
// Firefox tokens-shared.css focus-outline / opacity / prefers-contrast /
// forced-colors layout. S5 copies these into the CSS; tests then hold the CSS
// to MORE_CONTRAST_REQUIREMENTS.
export const STATE_TOKEN_TABLE = Object.freeze({
  base: Object.freeze({
    '--egd-focus-outline-width': '2px',
    '--egd-focus-outline-offset': '2px',
    '--egd-focus-outline-inset': 'calc(-1 * var(--egd-focus-outline-width))',
    '--egd-focus-outline-color': 'var(--egd-primary)',
    '--egd-focus-outline': 'var(--egd-focus-outline-width) solid var(--egd-focus-outline-color)',
    '--egd-opacity-disabled': '0.5',
  }),
  // D-G3 (가): stronger edges and muted text only when more contrast is asked for.
  prefersContrast: Object.freeze({
    '--egd-on-surface-variant': 'var(--egd-on-surface)',
    '--egd-secondary': 'var(--egd-on-surface)',
    '--egd-outline': 'var(--egd-on-surface-variant)',
    '--egd-outline-variant': 'var(--egd-on-surface-variant)',
    '--egd-line-strong': 'var(--egd-on-surface-variant)',
    '--egd-focus-border': 'var(--egd-on-surface)',
    '--egd-focus-outline-color': 'var(--egd-on-surface)',
    '--egd-opacity-disabled': '0.6',
  }),
  forcedColors: Object.freeze({
    '--egd-surface': 'Canvas',
    '--egd-surface-elevated': 'Canvas',
    '--egd-window-alt': 'Canvas',
    '--egd-topbar': 'Canvas',
    '--egd-on-surface': 'CanvasText',
    '--egd-on-surface-variant': 'CanvasText',
    '--egd-secondary': 'CanvasText',
    '--egd-outline': 'CanvasText',
    '--egd-outline-variant': 'CanvasText',
    '--egd-line-strong': 'CanvasText',
    '--egd-focus-border': 'CanvasText',
    '--egd-focus-outline-color': 'CanvasText',
    '--egd-primary': 'SelectedItem',
    '--egd-on-primary': 'SelectedItemText',
    '--egd-text-disabled': 'GrayText',
    '--egd-opacity-disabled': '1',
  }),
});

// ---------------------------------------------------------------- colours

const clamp01 = n => Math.min(1, Math.max(0, n));

function splitTopLevel(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(part => part !== '');
}

function functionArgs(text, name) {
  const lower = text.toLowerCase();
  if (!lower.startsWith(`${name}(`) || !text.endsWith(')')) return null;
  return text.slice(name.length + 1, -1);
}

function parseAlpha(token) {
  if (token == null) return 1;
  const value = token.trim();
  if (value.endsWith('%')) return clamp01(Number(value.slice(0, -1)) / 100);
  return clamp01(Number(value));
}

function parseChannel(token) {
  const value = token.trim();
  if (value.endsWith('%')) return Math.min(255, Math.max(0, Number(value.slice(0, -1)) * 2.55));
  return Math.min(255, Math.max(0, Number(value)));
}

/** Parses #hex, rgb()/rgba() (comma or space syntax) and `transparent`. */
export function parseColor(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (value.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map(d => d + d).join('');
    const n = i => parseInt(digits.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
  }
  const body = functionArgs(value, 'rgba') ?? functionArgs(value, 'rgb');
  if (body == null) return null;
  let parts;
  let alpha;
  if (body.includes(',')) {
    parts = body.split(',').map(part => part.trim());
    alpha = parts[3];
  } else {
    const [channels, slashAlpha] = body.split('/');
    parts = channels.trim().split(/\s+/);
    alpha = slashAlpha;
  }
  if (parts.length < 3) return null;
  const color = { r: parseChannel(parts[0]), g: parseChannel(parts[1]), b: parseChannel(parts[2]), a: parseAlpha(alpha) };
  return Object.values(color).every(Number.isFinite) ? color : null;
}

export function formatHex(color) {
  const hex = n => Math.round(n).toString(16).padStart(2, '0');
  const base = `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  return color.a >= 1 ? base.toUpperCase() : `${base}${hex(color.a * 255)}`.toUpperCase();
}

/** Source-over compositing of `fg` on `bg` (Primer getOpaqueColor). */
export function compositeOver(fg, bg) {
  if (fg.a >= 1) return { ...fg, a: 1 };
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = key => (fg[key] * fg.a + bg[key] * bg.a * (1 - fg.a)) / a;
  return { r: mix('r'), g: mix('g'), b: mix('b'), a };
}

/**
 * CSS color-mix(in srgb, A p1, B p2): missing percentages fill to 100, a sum
 * under 100 scales alpha, channels mix premultiplied.
 */
export function mixSrgb(first, firstPercent, second, secondPercent) {
  let p1 = firstPercent;
  let p2 = secondPercent;
  if (p1 == null && p2 == null) { p1 = 50; p2 = 50; } else if (p1 == null) p1 = 100 - p2;
  else if (p2 == null) p2 = 100 - p1;
  const sum = p1 + p2;
  if (sum <= 0) return null;
  const alphaScale = sum < 100 ? sum / 100 : 1;
  const w1 = p1 / sum;
  const w2 = p2 / sum;
  const a = first.a * w1 + second.a * w2;
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = key => (first[key] * first.a * w1 + second[key] * second.a * w2) / a;
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: a * alphaScale };
}

export function relativeLuminance(color) {
  const linear = channel => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/**
 * WCAG 2 contrast ratio floored to two decimals. A translucent background is
 * first laid on `canvas`; a translucent foreground on the result.
 */
export function contrastRatio(foreground, background, canvas = { r: 255, g: 255, b: 255, a: 1 }) {
  const bg = compositeOver(background, canvas);
  const fg = compositeOver(foreground, bg);
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x);
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

// ------------------------------------------------------------- CSS reading

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function matchingBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

function parseDeclarations(body) {
  const declarations = [];
  for (const chunk of splitTopLevel(body, ';')) {
    const colon = chunk.indexOf(':');
    if (colon <= 0) continue;
    declarations.push([chunk.slice(0, colon).trim(), chunk.slice(colon + 1).trim().replace(/\s*!important$/i, '')]);
  }
  return declarations;
}

/** Flat list of style rules with the @media preludes that wrap them. */
export function readCssRules(cssText) {
  const rules = [];
  const walk = (text, media) => {
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf('{', cursor);
      if (open < 0) break;
      const rawPrelude = text.slice(cursor, open);
      const prelude = rawPrelude.slice(rawPrelude.lastIndexOf(';') + 1).trim();
      const close = matchingBrace(text, open);
      if (close < 0) break;
      const body = text.slice(open + 1, close);
      if (/^@media\b/i.test(prelude)) walk(body, [...media, prelude.slice(6).trim()]);
      else if (/^@(supports|layer|-moz-document)\b/i.test(prelude)) walk(body, media);
      else if (!prelude.startsWith('@')) {
        rules.push({ selectors: splitTopLevel(prelude), media, declarations: parseDeclarations(body) });
      }
      cursor = close + 1;
    }
  };
  walk(stripComments(cssText), []);
  return rules;
}

/**
 * Whether every media prelude applies to `env` ({scheme, contrast, forcedColors}).
 * Unknown features (width, motion …) never apply, so they never feed tokens.
 */
export function mediaApplies(media, env = {}) {
  const scheme = env.scheme || 'light';
  const contrast = env.contrast || 'no-preference';
  const forced = env.forcedColors === true;
  return media.every(prelude => {
    const features = [...prelude.matchAll(/\(([^)]*)\)/g)].map(m => m[1].replace(/\s+/g, ' ').trim().toLowerCase());
    if (!features.length || /\b(not|or)\b|,/.test(prelude.replace(/\([^)]*\)/g, ''))) return false;
    return features.every(feature => {
      if (feature === 'prefers-color-scheme: dark') return scheme === 'dark';
      if (feature === 'prefers-color-scheme: light') return scheme === 'light';
      if (feature === 'prefers-contrast') return contrast !== 'no-preference' || forced;
      if (feature === 'prefers-contrast: more') return contrast === 'more';
      if (feature === 'prefers-contrast: no-preference') return contrast === 'no-preference' && !forced;
      if (feature === 'forced-colors' || feature === 'forced-colors: active') return forced;
      if (feature === 'forced-colors: none') return !forced;
      return false;
    });
  });
}

/** Raw custom-property values on `:root` for one environment, cascade order. */
export function readRootProperties(cssText, env = {}) {
  const props = Object.create(null);
  for (const rule of readCssRules(cssText)) {
    if (!rule.selectors.includes(':root') || !mediaApplies(rule.media, env)) continue;
    for (const [name, value] of rule.declarations) if (name.startsWith('--')) props[name] = value;
  }
  return props;
}

/** True when the CSS has a :root block that only applies under `env`. */
export function hasRootOverrides(cssText, env) {
  return readCssRules(cssText).some(rule => rule.selectors.includes(':root') && rule.media.length > 0
    && mediaApplies(rule.media, env) && !mediaApplies(rule.media, { scheme: env.scheme }));
}

/** background/color expressions of the `.egd-profile-avatar-tone-N` rules. */
export function readAvatarTones(cssText, env = {}) {
  const tones = new Map();
  for (const rule of readCssRules(cssText)) {
    if (!mediaApplies(rule.media, env)) continue;
    for (const selector of rule.selectors) {
      const match = /^\.egd-profile-avatar-tone-(\d+)$/.exec(selector);
      if (!match) continue;
      const tone = tones.get(match[1]) || {};
      for (const [name, value] of rule.declarations) {
        if (name === 'background' || name === 'background-color') tone.background = value;
        if (name === 'color') tone.color = value;
      }
      tones.set(match[1], tone);
    }
  }
  return [...tones].map(([tone, value]) => ({ tone: Number(tone), ...value })).sort((a, b) => a.tone - b.tone);
}

/** Resolves a colour expression against raw properties; null if it is not a fixed colour. */
export function resolveColor(expression, props, seen = new Set()) {
  if (typeof expression !== 'string') return null;
  const value = expression.trim();
  const varBody = functionArgs(value, 'var');
  if (varBody != null) {
    const [name, ...fallback] = splitTopLevel(varBody);
    if (seen.has(name)) return null;
    if (name in props) return resolveColor(props[name], props, new Set([...seen, name]));
    return fallback.length ? resolveColor(fallback.join(','), props, seen) : null;
  }
  const mixBody = functionArgs(value, 'color-mix');
  if (mixBody != null) {
    const [space, ...stops] = splitTopLevel(mixBody);
    if (space.replace(/\s+/g, ' ').toLowerCase() !== 'in srgb' || stops.length !== 2) return null;
    const parsed = stops.map(stop => {
      const match = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(stop.trim());
      return { color: resolveColor(match[1], props, seen), percent: match[2] == null ? null : Number(match[2]) };
    });
    if (parsed.some(stop => !stop.color)) return null;
    return mixSrgb(parsed[0].color, parsed[0].percent, parsed[1].color, parsed[1].percent);
  }
  return parseColor(value);
}

/**
 * Resolved colours for one environment: every `--*` property that is a fixed
 * colour, plus `avatar.tone-N.background` / `avatar.tone-N.color`.
 * `extra` overlays raw values (for checking STATE_TOKEN_TABLE before S5 lands).
 */
export function readSchemeColors(cssText, env = {}, extra = null) {
  const props = Object.assign(readRootProperties(cssText, env), extra || {});
  const colors = Object.create(null);
  for (const name of Object.keys(props)) {
    const color = resolveColor(props[name], props);
    if (color) colors[name] = color;
  }
  for (const tone of readAvatarTones(cssText, env)) {
    const background = resolveColor(tone.background, props);
    const color = resolveColor(tone.color, props);
    if (background) colors[`avatar.tone-${tone.tone}.background`] = background;
    if (color) colors[`avatar.tone-${tone.tone}.color`] = color;
  }
  return colors;
}

/**
 * Runs requirement rows against resolved colours. Translucent backgrounds are
 * checked on each canvas in options.bg (default surface and elevated surface).
 */
export function runContrastChecks(colors, requirements, { level = 'default', label = '' } = {}) {
  const ratios = CONTRAST_RATIOS[level];
  const rows = [];
  for (const [type, fgName, bgName, options = {}] of requirements) {
    const minimum = typeof type === 'number' ? type : ratios[type];
    const pair = `${fgName} vs ${bgName}`;
    const fg = colors[fgName];
    const bg = colors[bgName];
    if (!fg || !bg) {
      if (options.optional && !fg) continue;
      rows.push({ pair, scheme: label, minimum, ratio: null, pass: false, todo: options.todo || null, reason: `unresolved ${!fg ? fgName : bgName}` });
      continue;
    }
    const canvases = bg.a >= 1 ? [null] : (options.bg || ['--egd-surface', '--egd-surface-elevated']);
    for (const canvasName of canvases) {
      const canvas = canvasName ? colors[canvasName] : undefined;
      const ratio = contrastRatio(fg, bg, canvas);
      rows.push({
        pair: canvasName ? `${pair} on ${canvasName}` : pair,
        scheme: label, minimum, ratio, pass: ratio >= minimum, todo: options.todo || null,
        foreground: formatHex(fg), background: formatHex(bg),
      });
    }
  }
  return rows;
}

/** Light and dark default checks for the surface stylesheet. */
export function checkSurfaceContrast(cssText, requirements = CONTRAST_REQUIREMENTS, { contrast = 'no-preference', level = 'default', extra = null } = {}) {
  return ['light', 'dark'].flatMap(scheme => runContrastChecks(
    readSchemeColors(cssText, { scheme, contrast }, extra), requirements, { level, label: contrast === 'more' ? `${scheme}+more` : scheme }));
}

// ------------------------------------------------------------- scale audit

const tally = values => values.reduce((acc, value) => { acc[value] = (acc[value] || 0) + 1; return acc; }, Object.create(null));
const isLiteral = value => !/var\(|calc\(|inherit|initial|unset|revert/i.test(value);

/**
 * How many distinct values the surface uses for focus offsets, disabled
 * opacity, literal font sizes and literal radii (DSN-03 baseline; S5 aims for
 * one focus offset and one disabled opacity).
 */
export function auditCssScale(cssText) {
  const offsets = [];
  const opacities = [];
  const fontSizes = [];
  const radii = [];
  let focusVisibleRules = 0;
  for (const rule of readCssRules(cssText)) {
    const selectors = rule.selectors.join(',');
    const focus = selectors.includes(':focus-visible');
    const disabled = /:disabled|\[disabled\]|\[aria-disabled="?true"?\]/.test(selectors);
    if (focus) focusVisibleRules++;
    for (const [name, value] of rule.declarations) {
      if (focus && name === 'outline-offset') offsets.push(value);
      if (disabled && name === 'opacity') opacities.push(String(Number(value)));
      if (name === 'font-size' && isLiteral(value)) fontSizes.push(value);
      if (name === 'border-radius' && isLiteral(value)) radii.push(value);
    }
  }
  return {
    focusVisibleRules,
    focusOutlineOffsets: tally(offsets),
    disabledOpacities: tally(opacities),
    fontSizes: tally(fontSizes),
    borderRadii: tally(radii),
  };
}
