import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_CATALOG_LIMIT, MODEL_CATALOG_METHOD, assertModelSelection, createModelCatalogSync,
  publicCodexModel, publicModelRow, publicModelRows, readCodexModelCatalog,
} from './codex-model-catalog.mjs'

const ROW_KEYS = ['id', 'displayName', 'isDefault', 'supportedEfforts', 'defaultEffort']

// A Model as codex 0.162.1 model/list returns it: every key of
// v2/ModelListResponse.json Model (egdesk-native-capabilities.test.mjs checks the
// generated schema still has id, model and the reasoning-effort fields).
function nativeModel(slug, { hidden = false, isDefault = false, efforts = ['low', 'medium', 'high'], defaultEffort = 'medium', displayName = slug.toUpperCase(), id = slug } = {}) {
  return {
    id, model: slug, displayName, description: `PRIVATE description of ${slug}`, hidden, isDefault,
    supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: `PRIVATE ${reasoningEffort} copy` })),
    defaultReasoningEffort: defaultEffort, upgrade: 'PRIVATE-upgrade', upgradeInfo: { model: 'PRIVATE-next', upgradeCopy: 'PRIVATE copy', modelLink: 'https://private.example' },
    availabilityNux: { message: 'PRIVATE nux' }, availableAccessPrograms: { cyber: ['standard'] }, additionalSpeedTiers: ['fast'],
    serviceTiers: [{ id: 'PRIVATE-tier', name: 'Tier', description: 'PRIVATE' }], defaultServiceTier: 'PRIVATE-tier',
    inputModalities: ['text', 'image'], modelSpecialty: null, multiAgentVersion: 'v2', supportsPersonality: false,
  }
}

// model/list pages over a fixed catalog; records every params object.
function pagedServer(models, { pageSize = 2, fail = null } = {}) {
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (fail && fail(calls.length)) throw new Error('model/list failed /Users/me/.codex')
    const visible = params.includeHidden ? models : models.filter(model => !model.hidden)
    const start = params.cursor ? Number(params.cursor.slice(5)) : 0
    const size = Math.min(pageSize, params.limit ?? pageSize)
    const end = start + size
    return { data: visible.slice(start, end), nextCursor: end < visible.length ? `page:${end}` : null }
  }
  return { request, calls }
}

test('a public model row carries only id, name, default flag and the efforts the model lists', () => {
  const row = publicCodexModel(nativeModel('gpt-6.1-sol', { isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', displayName: 'GPT-6.1-Sol' }))
  assert.deepEqual(row, { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' })
  assert.deepEqual(Object.keys(row), ROW_KEYS)
  assert.equal(JSON.stringify(row).includes('PRIVATE'), false)
  // Hidden models stay out even if a page returns them.
  assert.equal(publicCodexModel(nativeModel('gpt-reserve', { hidden: true })), null)
  // id is the model slug turn/start accepts, falling back to id only when the slug is unusable.
  assert.equal(publicCodexModel(nativeModel('gpt-x', { id: 'gpt-x-preset' })).id, 'gpt-x')
  assert.equal(publicCodexModel({ ...nativeModel('ignored'), model: '../../etc' , id: 'gpt-safe' }).id, 'gpt-safe')
  for (const bad of [null, [], 'gpt', { ...nativeModel('x'), model: '', id: '' }, { ...nativeModel('x'), model: ' spaced', id: '__proto__' }]) assert.equal(publicCodexModel(bad), null)
  // Efforts: short tokens, unique, bounded; the default only when listed.
  const odd = publicCodexModel(nativeModel('gpt-odd', { efforts: ['low', 'low', 'HIGH', '', 'medium; rm -rf', 'medium', 7], defaultEffort: 'high' }))
  assert.deepEqual(odd.supportedEfforts, ['low', 'medium'])
  assert.equal(odd.defaultEffort, null)
  assert.equal(publicCodexModel(nativeModel('gpt-none', { efforts: [], defaultEffort: 'medium' })).defaultEffort, null)
  assert.equal(publicCodexModel(nativeModel('gpt-many', { efforts: Array.from({ length: 40 }, (_, i) => `e${i}`) })).supportedEfforts.length, 16)
  // Names are bounded public text; a missing name shows the id.
  assert.equal(publicCodexModel(nativeModel('gpt-n', { displayName: 'x'.repeat(500) })).displayName.length, 80)
  assert.equal(publicCodexModel(nativeModel('gpt-n', { displayName: '   ' })).displayName, 'gpt-n')
  assert.equal(publicCodexModel(nativeModel('gpt-k', { displayName: 'Key sk-PRIVATESECRET123' })).displayName.includes('sk-PRIVATE'), false)
})

test('public rows are unique, bounded, keep one default, and an empty list is unknown rather than []', () => {
  const rows = publicModelRows([
    { id: 'a', displayName: 'A', isDefault: true, supportedEfforts: ['low'], defaultEffort: 'low', description: 'PRIVATE' },
    { id: 'a', displayName: 'A again', isDefault: false, supportedEfforts: [], defaultEffort: null },
    { id: 'b', displayName: 'B', isDefault: true, supportedEfforts: ['high'], defaultEffort: 'high' },
    { id: '', displayName: 'nameless' }, null,
  ])
  assert.deepEqual(rows.map(row => [row.id, row.isDefault]), [['a', true], ['b', false]])
  assert.equal(JSON.stringify(rows).includes('PRIVATE'), false)
  assert.equal(publicModelRows([]), null)
  assert.equal(publicModelRows([{ id: '' }]), null)
  assert.equal(publicModelRows(null), null)
  assert.equal(publicModelRows({ a: 1 }), null)
  assert.equal(publicModelRows(Array.from({ length: 80 }, (_, i) => ({ id: `m${i}` }))).length, MODEL_CATALOG_LIMIT)
  assert.deepEqual(publicModelRow({ id: 'c' }), { id: 'c', displayName: 'c', isDefault: false, supportedEfforts: [], defaultEffort: null })
})

test('model/list is read page by page without hidden models, up to 50 rows, and any failed page makes it unknown', async () => {
  const catalog = [
    nativeModel('gpt-6.1-sol', { isDefault: true }), nativeModel('gpt-6-astra'), nativeModel('gpt-6-sol'),
    nativeModel('gpt-reserve', { hidden: true }), nativeModel('gpt-6-luna'), nativeModel('codex-auto-review', { hidden: true }),
  ]
  const server = pagedServer(catalog)
  const rows = await readCodexModelCatalog(server.request)
  assert.deepEqual(rows.map(row => row.id), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])
  assert.deepEqual(server.calls.map(([method, params]) => [method, params.cursor, params.includeHidden, params.limit]), [
    [MODEL_CATALOG_METHOD, null, false, 50], [MODEL_CATALOG_METHOD, 'page:2', false, 48],
  ])
  // A server that ignores includeHidden still cannot publish a hidden model.
  const leaky = await readCodexModelCatalog(async () => ({ data: catalog, nextCursor: null }))
  assert.deepEqual(leaky.map(row => row.id), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])
  // Bounded rows and pages; a repeated cursor stops the loop.
  const many = pagedServer(Array.from({ length: 120 }, (_, i) => nativeModel(`m-${i}`)), { pageSize: 7 })
  assert.equal((await readCodexModelCatalog(many.request)).length, 50)
  assert.equal(many.calls.at(-1)[1].limit, 1)
  let loops = 0
  const looping = await readCodexModelCatalog(async () => { loops += 1; return { data: [nativeModel(`loop-${loops}`)], nextCursor: 'same' } })
  assert.deepEqual(looping.map(row => row.id), ['loop-1', 'loop-2'])
  let pages = 0
  await readCodexModelCatalog(async () => { pages += 1; return { data: [nativeModel(`p-${pages}`)], nextCursor: `c-${pages}` } })
  assert.equal(pages, 10)
  // Unknown, never partial, empty or invented.
  assert.equal(await readCodexModelCatalog(pagedServer(catalog, { fail: call => call === 2 }).request), null)
  assert.equal(await readCodexModelCatalog(async () => { throw new Error('offline') }), null)
  assert.equal(await readCodexModelCatalog(() => { throw new Error('sync offline') }), null)
  for (const answer of [null, {}, { data: 'x' }, { data: [] }, { data: [nativeModel('h', { hidden: true })] }]) {
    assert.equal(await readCodexModelCatalog(async () => answer), null, JSON.stringify(answer))
  }
})

test('the catalog follows the account: read on refresh, coalesced, dropped after an account change or reset, unknown on failure', async () => {
  let owner = 'email:a@example.com', ready = true
  const changes = []
  const releases = []
  const sync = createModelCatalogSync({
    request: null, ready: () => ready, identity: () => owner, onChange: rows => changes.push(rows && rows.map(row => row.id)),
    read: () => new Promise(resolve => releases.push(resolve)),
  })
  assert.equal(sync.snapshot(), null)
  const first = sync.refresh()
  assert.equal(sync.refresh(), first, 'one read per account at a time')
  releases.shift()([{ id: 'gpt-a', supportedEfforts: ['low'] }])
  assert.deepEqual((await first).map(row => row.id), ['gpt-a'])
  assert.deepEqual(changes, [['gpt-a']])
  // Snapshots are copies.
  sync.snapshot()[0].supportedEfforts.push('ultra')
  assert.deepEqual(sync.snapshot()[0].supportedEfforts, ['low'])
  // Account change: the old list is forgotten at once; a read for the old account is dropped.
  const stale = sync.refresh()
  owner = 'email:b@example.com'
  const fresh = sync.refresh({ clear: true })
  assert.equal(sync.snapshot(), null)
  releases.shift()([{ id: 'gpt-old-account' }])
  releases.shift()([{ id: 'gpt-b' }])
  await Promise.all([stale, fresh])
  assert.deepEqual(sync.snapshot().map(row => row.id), ['gpt-b'])
  assert.deepEqual(changes, [['gpt-a'], null, ['gpt-b']])
  // Disconnect: reset makes it unknown and a read in flight cannot bring it back.
  const pending = sync.refresh()
  sync.reset()
  releases.shift()([{ id: 'gpt-late' }])
  assert.equal(await pending, null)
  assert.equal(sync.snapshot(), null)
  // A failed read is unknown; not ready reads nothing.
  const failing = createModelCatalogSync({ ready: () => true, read: async () => { throw new Error('x') } })
  assert.equal(await failing.refresh(), null)
  ready = false
  assert.equal(await sync.refresh(), null)
  assert.equal(releases.length, 0)
  // The real reader runs against model/list through the injected request.
  const server = pagedServer([nativeModel('gpt-6.1-sol', { isDefault: true })])
  const live = createModelCatalogSync({ request: server.request, identity: () => 'email:a@example.com' })
  assert.deepEqual((await live.refresh()).map(row => row.id), ['gpt-6.1-sol'])
  assert.equal(server.calls[0][0], 'model/list')
})

test('a chosen model must be listed and a chosen effort must be listed by the model that will run; no list means no check', () => {
  const models = [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', isDefault: true, supportedEfforts: ['low', 'medium', 'high', 'ultra'], defaultEffort: 'low' },
    { id: 'gpt-6-luna', displayName: 'GPT-6-Luna', isDefault: false, supportedEfforts: ['low', 'medium', 'max'], defaultEffort: 'medium' },
    { id: 'constructor', displayName: 'Odd', isDefault: false, supportedEfforts: [], defaultEffort: null },
  ]
  const refused = code => error => error.code === code && error.httpStatus === 400
  for (const list of [null, undefined, [], [{ id: '' }]]) {
    assert.doesNotThrow(() => assertModelSelection(list, { model: 'anything', effort: 'whatever' }))
  }
  assert.doesNotThrow(() => assertModelSelection(models, {}))
  assert.doesNotThrow(() => assertModelSelection(models, { model: 'gpt-6-luna', effort: 'max' }))
  assert.doesNotThrow(() => assertModelSelection(models, { model: 'gpt-6.1-sol' }))
  assert.throws(() => assertModelSelection(models, { model: 'gpt-reserve' }), refused('MODEL_UNAVAILABLE'))
  assert.throws(() => assertModelSelection(models, { model: 'toString' }), refused('MODEL_UNAVAILABLE'), 'ids are compared in a list, never as object keys')
  assert.throws(() => assertModelSelection(models, { model: 'gpt-6-luna', effort: 'ultra' }), refused('EFFORT_UNSUPPORTED'))
  assert.throws(() => assertModelSelection(models, { model: 'constructor', effort: 'low' }), refused('EFFORT_UNSUPPORTED'))
  assert.throws(() => assertModelSelection(models, { model: 'gpt-6-luna', effort: 'hasOwnProperty' }), refused('EFFORT_UNSUPPORTED'))
  // Effort alone: the model that will run when it is known and listed …
  assert.doesNotThrow(() => assertModelSelection(models, { effort: 'max', currentModel: 'gpt-6-luna' }))
  assert.throws(() => assertModelSelection(models, { effort: 'ultra', currentModel: 'gpt-6-luna' }), refused('EFFORT_UNSUPPORTED'))
  // … otherwise any listed model must support it.
  assert.doesNotThrow(() => assertModelSelection(models, { effort: 'ultra' }))
  assert.doesNotThrow(() => assertModelSelection(models, { effort: 'max', currentModel: 'custom-config-model' }))
  assert.throws(() => assertModelSelection(models, { effort: 'xhigh' }), refused('EFFORT_UNSUPPORTED'))
})
