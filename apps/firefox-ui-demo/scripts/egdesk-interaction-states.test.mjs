// A30 / A34 (BRW-01, DSN-04): every button-like control shows the moment it is
// pressed and shows the same keyboard focus ring, without each class having to
// repeat the rule. The surface CSS stays the source of truth; this file reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compositeOver, contrastRatio, readCssRules, readRootProperties, resolveColor,
} from '../overlay/resources/EGDeskDesignTokens.sys.mjs';

const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const surfaceRules = readCssRules(surfaceCss);

const BUTTON_LIKE = ['button', 'summary', '[role="button"]', '[role="tab"]', '[role="menuitem"]',
  '[role="menuitemradio"]', '[role="menuitemcheckbox"]', '[role="option"]', '[role="switch"]'];

// Removes every balanced :where(...) group; what is left carries specificity.
function outsideWhere(selector) {
  let out = '';
  for (let i = 0; i < selector.length; i++) {
    if (selector.startsWith(':where(', i)) {
      let depth = 0;
      for (i += 6; i < selector.length; i++) {
        if (selector[i] === '(') depth++;
        else if (selector[i] === ')' && --depth === 0) break;
      }
    } else out += selector[i];
  }
  return out;
}
const isZeroSpecificity = selector => /^[\s>+~]*$/.test(outsideWhere(selector));
const declared = rule => Object.fromEntries(rule.declarations);
const globalRules = pseudo => surfaceRules.filter(rule => rule.media.length === 0
  && rule.selectors.every(selector => selector.includes(pseudo) && isZeroSpecificity(selector)));

test('outsideWhere keeps only what adds specificity', () => {
  assert.equal(isZeroSpecificity(':where(.a, #b) :where(button):where(:active)'), true);
  assert.equal(isZeroSpecificity(':where(.a) button:active'), false);
  assert.equal(isZeroSpecificity('.egd-dock-btn:active'), false);
});

test('A30 the pressed veil is one theme-independent token made from the text ink', () => {
  for (const scheme of ['light', 'dark']) {
    const root = readRootProperties(surfaceCss, { scheme });
    assert.match(root['--egd-pressed-veil'] || '', /^color-mix\(in srgb, var\(--egd-on-surface\) \d+%, transparent\)$/, scheme);
    const veil = resolveColor('var(--egd-pressed-veil)', root);
    assert.ok(veil && veil.a > 0 && veil.a < 0.2, `${scheme}: the veil stays a light wash`);
  }
  // Declared once: no per-theme override that a theme switch could miss.
  const declarations = surfaceRules.flatMap(rule => rule.declarations.filter(([name]) => name === '--egd-pressed-veil'));
  assert.equal(declarations.length, 1);
  const owner = surfaceRules.find(rule => rule.declarations.some(([name]) => name === '--egd-pressed-veil'));
  assert.deepEqual(owner.selectors, [':root', '.egd-ontology-card'], 'the always-light Ontology lens resolves its own veil');
  assert.equal(owner.media.length, 0);
});

test('A30 pressed is one visible step past hover and body text stays readable on it', () => {
  for (const scheme of ['light', 'dark']) {
    const root = readRootProperties(surfaceCss, { scheme });
    const veil = resolveColor('var(--egd-pressed-veil)', root);
    const ink = resolveColor('var(--egd-on-surface)', root);
    for (const token of ['--egd-hover', '--egd-surface-elevated', '--egd-window-alt', '--egd-primary-container']) {
      const base = resolveColor(`var(${token})`, root);
      const pressed = compositeOver(veil, base);
      assert.ok(contrastRatio(pressed, base) >= 1.1, `${scheme} ${token}: pressed must differ from the resting fill`);
      assert.ok(contrastRatio(ink, pressed) >= 4.5, `${scheme} ${token}: text on the pressed fill`);
    }
    // The filled primary button keeps its label readable while pressed.
    const primaryPressed = compositeOver(veil, resolveColor('var(--egd-primary)', root));
    assert.ok(contrastRatio(resolveColor('var(--egd-on-primary)', root), primaryPressed) >= 4.5, `${scheme} primary label`);
  }
});

test('A30 one zero-specificity rule presses every enabled button-like control', () => {
  const rules = globalRules(':active');
  assert.equal(rules.length, 1, 'exactly one global pressed rule');
  const [rule] = rules;
  assert.deepEqual(declared(rule), { 'background-image': 'linear-gradient(var(--egd-pressed-veil), var(--egd-pressed-veil))' });
  for (const selector of rule.selectors) {
    for (const kind of BUTTON_LIKE) assert.ok(selector.includes(kind), `${kind} in ${selector}`);
    assert.match(selector, /:where\(\[class\*="egd-"\], \[id\^="egd-"\]\)/, 'only EG-Desk controls, never Firefox chrome');
    assert.match(selector, /:not\(:disabled, \[disabled\], \[aria-disabled="true"\], \.egd-desk-window-control-disabled\)/);
    // Pressing an inner button must not also press the row that contains it.
    assert.match(selector, /:not\(:has\(:is\([^)]*\):active\)\)/);
  }
  // Own element and descendants of an EG-Desk container.
  assert.equal(rule.selectors.length, 2);
  // The veil sits above whatever fill the hover rule chose, so it needs to win
  // over class rules that reset the background shorthand.
  const source = surfaceCss.slice(surfaceCss.indexOf('--egd-pressed-veil), var(--egd-pressed-veil))'));
  assert.match(source, /^[^;]*\) !important;/);
});

test('A30 a control that fills itself with !important repeats the veil at its own weight', () => {
  // An !important class fill outranks the zero-weight rule, so such a control
  // would otherwise show nothing while pressed.
  const veil = 'background-image: linear-gradient(var(--egd-pressed-veil), var(--egd-pressed-veil)) !important;';
  const owners = [...surfaceCss.matchAll(/^(\.egd-[\w-]+):hover \{[^}]*background: [^;}]*!important/gm)].map(match => match[1]);
  assert.deepEqual(owners, ['.egd-codex-result-chip'], 'a new !important hover fill needs its own pressed rule and an entry here');
  for (const owner of owners) assert.ok(surfaceCss.includes(`${owner}:active:not(:disabled) { ${veil} }`), owner);
});

test('A30 pressing never changes size or position', () => {
  for (const rule of surfaceRules) {
    if (!rule.selectors.some(selector => /:active\b/.test(selector))) continue;
    for (const [name] of rule.declarations) {
      assert.doesNotMatch(name, /^(transform|scale|translate|width|height|padding|margin)/, rule.selectors.join(', '));
    }
  }
});

test('A34 one zero-specificity rule gives every button-like control the shared focus ring', () => {
  const rules = globalRules(':focus-visible');
  assert.equal(rules.length, 1, 'exactly one global focus fallback');
  const [rule] = rules;
  assert.deepEqual(declared(rule), {
    outline: 'var(--egd-focus-outline)',
    'outline-offset': 'var(--egd-focus-outline-offset)',
  });
  assert.equal(rule.selectors.length, 2);
  for (const selector of rule.selectors) {
    for (const kind of [...BUTTON_LIKE, 'a[href]', '[role="radio"]']) assert.ok(selector.includes(kind), `${kind} in ${selector}`);
    assert.match(selector, /:where\(\[class\*="egd-"\], \[id\^="egd-"\]\)/);
  }
});

const A34_CONTROLS = [
  '.egd-agenda-close-btn', '.egd-agenda-switch-row-action', '.egd-agenda-switch-filter',
  '.egd-minimap-close', '.egd-settings-tab', '.egd-rail-search-result',
  '.egd-browser-site-ask-allow', '.egd-browser-site-ask-refuse',
];

test('A34 the audited controls exist and nothing switches their focus ring off', () => {
  for (const control of A34_CONTROLS) {
    const own = surfaceRules.filter(rule => rule.selectors.some(selector => selector === control
      || selector.startsWith(`${control}:`) || selector.startsWith(`${control}-`) || selector.startsWith(`${control}.`)));
    assert.ok(own.length > 0, `lost ${control}`);
    for (const rule of own) {
      const { outline } = declared(rule);
      assert.ok(outline === undefined || outline === 'var(--egd-focus-outline)', `${rule.selectors.join(', ')} outline: ${outline}`);
    }
  }
});

test('A34 full-width search results keep the ring inside their scrolling list', () => {
  const rule = surfaceRules.find(candidate => candidate.selectors.includes('.egd-rail-search-result:focus-visible'));
  assert.ok(rule, 'search results need their own inset ring');
  assert.deepEqual(declared(rule), {
    '--egd-focus-outline-offset': 'var(--egd-focus-outline-inset)',
    outline: 'var(--egd-focus-outline)',
    'outline-offset': 'var(--egd-focus-outline-offset)',
  });
});
