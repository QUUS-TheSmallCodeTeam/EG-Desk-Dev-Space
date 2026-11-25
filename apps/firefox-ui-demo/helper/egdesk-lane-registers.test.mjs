// c33: the real-engine registrations and the committed-plan register are one module per lane (helper/real-engine-registrations/L<n>.mjs, helper/committed-plans/L<n>.mjs) so that two lanes never edit
// the same lines. This test pins the structure, not the content: a lane adding a key or a plan edits only its own file and no line here.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMITTED_PLANS } from './egdesk-committed-plans.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), LANES = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']
const read = f => fs.readFileSync(path.join(here, f), 'utf8')

test('the registrations index imports every lane module once, in the fixed order (memory before journey, rewrite before planted), and registers nothing itself', () => {
  const text = read('egdesk-real-engine-registrations.mjs')
  const imports = [...text.matchAll(/^import '\.\/real-engine-registrations\/(L\d)\.mjs'$/gm)].map(m => m[1])
  assert.deepEqual(imports, ['L1', 'L7', 'L2', 'L6', 'L3', 'L4', 'L8', 'L5'], 'fixed registration order: L7 (memory) before L2 (journey, rewrite), L2 before L6 (planted)')
  assert.deepEqual([...imports].sort(), LANES, 'each lane exactly once')
  assert.doesNotMatch(text.replace(/^\/\/.*$/gm, ''), /register[A-Z]\w*\(/, 'no registration in the index')
})

test('a lane registration module imports only the extension API and its own helpers, never another lane\'s registration module', () => {
  for (const lane of LANES) {
    const text = read(`real-engine-registrations/${lane}.mjs`)
    assert.match(text, /^import \{[^}]+\} from '\.\.\/egdesk-real-engine-extensions\.mjs'$/m, `${lane}: the extension API`)
    assert.doesNotMatch(text, /real-engine-registrations\//, `${lane}: no other lane module`)
    for (const m of text.matchAll(/from '(\.[^']+)'/g)) assert.match(m[1], /^\.\.\/egdesk-/, `${lane}: ${m[1]} is a helper (../egdesk-…)`)
  }
})

test('the committed-plan register is the concatenation of one list per lane: every entry sits in its own lane\'s file, no path twice, and the lane files are the only source', async () => {
  const seen = new Map()
  for (const lane of LANES) {
    const mod = await import(`./committed-plans/${lane}.mjs`), list = mod[`PLANS_${lane}`]
    assert.ok(Array.isArray(list) && list.length, `${lane}: PLANS_${lane}`)
    for (const e of list) { assert.equal(e.lane, lane, `${e.path}: in ${lane}.mjs but lane ${e.lane}`); assert.ok(!seen.has(e.path), `${e.path} twice`); seen.set(e.path, e) }
  }
  assert.deepEqual(COMMITTED_PLANS.map(e => e.path), [...seen.keys()], 'the register is the lane lists in lane order')
  assert.doesNotMatch(read('egdesk-committed-plans.mjs'), /\{ path: /, 'no entry is written in the register file itself')
})
