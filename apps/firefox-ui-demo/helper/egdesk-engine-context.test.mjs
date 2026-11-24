import test from 'node:test'
import assert from 'node:assert/strict'
import { emulateSpill, engineContextConfig, entryUnits, spilledKeys, splitEngineContext } from './egdesk-engine-context.mjs'

const bytes = text => Buffer.byteLength(text, 'utf8')
const item = (id, text) => `[item id=ontology:${id} kind=timeline time=past status=done]\n${text}`
const entry = (units, extra = {}) => ({ kind: 'application', value: ['Preamble line one.\nLine two.', ...units].join('\n\n'), ...extra })
const pages = (n, filler = 'x'.repeat(900)) => Array.from({ length: n }, (_, i) => item(`p${i}`, `P${i}-first ` + filler + ` P${i}-last`))
const sentences = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i} 담당자는 작업 내용을 정리하고 같은 날 안에 팀 대화방에 알린다.`).join(' ')
const stripContinued = value => value.replace(/^EG-Desk context, continued[^\n]*\n\n/, '')

test('config: only the exact modes; bytes default 4000 with a floor; chars is only an extra cap', () => {
  assert.equal(engineContextConfig({}), null); assert.equal(engineContextConfig({ engineContext: 'on' }), null)
  assert.deepEqual(engineContextConfig({ engineContext: 'split' }), { mode: 'split', bytes: 4000, chars: null })
  assert.deepEqual(engineContextConfig({ engineContext: 'mark', engineBytes: 3000, engineChars: 2000 }), { mode: 'mark', bytes: 3000, chars: 2000 })
  assert.deepEqual(engineContextConfig({ engineContext: 'split', engineBytes: 50, engineChars: 50 }), { mode: 'split', bytes: 4000, chars: null }, 'under the floors: ignored')
})

test('split: an entry over the limit becomes ordered parts at item boundaries; nothing dropped, reworded or duplicated; small and untrusted entries untouched; bytes, not characters, are measured', () => {
  const big = entry(pages(5)), small = { kind: 'application', value: 'short' }, untrusted = { kind: 'untrusted', name: 'x', value: 'y'.repeat(9000) }
  const input = { first: small, egdesk_decision_context: big, last: untrusted }
  const { context, parts, oversize } = splitEngineContext(input, { limit: { bytes: 2100 } })
  assert.deepEqual(oversize, []); assert.equal(context.first, small); assert.equal(context.last, untrusted)
  const names = Object.keys(context).filter(k => k.startsWith('egdesk_decision_context'))
  assert.equal(names[0], 'egdesk_decision_context'); assert.deepEqual(parts.egdesk_decision_context, names); assert.ok(names.length >= 3)
  assert.deepEqual(Object.keys(context), ['first', ...names, 'last'], 'the parts stand where the entry stood')
  for (const key of names) assert.ok(bytes(context[key].value) <= 2100, `${key} ${bytes(context[key].value)}`)
  assert.equal(names.map(k => stripContinued(context[k].value)).join('\n\n'), big.value, 'the parts together are the entry, byte for byte (minus the continuation line)')
  // Korean: 3 bytes a character; 1,500 characters is over 4,000 bytes although under any character limit of 2,000
  const korean = { kind: 'application', value: '가'.repeat(1500) }
  assert.deepEqual(spilledKeys({ k: korean }, { limit: { bytes: 4000 } }), ['k']); assert.deepEqual(spilledKeys({ k: korean }, { limit: { bytes: 6000 } }), [])
})

test('split: one item longer than the limit is cut inside the item at sentence boundaries; every sentence appears once, in order, the later chunks say what they continue', () => {
  const long = item('long', sentences(60, 'S')), ctx = { k: entry([long, ...pages(1)]) }
  const { context, oversize } = splitEngineContext(ctx, { limit: { bytes: 2000 } })
  assert.deepEqual(oversize, [])
  const names = Object.keys(context); assert.ok(names.length >= 4)
  for (const key of names) assert.ok(bytes(context[key].value) <= 2000, `${key} ${bytes(context[key].value)}`)
  const all = names.map(k => context[k].value).join('\n')
  for (let i = 0; i < 60; i++) assert.equal(all.split(`S${i} `).length - 1, 1, `S${i} once`)
  assert.ok([...all.matchAll(/S(\d+) /g)].map(m => Number(m[1])).every((n, i, a) => i === 0 || n > a[i - 1]), 'in order')
  assert.equal([...all.matchAll(/\(continued: item id=ontology:long, part \d+ of \d+\)/g)].length >= 2, true)
  assert.equal(all.split('[item id=ontology:long').length - 1, 1, 'the item header appears once (continuations are not items)')
  assert.ok(all.includes('P0-first') && all.includes('P0-last'))
  const hard = { k: { kind: 'application', value: '가'.repeat(5000) } }  // no boundary at all: cut by characters
  const cut = splitEngineContext(hard, { limit: { bytes: 2000 } })
  assert.deepEqual(cut.oversize, []); assert.equal(Object.values(cut.context).map(e => stripContinued(e.value).replace(/^\(continued:[^\n]*\n/, '')).join('').length >= 5000, true)
})

test('what fits is the same entry object; undefined passes through', () => {
  const fits = { k: entry(pages(1)) }, out = splitEngineContext(fits, { limit: { bytes: 5000 } })
  assert.equal(out.context.k, fits.k); assert.deepEqual(out.parts, {})
  assert.deepEqual(splitEngineContext(undefined, { limit: { bytes: 2000 } }), { context: undefined, parts: {}, oversize: [] })
})

test('the engine double: an over-limit entry keeps head and tail and loses the middle; split parts arrive whole; a total limit would still cut the sum', () => {
  const ctx = { egdesk_decision_context: entry(pages(5)) }, limit = { bytes: 2100 }
  assert.deepEqual(spilledKeys(ctx, { limit }), ['egdesk_decision_context'])
  const cut = emulateSpill(ctx, { limit })
  assert.deepEqual(cut.spilled, ['egdesk_decision_context'])
  const seen = Object.values(cut.visible).join('\n')
  assert.ok([0, 1, 2, 3, 4].filter(i => !seen.includes(`P${i}-last`)).length >= 3, 'the middle pages lose their last sentences')
  const { context } = splitEngineContext(ctx, { limit }), whole = emulateSpill(context, { limit })
  assert.deepEqual(whole.spilled, [])
  const all = Object.values(whole.visible).join('\n')
  for (let i = 0; i < 5; i++) assert.ok(all.includes(`P${i}-first`) && all.includes(`P${i}-last`))
  assert.ok(emulateSpill(context, { limit, scope: 'total' }).spilled.length > 0)
  assert.equal(entryUnits('a\n\n[item id=x]\nb\n\n[page id=y]\nc').length, 3)
})
