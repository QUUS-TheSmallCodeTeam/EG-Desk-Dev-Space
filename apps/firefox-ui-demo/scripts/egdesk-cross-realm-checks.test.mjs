import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The window (eg-desk-surface.uc.js) and the modules it imports with plain
// ChromeUtils.importESModule run in two JS globals: Firefox's shared module
// global and the browser window. A Set, Map or typed array made on one side
// fails `instanceof` on the other, so a shared module that checks a caller's
// value that way silently treats it as missing (the D25 site grant, the
// briefing "이어보기" memory). Use a check that reads the internal slot (an
// intrinsic getter such as Map.prototype.size, see EGDeskBriefingState), or
// Array.isArray, instead. The rows below were reviewed one by one
// (reports/l7-a1.md); a new built-in `instanceof` in a shared module needs
// the same review before it is added here. Counts are ceilings: removing one
// never fails this test.
const resources = path.join(path.dirname(fileURLToPath(import.meta.url)), '../overlay/resources');
const BUILTIN = /\binstanceof\s+(Set|Map|WeakMap|WeakSet|Array|Promise|Error|TypeError|RangeError|Date|RegExp|ArrayBuffer|SharedArrayBuffer|DataView|Int8Array|Uint8Array|Uint8ClampedArray|Int16Array|Uint16Array|Int32Array|Uint32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array)\b/g;
const REVIEWED = {
  // L6 a1 is replacing these with a realm-independent read (D25).
  'EGDeskBrowserGrant.sys.mjs': { Set: 3 },
  // pruneSiteDefaults has no caller outside its own tests yet; a window Set
  // would prune every remembered container, so wire it with a slot check.
  'EGDeskBrowserAccountContext.sys.mjs': { Set: 1 },
  // The only window caller of snapCanvasRect passes no excludeIds.
  'EGDeskCanvasLayout.sys.mjs': { Set: 1 },
  // bytesToBase64 copies a foreign Uint8Array instead of reusing it: same bytes.
  'EGDeskPortableState.sys.mjs': { Uint8Array: 1 },
  // Every byte array here comes from this module's own globalThis.crypto,
  // IOUtils and Sqlite.sys.mjs, never from the window.
  'EGDeskBrowserCookieImport.sys.mjs': { Uint8Array: 4 },
};

function moduleFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'vendor') return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return moduleFiles(full);
    return /\.m?js$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

function builtinChecks(file) {
  const counts = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
    for (const match of code.matchAll(BUILTIN)) counts[match[1]] = (counts[match[1]] || 0) + 1;
  }
  return counts;
}

test('shared modules check a caller value of a built-in type only where that was reviewed for the window\'s other global', () => {
  const unreviewed = [];
  for (const file of moduleFiles(resources)) {
    const name = path.relative(resources, file);
    for (const [type, count] of Object.entries(builtinChecks(file))) {
      const allowed = REVIEWED[name]?.[type] ?? 0;
      if (count > allowed) unreviewed.push(`${name}: instanceof ${type} x${count} (reviewed ${allowed})`);
    }
  }
  assert.deepEqual(unreviewed, []);
});

test('the briefing resume memory no longer depends on the Map constructor of its own global', () => {
  assert.deepEqual(builtinChecks(path.join(resources, 'EGDeskBriefingState.sys.mjs')), {});
});
