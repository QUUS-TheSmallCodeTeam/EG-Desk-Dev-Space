import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
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

const labelOnly = '직접 선택한 근거'
const dbPath = f => path.join(f.dataDir, 'memory-evidence', 'grants.sqlite')
// Construct a real v1 file independently of the implementation under test, using real immutable capture hashes.
async function v1(f) {
  const spec = await example(f), ids = [1, 2, 3].map(() => `memrow:${randomUUID()}`)
  const hash = s => createHash('sha256').update(s).digest('hex'), scope = hash(JSON.stringify([S.ownerKey, S.agentId, S.clientThreadId]))
  const pin = async p => ({ ...p, projectionHash: (await f.captures.getCapture(S.ownerKey, p.sourceId)).payloads.projection.hash })
  const pins = JSON.stringify({ ledger: await pin(spec.ledger), sources: await Promise.all(spec.sources.map(pin)) })
  const file = dbPath(f); await mkdir(path.dirname(file), { mode: 0o700 }); await writeFile(file, '', { mode: 0o600 })
  const db = new DatabaseSync(file)
  try {
    db.exec(`CREATE TABLE grants(id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, expires_at INTEGER, pins TEXT NOT NULL) STRICT;
      CREATE TABLE revoked(id TEXT PRIMARY KEY REFERENCES grants(id)) STRICT; PRAGMA application_id=0x4d455647; PRAGMA user_version=1;`)
    for (const [i, id] of ids.entries()) db.prepare('INSERT INTO grants VALUES(?,?,?,?)').run(id, scope, i === 2 ? 90 : null, pins)
    db.prepare('INSERT INTO revoked VALUES(?)').run(ids[1])
  } finally { db.close() }
  return { ids, spec, pins, file }
}

test('v1 migrates in place to v2 without changing grants, pins, expiry or tombstones; old grants never opt in', async t => {
  const f = await fixture(t), { ids, pins, spec, file } = await v1(f), a = f.make({ now: () => 100 })
  assert.deepEqual(a.list(S), [{ id: ids[0], label: labelOnly, automatic: false }]); assert.equal(a.find(S, 'month total 17'), null)
  assert.equal((await a.read(S, ids[0])).ledger.text, 'month total 17'); assert.equal(a.isActive(S, ids[1]), false); assert.equal(a.isActive(S, ids[2]), false)
  const added = await a.bind(S, { ...spec, discovery: { label: '수량', terms: ['몇 개'] } }); a.close()
  const raw = new DatabaseSync(file, { readOnly: true })
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3)
    for (const id of ids) assert.deepEqual({ ...raw.prepare('SELECT pins,discovery_label,discovery_terms FROM grants WHERE id=?').get(id) }, { pins, discovery_label: null, discovery_terms: null })
    assert.equal(raw.prepare('SELECT id FROM revoked').get().id, ids[1])
  } finally { raw.close() }
  const b = f.make({ now: () => 100 }); assert.deepEqual(b.find(S, '지금 몇 개야?'), { id: added, label: '수량' }); assert.equal(b.rememberTurn(S, 'local-migration-1', ids[0]), true)
  assert.deepEqual(b.forTurn(S, 'local-migration-1'), { id: ids[0], label: labelOnly })
})

test('explicit aliases only; Korean particles and spacing, Unicode, case-folded words and exact negative boundaries', async t => {
  const f = await fixture(t), a = f.make(), spec = await example(f), label = '보관함 A'
  const explicit = await a.bind(S, spec), id = await a.bind(S, { ...spec, discovery: { label, terms: ['재고', '몇 개', '파란 연필', 'Project Café', 'Stock', 'SKU-42'] } })
  for (const message of ['재고는?', '재고에서', '재고인가요?', '재고는?'.normalize('NFD'), '지금 몇 개야?', '몇개예요?', '파란연필이요?', '파란   연필이', 'PROJECT CAFÉ', 'ＰＲＯＪＥＣＴ　Ｃａｆｅ́는?', '“stock”', '(ＳＫＵ－４２)']) assert.deepEqual(a.find(S, message), { id, label }, message)
  for (const message of ['왜?', '이유는?', '왜 28개야?', 'why?', 'Stockpile', 'Restock', 'stock_code', 'code-SKU-42', 'SKU-420', '재고관리', '부재고는?', '몇 개발자인가?', '몇, 개야?', 'Project, café', 'project caféine', '보관함 A', 'month total 17', 'posted 10', 's'.repeat(2100), null]) assert.equal(a.find(S, message), null, message)
  assert.deepEqual(a.list(S), [{ id, label, automatic: true }, { id: explicit, label: labelOnly, automatic: false }])
  assert.deepEqual(a.getMeta(S, id), { id, label, automatic: true }); assert.equal(a.getMeta(S, `memrow:${randomUUID()}`), null)
  a.close(); const b = f.make({ captures: { getCapture() { throw Error('no capture may be opened') }, readProjection() { throw Error('no content reads') } } })
  assert.deepEqual(b.find(S, '지금 몇 개야?'), { id, label }); assert.deepEqual(b.getMeta(S, explicit), { id: explicit, label: labelOnly, automatic: false })
})

test('no recent-wins or ambiguity tie break; independent live stores see scoped revocation/expiry, no unseen competitors at bounds', async t => {
  const f = await fixture(t); let clock = 100
  const a = f.make({ now: () => clock }), b = f.make({ now: () => clock }), spec = await example(f)
  const add = (label, terms, rest = {}) => a.bind(S, { ...spec, ...rest, discovery: { label, terms } })
  const first = await add('선반 A', ['재고']), other = await add('선반 B', ['재고', '파란연필'], { expiresAt: 105 })
  assert.equal(b.find(S, '재고는?'), null); assert.deepEqual(b.find(S, '파란 연필은?'), { id: other, label: '선반 B' })
  for (const key of Object.keys(S)) {
    const bad = { ...S, [key]: 'wrong value' }; assert.equal(a.find(bad, '재고'), null); assert.deepEqual(a.list(bad), []); assert.equal(a.getMeta(bad, first), null)
  }
  const separate = { ...S, agentId: 'other-agent' }, otherScopeId = await b.bind(separate, { ...spec, discovery: { label: '독립', terms: ['재고'] } })
  assert.deepEqual(b.find(separate, '재고?'), { id: otherScopeId, label: '독립' })
  clock = 105; assert.deepEqual(b.find(S, '재고'), { id: first, label: '선반 A' }); assert.equal(b.getMeta(S, other), null)
  assert.equal(a.revoke(S, first), true); assert.deepEqual(b.list(S), []); assert.equal(b.find(S, '재고'), null)
  // An unseen duplicate must not become a spurious unique match when the bounded scan is exceeded.
  for (let i = 0; i < 65; i++) await add(`창고 ${i}`, [i === 0 || i === 64 ? '표적 창고' : `item-${i}`])
  assert.equal(a.list(S).length, 64); assert.equal(a.find(S, '표적 창고'), null); assert.equal(a.find(S, 'item-12'), null)
  assert.deepEqual(a.find(separate, '재고'), { id: otherScopeId, label: '독립' })
})

test('invalid metadata, generic aliases and suspicious opt-in shapes never mint a grant', async t => {
  const f = await fixture(t), a = f.make(), spec = await example(f)
  for (const discovery of [undefined, null, {}, { terms: ['재고'] }, { label: 'x', terms: [] }, { label: '\nlabel', terms: ['재고'] },
    { label: 'A'.repeat(81), terms: ['재고'] }, { label: '한글', terms: ['why'] }, { label: '한글', terms: ['왜요'] },
    { label: '한글', terms: ['a'] }, { label: '한글', terms: ['42'] }, { label: '한글', terms: ['***'] },
    { label: '한글', terms: ['지금'] }, { label: '한글', terms: ['28개'] }, { label: '한글', terms: ['28 개'] }, { label: '한글', terms: ['지금은'] }, { label: '한글', terms: ['몇 개', '몇개'] }, { label: '한글', terms: Array(9).fill('재고') },
    { label: '한글', terms: ['this that'] }, { label: '한글', terms: ['a'.repeat(65)] }, { label: '한글', terms: [null] }, { label: '한글', terms: ['재고'], auto: true }]) {
    await assert.rejects(a.bind(S, { ...spec, discovery }), error)
  }
  assert.deepEqual(a.list(S), []); assert.equal(a.find(S, '왜?'), null); await assert.rejects(lstat(dbPath(f)), { code: 'ENOENT' })
})

test('turn links are exact origin matches, durable, scope-bound, idempotent and permanently ambiguous after conflict', async t => {
  const f = await fixture(t), spec = await example(f); let clock = 10
  const a = f.make({ now: () => clock }), b = f.make({ now: () => clock }), run = 'synthetic-local-run:7', another = 'synthetic-local-run:8'
  const first = await a.bind(S, spec), exp = await b.bind(S, { ...spec, expiresAt: 15, discovery: { label: '표시', terms: ['재고'] } }), third = await a.bind(S, spec)
  assert.equal(a.forTurn(S, run), null); assert.equal(b.rememberTurn(S, run, first), true); assert.equal(a.rememberTurn(S, run, first), true)
  assert.deepEqual(a.forTurn(S, run), { id: first, label: labelOnly }); assert.equal(a.forTurn(S, another), null)
  for (const key of Object.keys(S)) { const bad = { ...S, [key]: 'other' }; assert.equal(a.rememberTurn(bad, run, first), false); assert.equal(a.forTurn(bad, run), null) }
  for (const bad of ['', null, ' run', 'run\n', 'x'.repeat(257)]) { assert.equal(a.rememberTurn(S, bad, first), false); assert.equal(a.forTurn(S, bad), null) }
  a.close(); b.close(); const c = f.make({ now: () => clock }); assert.deepEqual(c.forTurn(S, run), { id: first, label: labelOnly }); assert.equal(c.rememberTurn(S, another, exp), true)
  assert.equal(c.rememberTurn(S, run, exp), false); assert.equal(c.forTurn(S, run), null); assert.equal(c.rememberTurn(S, run, third), false)
  const raw = new DatabaseSync(dbPath(f), { readOnly: true }); try { assert.equal(raw.prepare('SELECT count(*) AS n FROM turn_inputs').get().n, 3) } finally { raw.close() }
  assert.equal((await readFile(dbPath(f))).includes(run), false); assert.deepEqual(c.forTurn(S, another), { id: exp, label: '표시' })
  clock = 15; assert.equal(c.forTurn(S, another), null); assert.equal(c.forTurn(S, run), null); assert.equal(c.rememberTurn(S, 'absent', exp), false)
  assert.equal(c.revoke(S, exp), true); assert.equal(c.rememberTurn(S, run, first), false); assert.equal(c.forTurn(S, run), null)
  assert.equal(c.rememberTurn(S, '호스트@런#9', third), true); assert.deepEqual(c.forTurn(S, '호스트@런#9'), { id: third, label: labelOnly }); assert.equal(c.revoke(S, third), true); assert.equal(c.forTurn(S, '호스트@런#9'), null)
})

test('read-only v1 fails closed without rewriting it; migration errors roll back instead of resetting or partially upgrading', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), { ids, file, spec } = await v1(f), before = await readFile(file), a = f.make({ now: () => 100 })
  await chmod(file, 0o400); assert.deepEqual(a.list(S), []); assert.equal(a.find(S, '재고'), null); assert.equal(a.isActive(S, ids[0]), false)
  assert.equal(a.rememberTurn(S, 'readonly', ids[0]), false); await assert.rejects(a.bind(S, spec), error); assert.deepEqual(await readFile(file), before)
  await chmod(file, 0o600); const interfere = new DatabaseSync(file); interfere.exec('CREATE INDEX grants_by_scope ON grants(scope_key)'); interfere.close()
  assert.deepEqual(a.list(S), []); assert.equal(await a.read(S, ids[0]), null); await assert.rejects(a.bind(S, spec), error)
  const raw = new DatabaseSync(file); try {
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1); assert.deepEqual(raw.prepare('PRAGMA table_info(grants)').all().map(r => r.name), ['id', 'scope_key', 'expires_at', 'pins'])
    assert.equal(raw.prepare('SELECT count(*) AS n FROM revoked').get().n, 1); raw.exec('DROP INDEX grants_by_scope')
  } finally { raw.close() }
  assert.equal(a.isActive(S, ids[0]), true); assert.equal(a.isActive(S, ids[1]), false)
})
