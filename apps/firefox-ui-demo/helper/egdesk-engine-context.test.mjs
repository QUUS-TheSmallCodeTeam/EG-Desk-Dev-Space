import test from 'node:test'
import assert from 'node:assert/strict'
import { emulateSpill, engineContextConfig, entryUnits, spilledKeys, splitEngineContext } from './egdesk-engine-context.mjs'

const item = (id, text) => `[item id=ontology:${id} kind=timeline time=past status=done]\n${text}`
const entry = (units, extra = {}) => ({ kind: 'application', value: ['Preamble line one.\nLine two.', ...units].join('\n\n'), ...extra })
const pages = n => Array.from({ length: n }, (_, i) => item(`p${i}`, `P${i}-first ` + 'x'.repeat(900) + ` P${i}-last`))

test('config: only the exact modes; the limit has a floor and a default', () => {
  assert.equal(engineContextConfig({}), null); assert.equal(engineContextConfig({ engineContext: 'on' }), null)
  assert.deepEqual(engineContextConfig({ engineContext: 'split' }), { mode: 'split', chars: 2000 })
  assert.deepEqual(engineContextConfig({ engineContext: 'mark', engineChars: 3000 }), { mode: 'mark', chars: 3000 })
  assert.deepEqual(engineContextConfig({ engineContext: 'split', engineChars: 50 }), { mode: 'split', chars: 2000 }, 'a limit under the floor is ignored')
})

test('split: an entry over the limit becomes ordered parts at item boundaries; nothing is dropped, reworded or duplicated; small and untrusted entries are untouched', () => {
  const big = entry(pages(5)), small = { kind: 'application', value: 'short' }, untrusted = { kind: 'untrusted', name: 'x', value: 'y'.repeat(5000) }
  const input = { first: small, egdesk_decision_context: big, last: untrusted }
  const { context, parts, oversize } = splitEngineContext(input, { limit: 2100 })
  assert.deepEqual(Object.keys(context), ['first', 'egdesk_decision_context', 'egdesk_decision_context_part2', 'egdesk_decision_context_part3', 'egdesk_decision_context_part4', 'last'].slice(0, Object.keys(context).length))
  assert.deepEqual(oversize, []); assert.equal(context.first, small); assert.equal(context.last, untrusted)
  assert.deepEqual(parts.egdesk_decision_context, Object.keys(context).filter(k => k.startsWith('egdesk_decision_context')))
  for (const [key, e] of Object.entries(context)) if (key !== 'last') assert.ok(e.value.length <= 2100, `${key} ${e.value.length}`)
  const joined = Object.entries(context).filter(([k]) => k.startsWith('egdesk_decision_context')).map(([, e]) => e.value.replace(/^EG-Desk context, continued[^\n]*\n\n/, '')).join('\n\n')
  assert.equal(joined, big.value, 'the parts together are the entry, byte for byte (minus the continuation line)')
  for (let i = 0; i < 5; i++) assert.equal(joined.split(`P${i}-first`).length - 1, 1)
})

test('split: what fits is returned as it was (same object); one unit longer than the limit stays alone and is reported', () => {
  const fits = { k: entry(pages(1)) }
  assert.equal(splitEngineContext(fits, { limit: 5000 }).context.k, fits.k)
  const huge = { k: entry([item('big', 'y'.repeat(3000)), ...pages(1)]) }
  const { context, oversize } = splitEngineContext(huge, { limit: 2000 })
  assert.deepEqual(oversize, ['k_part2']); assert.ok(Object.values(context).some(e => e.value.includes('y'.repeat(3000))))
  assert.deepEqual(splitEngineContext(undefined, { limit: 2000 }), { context: undefined, parts: {}, oversize: [] })
})

test('spilledKeys and the engine double: an over-limit entry keeps head and tail and loses the middle; split parts each arrive whole, so every fact is visible; per-total scope shows what a total limit would do', () => {
  const ctx = { egdesk_decision_context: entry(pages(5)) }, limit = 2100
  assert.deepEqual(spilledKeys(ctx, { limit }), ['egdesk_decision_context'])
  const cut = emulateSpill(ctx, { limit })
  assert.deepEqual(cut.spilled, ['egdesk_decision_context'])
  const seen = Object.values(cut.visible).join('\n'), lost = [0, 1, 2, 3, 4].filter(i => !seen.includes(`P${i}-last`))
  assert.ok(lost.length >= 3, 'the middle pages lose their last sentences')
  const { context } = splitEngineContext(ctx, { limit }), whole = emulateSpill(context, { limit })
  assert.deepEqual(whole.spilled, [])
  const all = Object.values(whole.visible).join('\n')
  for (let i = 0; i < 5; i++) { assert.ok(all.includes(`P${i}-first`) && all.includes(`P${i}-last`)) }
  assert.ok(emulateSpill(context, { limit, scope: 'total' }).spilled.length > 0, 'a total limit would still cut the sum of the parts')
  assert.equal(entryUnits('a\n\n[item id=x]\nb\n\n[page id=y]\nc').length, 3)
})
