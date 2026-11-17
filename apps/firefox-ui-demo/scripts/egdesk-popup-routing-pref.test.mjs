import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const src = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const start = src.indexOf('  function popupRestrictionPlan(');
const end = src.indexOf('  function applyPopupRestrictionPlan(');
assert.ok(start > 0 && end > start);
const { popupRestrictionPlan } = runInNewContext(`${src.slice(start, end)}\n({ popupRestrictionPlan })`);

test('default restriction 2 is lowered to 0 so sized popups reach browserDOMWindow', () => {
  assert.deepEqual({ ...popupRestrictionPlan({ hasUserValue: false, defaultValue: 2 }) },
    { name: 'browser.link.open_newwindow.restriction', value: 0 });
});
test('no change when already 0, user-set, or state missing', () => {
  assert.equal(popupRestrictionPlan({ hasUserValue: false, defaultValue: 0 }), null);
  assert.equal(popupRestrictionPlan({ hasUserValue: true, defaultValue: 2 }), null);
  assert.equal(popupRestrictionPlan(null), null);
});
test('installPopupCapture applies the plan', () => {
  assert.match(src, /function installPopupCapture\(\) \{\n    applyPopupRestrictionPlan\(\);/);
});
