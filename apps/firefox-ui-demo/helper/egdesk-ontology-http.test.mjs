import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { openOntologyStore } from './egdesk-ontology-store.mjs'
import { inspectSqliteRuntime } from './egdesk-sqlite-runtime.mjs'
import { computeBridgeBuildHash } from './egdesk-bridge-build.mjs'
import { checkExistingOntologyBridge, createOntologyHttpHandler, handleOntologyHttp, ontologyHealth, ontologyProfileId, ontologyStoragePaths, openBoundOntologyStore, prepareOntologyProfileBinding, readOntologyProfileBinding } from './egdesk-ontology-http.mjs'

const bundled = fileURLToPath(new URL('../overlay/resources/ontology/graph.json', import.meta.url))
const fixtureGraph = readFileSync(bundled)

function fixture(t, name = 'profile-a', graph = fixtureGraph) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'egdesk-ontology-http-')))
  const profilePath = path.join(root, name)
  const dataDir = path.join(root, 'data')
  mkdirSync(profilePath, { mode: 0o700 })
  writeFileSync(path.join(profilePath, '.egdesk-dedicated-firefox-profile'), 'EGDESK_DEDICATED_FIREFOX_PROFILE_V1\n', { mode: 0o600 })
  mkdirSync(path.join(profilePath, 'chrome', 'resources', 'ontology'), { recursive: true, mode: 0o755 })
  writeFileSync(path.join(profilePath, 'chrome', 'resources', 'ontology', 'graph.json'), graph, { mode: 0o600 })
  t.after(() => {
    assert.equal(realpathSync.native(root), root)
    rmSync(root, { recursive: true, force: true })
  })
  return { root, profilePath, dataDir }
}

function request(method, url, headers = {}) {
  const req = Readable.from([])
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:39218', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
async function call(options, method, url, headers = {}) {
  const sent = []
  const handled = await handleOntologyHttp(request(method, url, headers), new URL(url, 'http://127.0.0.1:39218'), { ...options, send: (status, data, responseHeaders) => sent.push({ status, data, responseHeaders }) })
  assert.ok(sent.length <= 1)
  return { handled, ...sent[0] }
}
const auth = binding => ({ 'x-egdesk-ontology-profile': binding.profileId, 'x-egdesk-ontology-token': binding.token })

test('validated profile binding preserves its original baseline and token exactly once', t => {
  const { profilePath, dataDir } = fixture(t)
  const resources = path.join(profilePath, 'chrome', 'resources')
  const existingMode = statSync(resources).mode & 0o777
  const binding = prepareOntologyProfileBinding({ profilePath, dataDir })
  assert.equal(statSync(resources).mode & 0o777, existingMode, 'existing profile directory permissions are unchanged')
  const paths = ontologyStoragePaths({ dataDir, profileId: binding.profileId })
  assert.deepEqual(readOntologyProfileBinding(profilePath), binding)
  assert.match(binding.profileId, /^[a-f0-9]{64}$/)
  assert.match(binding.token, /^[a-f0-9]{64}$/)
  assert.ok(paths.dbPath.endsWith(`/ontology/profiles/${binding.profileId}/ontology.sqlite`))
  assert.deepEqual(readFileSync(paths.baselinePath), fixtureGraph)
  writeFileSync(path.join(profilePath, 'chrome', 'resources', 'ontology', 'graph.json'), '{"changed":true}')
  assert.deepEqual(prepareOntologyProfileBinding({ profilePath, dataDir }), binding)
  assert.deepEqual(readFileSync(paths.baselinePath), fixtureGraph, 'later overlay copies cannot replace the preserved source')
})

test('only validated profiles and private non-symlink binding files are accepted', t => {
  const { profilePath, dataDir } = fixture(t)
  const binding = prepareOntologyProfileBinding({ profilePath, dataDir })
  const marker = path.join(profilePath, 'chrome', 'resources', 'egdesk-ontology-binding.json')
  writeFileSync(marker, JSON.stringify({ version: 1, profileId: '0'.repeat(64), token: binding.token }), { mode: 0o600 })
  assert.throws(() => readOntologyProfileBinding(profilePath), /invalid/)
  assert.throws(() => prepareOntologyProfileBinding({ profilePath, dataDir }), /invalid/)
  assert.throws(() => readOntologyProfileBinding(path.dirname(profilePath)), /verified/)
})

test('binding refuses a readable or symlinked profile token file', { skip: process.platform === 'win32' }, t => {
  const { profilePath, dataDir } = fixture(t)
  prepareOntologyProfileBinding({ profilePath, dataDir })
  const marker = path.join(profilePath, 'chrome', 'resources', 'egdesk-ontology-binding.json')
  chmodSync(marker, 0o644)
  assert.throws(() => readOntologyProfileBinding(profilePath), /private/)
  chmodSync(marker, 0o600)
  renameSync(marker, marker + '.held')
  symlinkSync(marker + '.held', marker)
  assert.throws(() => readOntologyProfileBinding(profilePath), /private/)
})

test('loopback, profile, and token guards precede any store access', async t => {
  const a = fixture(t, 'profile-a'), b = fixture(t, 'profile-b')
  const binding = prepareOntologyProfileBinding(a)
  const other = prepareOntologyProfileBinding(b)
  let opens = 0
  const graph = { schemaVersion: 3, nodes: [], snapshots: [], occurrences: [], referenceEdges: [] }
  const store = { readGraph: () => graph, status: () => ({ initialized: true, schemaVersion: 1 }), integrity: () => ({ ok: true }) }
  const options = { binding, store: () => { opens++; return store }, runtime: inspectSqliteRuntime() }
  assert.deepEqual([(await call(options, 'GET', '/ontology/graph', { ...auth(binding), origin: 'https://evil.example' })).status, opens], [403, 0])
  assert.deepEqual([(await call(options, 'GET', '/ontology/graph', auth(other))).status, opens], [409, 0])
  assert.deepEqual([(await call(options, 'GET', '/ontology/graph', { ...auth(binding), 'x-egdesk-ontology-token': '0'.repeat(64) })).status, opens], [403, 0])
  assert.deepEqual([(await call(options, 'GET', '/ontology/graph?profile=/tmp', auth(binding))).status, opens], [404, 0])
  const result = await call(options, 'GET', '/ontology/graph', auth(binding))
  assert.equal(result.status, 200)
  assert.deepEqual(result.data, graph)
  assert.deepEqual(result.responseHeaders, { 'X-EGDesk-Ontology-Profile': binding.profileId })
  assert.equal(opens, 1)
  assert.equal((await call(options, 'GET', '/other', auth(binding))).handled, false)
})

test('health reports the actual SQLite runtime and bounded migration data without private paths', async t => {
  const { profilePath, dataDir } = fixture(t)
  const binding = prepareOntologyProfileBinding({ profilePath, dataDir })
  const runtime = inspectSqliteRuntime()
  const store = { status: () => ({ initialized: true, schemaVersion: 1, sourceDocumentCount: 0, sourceHash: 'abc123', graphHash: 'f'.repeat(64), import: { rawGraphHash: 'a'.repeat(64), sourceLabel: '/Users/private/original.md' }, runtime: { error: '/Users/private' } }), integrity: () => ({ ok: true, issues: [] }) }
  const health = await ontologyHealth({ binding, store, runtime: { ...runtime, error: '/Users/private/problem' } })
  assert.equal(health.profileId, binding.profileId)
  assert.equal(health.sqlite.sqliteVersion, runtime.sqliteVersion)
  assert.equal(health.sqlite.patched, runtime.patched)
  assert.equal(health.sqlite.error, 'SQLite runtime probe failed')
  assert.equal(health.baseline.sourceMode, 'graph-only')
  assert.equal(health.baseline.import.rawGraphHash, 'a'.repeat(64))
  assert.doesNotMatch(JSON.stringify(health), /\/Users\/private|sourceLabel|token/)
  const response = await call({ binding, store, runtime }, 'GET', '/ontology/health', auth(binding))
  assert.equal(response.status, 200)
  assert.equal(response.data.ready, true)
})

test('real SQLite migration imports exact bytes once and never re-seeds an initialized DB', t => {
  const original = { ...JSON.parse(fixtureGraph), sourceHash: 'profile-specific-baseline' }
  const profileBytes = Buffer.from(JSON.stringify(original, null, 2))
  const { profilePath, dataDir } = fixture(t, 'profile-a', profileBytes)
  const binding = prepareOntologyProfileBinding({ profilePath, dataDir })
  const paths = ontologyStoragePaths({ dataDir, profileId: binding.profileId })
  let store = openBoundOntologyStore({ binding, dataDir, openStore: openOntologyStore })
  assert.deepEqual(store.readGraph(), original)
  assert.deepEqual(store.exportArchive().rawGraphJson, profileBytes, 'the profile graph, not the different bundled graph, was archived')
  assert.equal(store.status().sourceDocumentCount, 0, 'no unverified Markdown is attributed to the baseline')
  assert.equal(store.integrity().ok, true)
  store.close()

  const changed = { ...original, sourceHash: 'changed-after-migration' }
  writeFileSync(paths.baselinePath, JSON.stringify(changed))
  store = openBoundOntologyStore({ binding, dataDir, openStore: openOntologyStore })
  assert.deepEqual(store.readGraph(), original)
  store.close()
  renameSync(paths.baselinePath, paths.baselinePath + '.held')
  store = openBoundOntologyStore({ binding, dataDir, openStore: openOntologyStore })
  assert.deepEqual(store.readGraph(), original, 'initialized storage does not require a remaining seed file')
  store.close()
})

test('an existing archive with source documents is never replaced by a later legacy seed', t => {
  const { profilePath, dataDir } = fixture(t)
  const binding = prepareOntologyProfileBinding({ profilePath, dataDir })
  const paths = ontologyStoragePaths({ dataDir, profileId: binding.profileId })
  const graph = JSON.parse(fixtureGraph)
  const sourceBytes = Buffer.from('# archived original\n')
  let store = openOntologyStore({ dbPath: paths.dbPath })
  store.importGraph(graph, { rawGraphJson: fixtureGraph, sourceDocuments: [{ path: 'ontology/original.md', bytes: sourceBytes }], sourceLabel: '/private/source-label' })
  store.close()
  writeFileSync(paths.baselinePath, JSON.stringify({ ...graph, sourceHash: 'different-seed' }))
  store = openBoundOntologyStore({ binding, dataDir, openStore: openOntologyStore })
  const archive = store.exportArchive()
  assert.deepEqual(archive.rawGraphJson, fixtureGraph)
  assert.deepEqual(archive.sourceDocuments[0].bytes, sourceBytes)
  assert.equal(store.status().sourceDocumentCount, 1)
  store.close()
})

test('invalid seed or failing SQLite returns a bounded error without falling back to JSON', async t => {
  const { profilePath, dataDir } = fixture(t, 'bad-profile', Buffer.from('{bad json'))
  const binding = prepareOntologyProfileBinding({ profilePath, dataDir })
  assert.throws(() => openBoundOntologyStore({ binding, dataDir, openStore: openOntologyStore }))
  const paths = ontologyStoragePaths({ dataDir, profileId: binding.profileId })
  assert.equal(readFileSync(paths.baselinePath, 'utf8'), '{bad json')
  const response = await call({ binding, store: () => { throw new Error('/Users/private/secret SQLITE_IOERR') } }, 'GET', '/ontology/graph', auth(binding))
  assert.deepEqual(response.data, { code: 'ONTOLOGY_STORE_UNAVAILABLE', error: 'Ontology storage is unavailable' })
  assert.equal(response.status, 503)
  writeFileSync(paths.baselinePath, fixtureGraph)
  const recovered = openBoundOntologyStore({ binding, dataDir, openStore: openOntologyStore })
  assert.deepEqual(recovered.readGraph(), JSON.parse(fixtureGraph), 'retry imports only after the preserved seed is repaired')
  recovered.close()
})

test('actual loopback HTTP reads the temporary SQLite store and refuses another profile', async t => {
  const { profilePath, dataDir } = fixture(t)
  const binding = prepareOntologyProfileBinding({ profilePath, dataDir })
  const store = openBoundOntologyStore({ binding, dataDir, openStore: openOntologyStore })
  let handler
  const server = createServer((req, res) => void handler(req, res, new URL(req.url, 'http://127.0.0.1')))
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    handler = createOntologyHttpHandler({ binding, store, runtime: inspectSqliteRuntime(), port })
    const base = `http://127.0.0.1:${port}`
    const result = await fetch(`${base}/ontology/graph`, { headers: auth(binding) })
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.headers.get('x-egdesk-ontology-profile'), binding.profileId)
    assert.match(result.headers.get('access-control-expose-headers'), /X-EGDesk-Ontology-Profile/i)
    assert.deepEqual(await result.json(), JSON.parse(fixtureGraph))
    const wrong = await fetch(`${base}/ontology/graph`, { headers: { ...auth(binding), 'x-egdesk-ontology-profile': 'f'.repeat(64) } })
    assert.equal(wrong.status, 409)
    assert.equal((await wrong.json()).code, 'ONTOLOGY_PROFILE_MISMATCH')
    const untrusted = await fetch(`${base}/ontology/graph`, { headers: { ...auth(binding), origin: 'https://example.com' } })
    assert.equal(untrusted.status, 403)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    store.close()
  }
})

test('reuse preflight checks profile, real SQLite safety, and build before any profile write', async t => {
  const { profilePath, dataDir } = fixture(t)
  const profileId = ontologyProfileId(profilePath), expectedBuild = 'a'.repeat(64)
  let body, status = 200, hang = false
  let testedPort
  const server = createServer((req, res) => {
    if (hang) return
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    testedPort = port
    const runtime = inspectSqliteRuntime()
    const valid = { ok: true, port, bridge: { buildHash: expectedBuild }, ontology: { profileId, ready: false, sqlite: runtime } }
    const check = () => checkExistingOntologyBridge({ profilePath, port, expectedBuild, timeoutMs: 200 })
    body = valid
    assert.deepEqual(await check(), { state: 'compatible' }, 'temporarily unavailable ontology is allowed')
    body = { ...valid, bridge: { buildHash: computeBridgeBuildHash() } }
    assert.deepEqual(await checkExistingOntologyBridge({ profilePath, port, timeoutMs: 200 }), { state: 'compatible' }, 'the default is the current source build')
    assert.equal(existsSync(dataDir), false, 'reuse check did not create app data')
    assert.equal(existsSync(path.join(profilePath, 'chrome', 'resources', 'egdesk-ontology-binding.json')), false)
    for (const replacement of [undefined, 'f'.repeat(64)]) {
      body = { ...valid, ontology: { ...valid.ontology, profileId: replacement } }
      await assert.rejects(check(), { code: 'BRIDGE_PROFILE_MISMATCH' })
    }
    for (const sqlite of [
      { ...runtime, sqliteVersion: '3.50.4' },
      { ...runtime, sqliteVersion: null },
      { ...runtime, patched: false },
      { ...runtime, supported: false },
      { ...runtime, nodeVersion: '23.0.0' },
      { ...runtime, error: 'unavailable' },
    ]) {
      body = { ...valid, ontology: { ...valid.ontology, sqlite } }
      await assert.rejects(check(), { code: 'BRIDGE_SQLITE_UNSAFE' })
    }
    for (const buildHash of [undefined, 'f'.repeat(64)]) {
      body = { ...valid, bridge: { buildHash } }
      await assert.rejects(check(), { code: 'BRIDGE_BUILD_MISMATCH' })
    }
    for (const invalid of [null, 'bad-json', [], 'x'.repeat(260 * 1024)]) {
      body = invalid
      await assert.rejects(check(), { code: 'BRIDGE_HEALTH_UNAVAILABLE' })
    }
    status = 503
    body = valid
    await assert.rejects(check(), { code: 'BRIDGE_HEALTH_UNAVAILABLE' })
    status = 200
    hang = true
    await assert.rejects(check(), { code: 'BRIDGE_HEALTH_UNAVAILABLE' })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  assert.deepEqual(await checkExistingOntologyBridge({ profilePath, port: testedPort, expectedBuild, timeoutMs: 200 }), { state: 'absent' })
})

test('bridge health exposes the startup build and actual runtime without a provider call', () => {
  const source = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const from = source.indexOf("if (req.method === 'GET' && route === '/health')")
  const to = source.indexOf("if (req.method === 'GET' && route === '/system/resources')", from)
  assert.ok(from >= 0 && to > from)
  const block = source.slice(from, to)
  assert.match(block, /bridge:\s*\{\s*buildHash:\s*bridgeBuild\.buildHash\s*\}/)
  assert.match(block, /ontologyHealth\(\{ binding: ontologyBinding, store: ontologyStore, runtime: sqliteRuntime \}\)/)
  assert.doesNotMatch(block, /refreshAccountState|appServerRequest/)
})

test('Mac launcher checks reuse before profile writes and again before actual reuse', () => {
  const source = readFileSync(new URL('../scripts/run-firefox-mcp-target.sh', import.meta.url), 'utf8')
  const checks = [...source.matchAll(/--check-existing-bridge/g)].map(match => match.index)
  assert.equal(checks.length, 2)
  assert.ok(checks[0] < source.indexOf('--prepare-profile'))
  assert.ok(checks[0] < source.indexOf('"$SCRIPT_DIR/write-userjs.sh"'))
  assert.ok(checks[0] < source.indexOf('cp -R'))
  assert.ok(checks[1] < source.indexOf('nohup "$SCRIPT_DIR/run-codex-bridge.sh"'))
})
