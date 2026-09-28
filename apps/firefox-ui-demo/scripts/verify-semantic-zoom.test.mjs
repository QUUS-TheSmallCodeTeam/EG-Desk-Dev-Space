import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { OBSERVE } from './verify-semantic-zoom.mjs';

// Test the cooked strings sent to evaluateChrome, not merely the outer .mjs.
// The first live failure was a regex whose slash escapes vanished while its
// enclosing template literal was evaluated.
test('every emitted privileged function parses before Firefox is contacted', () => {
  const source = readFileSync(new URL('./verify-semantic-zoom.mjs', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/harness\.evaluateChrome\(/g)];
  assert.ok(calls.length >= 15, 'expected to cover the complete live QA flow');
  for (const call of calls) {
    const line = source.slice(0, call.index).split('\n').length;
    let start = call.index + call[0].length;
    while (/\s/.test(source[start])) start += 1;
    let emitted;
    if (source.startsWith('OBSERVE', start)) {
      emitted = OBSERVE;
    } else {
      assert.equal(source[start], '`', `uncovered evaluateChrome argument at line ${line}`);
      let end = start + 1;
      while (end < source.length) {
        if (source[end] === '`' && source[end - 1] !== '\\') break;
        end += 1;
      }
      assert.ok(end < source.length, `unterminated Chrome template at line ${line}`);
      const literal = source.slice(start, end + 1);
      emitted = Function('ids', 'chat', 'dataBrowserId', 'zoom', `return ${literal}`)(
        ['qa-browser-a', 'qa-browser-b', 'qa-browser-far'], 'qa-chat', 'qa-browser-b', 0.3,
      );
    }
    assert.match(emitted, /^\s*(?:async\s*)?\(\s*\)\s*=>/s, `not a callable Chrome function at line ${line}`);
    assert.doesNotThrow(() => Function(`return (${emitted})`), `invalid emitted Chrome function at line ${line}`);
    assert.ok(Buffer.byteLength(emitted, 'utf8') < 15 * 1024, `Chrome function too large at line ${line}`);
  }
});
