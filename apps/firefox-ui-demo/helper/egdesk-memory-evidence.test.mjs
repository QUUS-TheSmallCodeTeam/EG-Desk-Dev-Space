import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { MemoryEvidenceStore } from './egdesk-memory-evidence.mjs'

const S = Object.freeze({ ownerKey: 'fixture-owner-only', agentId: 'fixture-agent-only', clientThreadId: 'fixture-thread-only' })
const error = { name: 'Error', message: 'Memory evidence unavailable' }
const p = (m, a = 1, b = a) => ({ sourceId: m.sourceId, revision: m.revision, startLine: a, endLine: b })
const from = (m, a = 1, b = a, relation = 'recorded') => ({ relation, ...p(m, a, b) })
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-evidence-'))
  const dataDir = path.join(dir, 'app'), captures = new ImmutableContextStore({ dataDir, allowedRoots: [dir] })
  const stores = [], make = (options = {}) => {
    const store = new MemoryEvidenceStore({ dataDir, captures, ...options }); stores.push(store); return store
  }
  t.after(async () => { for (const store of stores) store.close(); await rm(dir, { recursive: true, force: true }) })
  const browser = (text, { scope = S, truncated = false } = {}) => captures.capture(scope.ownerKey, scope.clientThreadId, {
    id: 'ui-fixture-only', kind: 'browser', label: 'window-label-fixture', sourceRef: { viewId: 'view-fixture-only' }, content: { text, truncated },
  })
  const file = name => captures.capture(S.ownerKey, S.clientThreadId, {
    id: 'file-ui-fixture', kind: 'file', label: 'file-label-fixture', sourceRef: { path: path.join(dir, name) },
  })
  const manifestFile = async m => path.join(await captures.directory(S.ownerKey, 'sources'), `${m.sourceId}.json`)
  const blob = async hash => path.join(await captures.directory(S.ownerKey, 'blobs'), hash)
  return { dir, dataDir, captures, make, browser, file, manifestFile, blob }
}
async function example(f) {
  const ledger = await f.browser('ledger-neighbor-A\nmonth total 17\nledger-neighbor-B')
  const doc = await f.browser('evidence-neighbor-A\nposted 10\nposted 7\nevidence-neighbor-B')
  return { ledger: p(ledger, 2), sources: [from(doc, 2, 3, 'posted')] }
}

test('selects only pinned projected lines; opaque fresh tokens, exact pack, and durable text-free grant storage', async t => {
  const f = await fixture(t), a = f.make()
  const l = await f.browser('ledger-neighbor-A\r\nledger-row-fixture\r\nledger-neighbor-B')
  const m = await f.browser('neighbor-A\r\nposted fixture 7\r\npassword=fixture-must-not-appear\r\nneighbor-B')
  const spec = { ledger: p(l, 2), sources: [from(m, 2, 3, 'posted')] }
  const id = await a.bind(S, spec), second = await a.bind(S, spec)
  assert.match(id, /^memrow:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.notEqual(id, second)
  const expected = { version: 1, ledger: { ...spec.ledger, text: 'ledger-row-fixture' }, sources: [{ ...spec.sources[0], text: 'posted fixture 7\npassword=[REDACTED]' }] }
  assert.deepEqual(await a.read(S, id), expected)
  a.close()
  const b = f.make({ captures: new ImmutableContextStore({ dataDir: f.dataDir, allowedRoots: [f.dir] }) })
  assert.equal(b.isActive(S, id), true); assert.deepEqual(await b.read(S, id), expected)
  b.close()
  const dir = path.join(f.dataDir, 'memory-evidence'), files = await readdir(dir)
  assert.ok(files.includes('grants.sqlite'))
  const forbidden = ['ledger-row-fixture', 'posted fixture', 'neighbor-', 'fixture-must-not-appear', '[REDACTED]', 'ui-fixture-only', 'window-label-fixture', 'view-fixture-only', ...Object.values(S)]
  for (const name of files) {
    const file = path.join(dir, name), bytes = await readFile(file)
    for (const str of forbidden) assert.equal(bytes.includes(str), false)
    if (process.platform !== 'win32') assert.equal((await lstat(file)).mode & 0o077, 0)
  }
})

test('each scope dimension is mandatory and exact; another thread/owner cannot supply one mixed pin', async t => {
  const f = await fixture(t), a = f.make(), spec = await example(f), id = await a.bind(S, spec)
  for (const key of Object.keys(S)) {
    const other = { ...S, [key]: `${S[key]}-other` }
    for (const bad of [other, { ...S, [key]: '' }, { ...S, [key]: null }, { ...S, [key]: '   ' }, Object.fromEntries(Object.entries(S).filter(([k]) => k !== key))]) {
      assert.equal(a.isActive(bad, id), false); assert.equal(await a.read(bad, id), null); assert.equal(a.revoke(bad, id), false)
    }
    if (key !== 'agentId') {
      const stray = await f.browser('independent synthetic capture', { scope: other })
      await assert.rejects(a.bind(S, { ...spec, sources: [...spec.sources, from(stray)] }), error)
    }
  }
  for (const bad of [null, [], {}, { ...S, account: 'extra' }, Object.create(S)]) {
    await assert.rejects(a.bind(bad, spec), error); assert.equal(a.isActive(bad, id), false); assert.equal(await a.read(bad, id), null)
  }
  assert.equal(a.isActive(S, id), true)
})

test('a changed file needs a new explicit capture and binding; missing pinned bytes never use the current file', async t => {
  const f = await fixture(t), a = f.make(), name = 'synthetic-record.txt', file = path.join(f.dir, name)
  await writeFile(file, 'file preamble\nold chosen record\nfile suffix')
  const old = await f.file(name), ledger = p(await f.browser('fixture row'))
  const oldId = await a.bind(S, { ledger, sources: [from(old, 2)] })
  await writeFile(file, 'new preamble\nnew chosen record\nnew suffix')
  const next = await f.file(name); assert.notEqual(next.sourceId, old.sourceId); assert.notEqual(next.revision, old.revision)
  const newId = await a.bind(S, { ledger, sources: [from(next, 2)] })
  await rm(file)
  assert.equal((await a.read(S, oldId)).sources[0].text, 'old chosen record')
  assert.equal((await a.read(S, newId)).sources[0].text, 'new chosen record')
  await rm(await f.blob(old.hash))
  assert.equal(await a.read(S, oldId), null); assert.equal((await a.read(S, newId)).sources[0].text, 'new chosen record')
})

test('two live stores recheck expiry and durable independent revocation; fresh grant cannot revive the old one', async t => {
  const f = await fixture(t); let clock = 100
  const a = f.make({ now: () => clock }), b = f.make({ now: () => clock }), spec = await example(f)
  const id = await a.bind(S, { ...spec, expiresAt: 104 }), separate = await b.bind(S, spec)
  const exp = await a.bind(S, { ...spec, expiresAt: 103 })
  assert.equal(b.isActive(S, id), true); assert.equal(a.isActive(S, exp), true); assert.equal(b.isActive(S, exp), true)
  assert.equal(b.revoke(S, id), true); assert.equal(a.isActive(S, id), false); assert.equal(await a.read(S, id), null)
  assert.equal(a.isActive(S, separate), true); clock = 103
  for (const store of [a, b]) { assert.equal(store.isActive(S, exp), false); assert.equal(await store.read(S, exp), null) }
  a.close(); b.close(); clock = 101
  const c = f.make({ now: () => clock }); assert.equal(c.isActive(S, id), false); assert.equal(await c.read(S, id), null); assert.equal(c.isActive(S, separate), true)
})

test('revocation or expiry during the final async projection releases no text; expiry during bind issues no handle', async t => {
  const f = await fixture(t); let clock = 100, afterProjection = null
  const captures = { getCapture: (...args) => f.captures.getCapture(...args), readProjection: async (...args) => {
    const value = await f.captures.readProjection(...args); afterProjection?.(args[1]); return value
  } }
  const a = f.make({ now: () => clock, captures }), b = f.make({ now: () => clock }), spec = await example(f)
  const id = await a.bind(S, spec)
  afterProjection = sourceId => { if (sourceId === spec.sources[0].sourceId) assert.equal(b.revoke(S, id), true) }
  assert.equal(await a.read(S, id), null); assert.equal(b.isActive(S, id), false)
  afterProjection = null; const exp = await b.bind(S, { ...spec, expiresAt: 103 })
  afterProjection = sourceId => { if (sourceId === spec.sources[0].sourceId) clock = 103 }
  assert.equal(await a.read(S, exp), null); assert.equal(b.isActive(S, exp), false)
  clock = 100; await assert.rejects(a.bind(S, { ...spec, expiresAt: 103 }), error)
})

test('strict pin and scope shape, evidence cardinality, ranges, relation allowlist, expiry, and JSON-escaped pack size', async t => {
  const f = await fixture(t), a = f.make({ now: () => 100 }), spec = await example(f), sample = spec.sources[0]
  const rowChange = obj => ({ ...spec, ledger: { ...spec.ledger, ...obj } })
  for (const bad of [null, [], {}, { ...spec, other: 'x' }, { ledger: spec.ledger }, { ...spec, sources: null }, { ...spec, sources: [] },
    { ...spec, sources: new Array(1) }, { ...spec, sources: Array(7).fill(sample) }, { ...spec, sources: [{ ...sample, relation: 'verified' }] },
    rowChange({ sourceId: 'not-an-opaque-id' }), rowChange({ revision: 'A'.repeat(64) }), rowChange({ revision: '0'.repeat(64) }),
    rowChange({ endLine: 3 }), rowChange({ startLine: 0 }), rowChange({ startLine: '2' }), rowChange({ startLine: 2.1 }),
    rowChange({ startLine: 15, endLine: 15 }), rowChange({ path: '/unexpected' }), { ...spec, sources: [{ ...sample, endLine: 1 }] },
    ...[null, undefined, 0, 99, 100, '102', 101.5, Infinity, NaN].map(expiresAt => ({ ...spec, expiresAt }))]) await assert.rejects(a.bind(S, bad), error)
  for (const relation of ['counted', 'posted', 'recorded', 'copied', 'derived', 'scheduled', 'coverage']) {
    const id = await a.bind(S, { ...spec, sources: [{ ...sample, relation }] }); assert.equal((await a.read(S, id)).sources[0].relation, relation)
  }
  const quotes = await f.browser('"'.repeat(1950)), lots = await f.browser('q'.repeat(2000)), other = await f.browser('z'.repeat(2000)), huge = await f.browser('x'.repeat(5000))
  for (const sources of [[from(quotes)], [from(lots), from(other)], [from(huge)]]) await assert.rejects(a.bind(S, { ...spec, sources }), error)
})

test('overlapping evidence cannot be counted twice; identical recaptures and self-citation cannot create corroboration', async t => {
  const f = await fixture(t), a = f.make(), text = 'header\nledger row\nfirst posting\nsecond posting\nclosing', m = await f.browser(text), twin = await f.browser(text)
  assert.notEqual(m.sourceId, twin.sourceId); assert.equal(m.revision, twin.revision)
  const ledger = p(m, 2), prove = sources => a.bind(S, { ledger, sources })
  for (const sources of [[from(m, 3), from(m, 3)], [from(m, 3), from(m, 3, 3, 'posted')], [from(m, 3, 4), from(m, 4, 5, 'derived')],
    [from(m, 3, 4), from(twin, 3, 4)], [from(m, 2)], [from(twin, 2, 2, 'counted')], [from(m, 2, 3, 'copied')]]) await assert.rejects(prove(sources), error)
  const sources = [from(twin, 2, 2, 'copied'), from(m, 3, 3, 'counted'), from(m, 4, 4, 'posted')]
  const id = await prove(sources), pack = await a.read(S, id)
  assert.deepEqual(pack.sources.map(s => [s.relation, s.text]), [['copied', 'ledger row'], ['counted', 'first posting'], ['posted', 'second posting']])
})

test('incomplete coverage, binary files, blank/control content, missing/corrupted blobs or swapped projection fail closed', async t => {
  const f = await fixture(t), a = f.make(), spec = await example(f)
  const bind = m => a.bind(S, { ...spec, sources: [from(m)] })
  await writeFile(path.join(f.dir, 'binary.fixture'), Buffer.from([0xff, 0, 0xb7]))
  for (const m of [await f.file('binary.fixture'), await f.browser('visible but clipped', { truncated: true }), await f.browser('  \t'), await f.browser('x\0y'), await f.browser('x\ry')]) await assert.rejects(bind(m), error)
  const m = await f.browser('password=fixture-not-a-secret'), id = await bind(m), filename = await f.manifestFile(m), originalManifest = await readFile(filename, 'utf8')
  assert.notEqual(m.hash, m.payloads.projection.hash)
  for (const mutate of [x => { delete x.capture.coverage.complete }, x => { x.capture.coverage.complete = false }, x => { x.truncated = true }, x => { delete x.truncated },
    x => { x.clientThreadId += '-other' }, x => { x.sourceId = randomUUID() }, x => { x.revision = 'a'.repeat(64) }, x => { x.hash = 'a'.repeat(64) }, x => { x.payloads.projection = null }]) {
    const value = JSON.parse(originalManifest); mutate(value); await writeFile(filename, JSON.stringify(value))
    assert.equal(await a.read(S, id), null); await assert.rejects(bind(m), error)
  }
  const other = await f.browser('other valid public projection'), changed = JSON.parse(originalManifest)
  changed.payloads.projection = other.payloads.projection; changed.shape = other.shape
  await writeFile(filename, JSON.stringify(changed)); assert.equal(await a.read(S, id), null)
  await writeFile(filename, originalManifest)
  for (const hash of [m.hash, m.payloads.projection.hash]) {
    const file = await f.blob(hash), bytes = await readFile(file)
    await writeFile(file, 'changed bytes'); assert.equal(await a.read(S, id), null); await assert.rejects(bind(m), error)
    await rm(file); assert.equal(await a.read(S, id), null); await writeFile(file, bytes)
  }
  assert.equal((await a.read(S, id)).sources[0].text, 'password=[REDACTED]')
})

test('unused or unknown selection does not create a database; cold missing lookup does not mask a later bound grant', async t => {
  const f = await fixture(t), a = f.make(), id = `memrow:${randomUUID()}`
  for (const invalid of [null, 12, '', id.toUpperCase(), id + '\n', id + '/path', id]) {
    assert.equal(a.isActive(S, invalid), false); assert.equal(await a.read(S, invalid), null); assert.equal(a.revoke(S, invalid), false)
  }
  await assert.rejects(lstat(f.dataDir), { code: 'ENOENT' })
  const b = f.make(), actual = await b.bind(S, await example(f)); assert.equal(a.isActive(S, actual), true)
  a.close(); assert.equal(a.isActive(S, actual), false); assert.equal(await a.read(S, actual), null)
})

test('preexisting links and insecure permissions are refused without touching the target or reseeding', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), spec = await example(f), dir = path.join(f.dataDir, 'memory-evidence')
  await mkdir(dir, { mode: 0o700 }); const target = path.join(f.dir, 'sentinel'), file = path.join(dir, 'grants.sqlite'); await writeFile(target, 'sentinel unchanged', { mode: 0o600 })
  const attempt = async () => { const a = f.make(); await assert.rejects(a.bind(S, spec), error); a.close(); assert.equal(await readFile(target, 'utf8'), 'sentinel unchanged') }
  for (const ext of ['', '-wal', '-shm', '-journal']) { await symlink(target, file + ext); await attempt(); await rm(file + ext) }
  await link(target, file); await attempt(); await rm(file)
  await writeFile(file, 'not our db', { mode: 0o600 }); await attempt(); assert.equal(await readFile(file, 'utf8'), 'not our db'); await rm(file)
  await chmod(dir, 0o755); await attempt(); await chmod(dir, 0o700)
  await rm(dir, { recursive: true }); await symlink(f.dir, dir); await attempt(); await assert.rejects(lstat(path.join(f.dir, 'grants.sqlite')), { code: 'ENOENT' })
})
