import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { guardBridgeRequest, sendJson } from './codex-bridge-http.mjs'
import { appDataDirectory } from './egdesk-context-store.mjs'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'
import { computeBridgeBuildHash } from './egdesk-bridge-build.mjs'
import { isPatchedSqliteVersion } from './egdesk-sqlite-runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VALIDATOR = path.join(HERE, '../scripts/validate-firefox-profile.mjs')
const BUILTIN_SEED = path.join(HERE, '../overlay/resources/ontology/graph.json')
const BINDING_NAME = 'egdesk-ontology-binding.json'
const SEED_NAME = 'legacy-graph.json'
const MAX_SEED_BYTES = 8 * 1024 * 1024
const HEX = /^[a-f0-9]{64}$/

// Only a launcher-validated local path is authority. No HTTP field ever selects
// a profile, a directory or a seed. Revalidate even for direct bridge starts.
function verifiedProfile(profilePath) {
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) throw new Error('Firefox profile binding is unavailable')
  const result = spawnSync(process.execPath, [VALIDATOR, profilePath], { encoding: 'utf8', timeout: 10000, maxBuffer: 8192 })
  if (result.status === 0 && result.stdout.trim() === profilePath) return profilePath
  // The Windows launcher has an existing, exact persistent profile authority
  // (separate from the marker-based disposable-profile validator).
  if (process.platform === 'win32') {
    const expected = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Mozilla', 'Firefox', 'Profiles', 'egdesk-windows-poc')
    const stat = fs.lstatSync(profilePath)
    if (profilePath === expected && path.resolve(profilePath) === profilePath && stat.isDirectory()
        && !stat.isSymbolicLink() && fs.realpathSync.native(profilePath) === profilePath
        && isOwnedAndPrivate(profilePath, stat)) return profilePath
  }
  throw new Error('Firefox profile binding could not be verified')
}

export function ontologyProfileId(profilePath) {
  return createHash('sha256').update('egdesk-firefox-profile-v1\0').update(profilePath).digest('hex')
}

function reuseError(code, message) {
  return Object.assign(new Error(message), { code })
}

function bridgeHealth(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false
    let response
    const finish = (error, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const req = httpRequest({ hostname: '127.0.0.1', port, path: '/health', method: 'GET', headers: { Accept: 'application/json' }, agent: false }, res => {
      response = res
      if (res.statusCode !== 200) {
        res.resume()
        finish(reuseError('BRIDGE_HEALTH_UNAVAILABLE', 'Existing bridge health could not be verified'))
        return
      }
      let size = 0
      const chunks = []
      res.on('data', chunk => {
        size += chunk.length
        if (size > 256 * 1024) {
          finish(reuseError('BRIDGE_HEALTH_UNAVAILABLE', 'Existing bridge health exceeded its limit'))
          res.destroy()
        } else chunks.push(chunk)
      })
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid health object')
          finish(null, value)
        }
        catch { finish(reuseError('BRIDGE_HEALTH_UNAVAILABLE', 'Existing bridge health is invalid')) }
      })
      res.on('error', () => finish(reuseError('BRIDGE_HEALTH_UNAVAILABLE', 'Existing bridge health could not be read')))
    })
    req.on('error', error => {
      if (error.code === 'ECONNREFUSED') finish(null, null)
      else finish(reuseError('BRIDGE_HEALTH_UNAVAILABLE', 'Existing bridge health could not be reached'))
    })
    const timer = setTimeout(() => {
      finish(reuseError('BRIDGE_HEALTH_UNAVAILABLE', 'Existing bridge health timed out'))
      response?.destroy()
      req.destroy()
    }, timeoutMs)
    req.end()
  })
}

// Read-only reuse check; no profile files, store or process is changed. A
// stopped bridge is distinct from an occupied port with unverifiable health.
export async function checkExistingOntologyBridge({ profilePath, port = 39218, timeoutMs = 3000, expectedBuild } = {}) {
  const profileId = ontologyProfileId(verifiedProfile(profilePath))
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new TypeError('Invalid bridge probe bounds')
  const health = await bridgeHealth(port, timeoutMs)
  if (!health) return { state: 'absent' }
  if (health.ok !== true || health.port !== port || health.ontology?.profileId !== profileId) throw reuseError('BRIDGE_PROFILE_MISMATCH', 'Existing bridge profile is missing or different')
  const runtime = health.ontology?.sqlite
  const nodeMatch = typeof runtime?.nodeVersion === 'string' && runtime.nodeVersion.match(/^(\d+)\.\d+\.\d+$/)
  if (!nodeMatch || Number(nodeMatch[1]) < 24 || runtime.patched !== true || runtime.supported !== true || runtime.error !== null || !isPatchedSqliteVersion(runtime.sqliteVersion)) throw reuseError('BRIDGE_SQLITE_UNSAFE', 'Existing bridge SQLite runtime is not verified as patched')
  const expected = expectedBuild === undefined ? computeBridgeBuildHash() : expectedBuild
  if (!HEX.test(expected || '') || health.bridge?.buildHash !== expected) throw reuseError('BRIDGE_BUILD_MISMATCH', 'Existing bridge build is missing or different')
  // ready=false is allowed: the correct app can present a retryable store error.
  return { state: 'compatible' }
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  const canonical = fs.realpathSync.native(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedAndPrivate(canonical, stat)) throw new Error('Ontology directory is not private')
  return canonical
}

function privateFile(filename, maxBytes) {
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || !isOwnedAndPrivate(filename, stat, 0o077)) throw new Error('Ontology binding or baseline is not private')
  return fs.readFileSync(filename)
}

// A temp file is published create-only: concurrent launchers cannot replace
// the first baseline or token, and a failed write never becomes the baseline.
function createOnce(filename, bytes) {
  const temp = path.join(path.dirname(filename), `.ontology-${randomBytes(16).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600)
    if (process.platform === 'win32') {
      // Windows ignores POSIX mode bits. Set an explicit private DACL while
      // the new file is still empty, before writing a profile token or seed.
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const script = "$ErrorActionPreference='Stop';$p=$env:EGDESK_ONTOLOGY_ACL_FILE;$a=Get-Acl -LiteralPath $p;$u=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a.SetAccessRuleProtection($true,$false);$a.SetOwner($u);foreach($s in @($u.Value,'S-1-5-18','S-1-5-32-544')){$r=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($r)};Set-Acl -LiteralPath $p -AclObject $a"
      const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, timeout: 10000, env: { ...process.env, EGDESK_ONTOLOGY_ACL_FILE: temp },
      })
      if (result.status !== 0 || !isOwnedAndPrivate(temp, fs.lstatSync(temp), 0o077)) throw new Error('Private ontology file permissions unavailable')
    }
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    try { fs.linkSync(temp, filename) } catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function profileDataDirectory(dataDir, profileId) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !HEX.test(profileId)) throw new Error('Invalid ontology data binding')
  let directory = privateDirectory(dataDir)
  for (const component of ['ontology', 'profiles', profileId]) directory = privateDirectory(path.join(directory, component))
  return directory
}

function bindingFilename(profilePath) {
  return path.join(profilePath, 'chrome', 'resources', BINDING_NAME)
}

function parseBinding(profilePath, bytes) {
  const binding = JSON.parse(bytes.toString('utf8'))
  if (!binding || binding.version !== 1 || binding.profileId !== ontologyProfileId(profilePath) || !HEX.test(binding.token || '') || Object.keys(binding).sort().join(',') !== 'profileId,token,version') throw new Error('Firefox ontology binding is invalid')
  return Object.freeze({ profileId: binding.profileId, token: binding.token })
}

export function readOntologyProfileBinding(profilePath) {
  const verified = verifiedProfile(profilePath)
  return parseBinding(verified, privateFile(bindingFilename(verified), 4096))
}

// Called by the launcher BEFORE it installs overlay resources. Preserve the
// actual profile's existing graph first; the bundled seed is used only for a
// newly created profile without one. Neither source is deleted or edited here.
export function prepareOntologyProfileBinding({ profilePath, dataDir = appDataDirectory() }) {
  const verified = verifiedProfile(profilePath)
  const profileId = ontologyProfileId(verified)
  const directory = profileDataDirectory(dataDir, profileId)
  const baseline = path.join(directory, SEED_NAME)
  if (!fs.existsSync(baseline)) {
    const existing = path.join(verified, 'chrome', 'resources', 'ontology', 'graph.json')
    const source = fs.existsSync(existing) ? existing : BUILTIN_SEED
    const stat = fs.lstatSync(source)
    const real = fs.realpathSync.native(source)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SEED_BYTES || (source === existing && !real.startsWith(`${verified}${path.sep}`))) throw new Error('Ontology baseline cannot be preserved')
    createOnce(baseline, fs.readFileSync(source))
  }
  privateFile(baseline, MAX_SEED_BYTES)
  const chrome = privateDirectory(path.join(verified, 'chrome'))
  const resources = privateDirectory(path.join(chrome, 'resources'))
  const marker = path.join(resources, BINDING_NAME)
  if (!fs.existsSync(marker)) createOnce(marker, Buffer.from(JSON.stringify({ version: 1, profileId, token: randomBytes(32).toString('hex') })))
  return parseBinding(verified, privateFile(marker, 4096))
}

export function ontologyStoragePaths({ dataDir, profileId }) {
  const directory = profileDataDirectory(dataDir, profileId)
  return { baselinePath: path.join(directory, SEED_NAME), dbPath: path.join(directory, 'ontology.sqlite') }
}

// Called only before the first import. An initialized DB does not depend on a
// seed continuing to exist, and a changed seed cannot overwrite that DB.
export function verifyOntologyBaseline(baselinePath) {
  privateFile(baselinePath, MAX_SEED_BYTES)
}

export function openBoundOntologyStore({ binding, dataDir, openStore }) {
  if (!binding || !HEX.test(binding.profileId || '') || typeof openStore !== 'function') throw new Error('Ontology store binding unavailable')
  const { dbPath, baselinePath } = ontologyStoragePaths({ dataDir, profileId: binding.profileId })
  let opened = null
  try {
    opened = openStore({ dbPath })
    if (!opened.status().initialized) {
      verifyOntologyBaseline(baselinePath)
      // A deployed graph may not correspond to the current repository's
      // Markdown. Preserve its exact bytes without claiming any match.
      const rawGraphJson = privateFile(baselinePath, MAX_SEED_BYTES)
      const graph = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawGraphJson).replace(/^\uFEFF/, ''))
      opened.importGraph(graph, { rawGraphJson, sourceDocuments: [], sourceLabel: 'legacy-graph-baseline' })
    }
    if (!opened.integrity().ok) throw new Error('Ontology integrity check failed')
    return opened
  } catch (error) {
    try { opened?.close() } catch {}
    throw error
  }
}

function runtimeHealth(runtime) {
  return {
    nodeVersion: typeof runtime?.nodeVersion === 'string' ? runtime.nodeVersion : null,
    sqliteVersion: typeof runtime?.sqliteVersion === 'string' ? runtime.sqliteVersion : null,
    patched: runtime?.patched === true,
    supported: runtime?.supported === true,
    error: runtime?.error ? 'SQLite runtime probe failed' : null,
  }
}

const HEALTH_KEYS = new Set(['initialized', 'schemaVersion', 'graphSchemaVersion', 'sourceHash', 'graphHash', 'rawGraphHash', 'importedAt', 'sourceDocumentCount', 'counts', 'nodes', 'edges', 'snapshots', 'occurrences', 'referenceEdges', 'import'])
function publicSummary(value, depth = 0) {
  if (depth > 3) return null
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return /^[A-Za-z0-9_.:+-]{1,128}$/.test(value) ? value : null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value).filter(([key]) => HEALTH_KEYS.has(key)).map(([key, item]) => [key, publicSummary(item, depth + 1)]))
}

export async function ontologyHealth({ binding, store, runtime }) {
  let detail = null
  let ready = Boolean(binding && store)
  if (ready) {
    try {
      const status = await store.status()
      detail = publicSummary(status)
      const integrity = await store.integrity()
      ready = detail?.initialized === true && integrity?.ok === true
      detail = { ...detail, sourceMode: status?.initialized ? (status.sourceDocumentCount > 0 ? 'graph-and-archived-documents' : 'graph-only') : null, integrity: { ok: integrity?.ok === true } }
    }
    catch { ready = false }
  }
  return { profileId: binding?.profileId || null, ready, sqlite: runtimeHealth(runtime), baseline: detail }
}

function tokenMatches(actual, expected) {
  return typeof actual === 'string' && HEX.test(actual) && typeof expected === 'string' && HEX.test(expected)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

export async function handleOntologyHttp(req, url, { binding, store, runtime, send, port = 39218 } = {}) {
  if (url.pathname !== '/ontology' && !url.pathname.startsWith('/ontology/')) return false
  if (typeof send !== 'function') throw new TypeError('send is required')
  if (!guardBridgeRequest(req, port)) {
    send(403, { code: 'ONTOLOGY_LOOPBACK_REQUIRED', error: 'Trusted local origin required' })
    return true
  }
  const activeBinding = typeof binding === 'function' ? binding() : binding
  if (!activeBinding) {
    send(503, { code: 'ONTOLOGY_PROFILE_UNAVAILABLE', error: 'Firefox profile binding is unavailable' })
  } else if (req.headers['x-egdesk-ontology-profile'] !== activeBinding.profileId) {
    send(409, { code: 'ONTOLOGY_PROFILE_MISMATCH', error: 'The bridge belongs to a different Firefox profile' })
  } else if (!tokenMatches(req.headers['x-egdesk-ontology-token'], activeBinding.token)) {
    send(403, { code: 'ONTOLOGY_TOKEN_REQUIRED', error: 'The ontology profile token is invalid' })
  } else if (req.method !== 'GET' || !['/ontology/graph', '/ontology/health'].includes(url.pathname) || url.search) {
    send(404, { code: 'ONTOLOGY_ROUTE_NOT_FOUND', error: 'Unknown ontology endpoint' })
  } else {
    try {
      const activeStore = typeof store === 'function' ? await store() : store
      if (url.pathname === '/ontology/health') send(200, await ontologyHealth({ binding: activeBinding, store: activeStore, runtime }))
      else if (!activeStore) send(503, { code: 'ONTOLOGY_STORE_UNAVAILABLE', error: 'Ontology storage is unavailable' })
      else {
        const graph = await activeStore.readGraph()
        if (!graph) throw new Error('Ontology is not initialized')
        send(200, graph, { 'X-EGDesk-Ontology-Profile': activeBinding.profileId })
      }
    } catch { send(503, { code: 'ONTOLOGY_STORE_UNAVAILABLE', error: 'Ontology storage is unavailable' }) }
  }
  return true
}

export function createOntologyHttpHandler({ binding, store, runtime, port = 39218 } = {}) {
  return (req, res, url) => handleOntologyHttp(req, url, { binding, store, runtime, port, send: (status, data, headers) => {
    if (headers) {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
      res.setHeader('Access-Control-Expose-Headers', 'X-EGDesk-Ontology-Profile')
    }
    sendJson(res, status, data)
  } })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Invalid ontology binding command')
    if (process.argv[2] === '--prepare-profile') prepareOntologyProfileBinding({ profilePath: process.argv[3] })
    else if (process.argv[2] === '--check-existing-bridge') {
      const result = await checkExistingOntologyBridge({ profilePath: process.argv[3] })
      process.stdout.write(`${result.state}\n`)
    } else throw new Error('Invalid ontology binding command')
  } catch (error) {
    if (process.argv[2] === '--check-existing-bridge') {
      const detail = ['BRIDGE_HEALTH_UNAVAILABLE', 'BRIDGE_PROFILE_MISMATCH', 'BRIDGE_SQLITE_UNSAFE', 'BRIDGE_BUILD_MISMATCH'].includes(error.code)
        ? error.message : 'Existing bridge health or local build could not be verified'
      console.error(`[egdesk-ontology] Bridge reuse refused: ${detail}; no process was stopped`)
    }
    else console.error('[egdesk-ontology] Profile binding or baseline preservation failed')
    process.exitCode = 1
  }
}
