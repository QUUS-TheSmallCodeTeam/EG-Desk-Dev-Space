import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fingerprintNativeExecutable, probeGeneratedNativeSchema, probeThreadDeleteSchema, probeTurnSteerSchema } from './codex-native-schema-probe.mjs'

// These exact versions were checked against their generated experimental
// schemas and the public App Server contract. Each selected binary must still
// pass the schema probe and executable fingerprint. Unknown versions stay shut.
export const NATIVE_SCHEMA_VERSION = '0.160.1'
// This exact Windows app build was checked against its generated experimental
// schema as well. Prerelease banners never authorize an unverified build.
const CONTEXT_CONTRACT_VERSIONS = new Set(['0.157.1', '0.160.1', '0.162.1', '0.163.0-alpha.10.2'])
// Generated schema shape alone does not verify effective isolation for QA.
const QA_POLICY_CONTRACT_VERSIONS = new Set(['0.160.1', '0.163.0-alpha.10.2'])

// SUB-13: ordinary Chat follows a version range instead of the exact sets
// above, so an automatic CLI update keeps Chat running and the screen says
// 'verified' or 'not verified' (guidance, never a block). The experimental
// schema features (Context/Reader, bounded QA) keep their exact sets.
// Range policy pattern: t3code apps/server/src/provider/providerCompatibility.ts:57-101
// and packages/shared/src/semver.ts (MIT, Copyright (c) 2026 T3 Tools Inc.);
// the code here is our own.
//   supported   an exact version EG-Desk Chat was checked against
//   untested    at or above the minimum, not checked yet (Chat continues)
//   unsupported below the minimum (Chat may fail; the screen explains)
//   null        version unknown
export const ENGINE_VERSION_STATUSES = Object.freeze(['supported', 'untested', 'unsupported'])
// 0.162.1 is the schema the Chat usage, model list and account code was
// written against (codex-account-usage.mjs, codex-auth-state.mjs).
export const CODEX_CHAT_VERSION_POLICY = Object.freeze({
  verified: Object.freeze([...CONTEXT_CONTRACT_VERSIONS]),
  minimum: '0.157.0',
})

const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(value) {
  const match = typeof value === 'string' && value.length <= 80 ? SEMVER.exec(value) : null
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null } : null
}

function compareCore(left, right) {
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1
  return 0
}

export function engineVersionStatus(version, policy) {
  const parsed = parseSemver(version)
  if (!parsed) return null
  if (Array.isArray(policy?.verified) && policy.verified.includes(version)) return 'supported'
  const minimum = parseSemver(policy?.minimum)
  if (!minimum) return 'untested'
  const compared = compareCore(parsed.core, minimum.core)
  // A prerelease of the minimum itself comes before it.
  return compared < 0 || (compared === 0 && parsed.prerelease !== null) ? 'unsupported' : 'untested'
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

// These process-local overrides are an exact allowlist. No shell or config
// file is changed. With all variables unset, argv is the old launch.
// SUB-11: codexHome (absolute, an EG-Desk-owned profile folder) is returned as
// envOverrides.CODEX_HOME for the spawn. The bridge passes none today: Codex
// runs one app-server on the shared ~/.codex login until per-profile
// app-servers (own port, own process) are added.
/**
 * c23: EG-Desk's own model and effort for an own-tools thread (the same EGDESK_CODEX_MODEL / EGDESK_CODEX_EFFORT the launch builder reads, same
 * validation). null when neither is set; { model?, effort? } otherwise. Throws the launch builder's coded errors on a bad value.
 */
export function egdeskCodexSelectionFromEnv(env = process.env) {
  const hasModel = Object.hasOwn(env, 'EGDESK_CODEX_MODEL'), hasEffort = Object.hasOwn(env, 'EGDESK_CODEX_EFFORT')
  if (!hasModel && !hasEffort) return null
  const model = hasModel ? env.EGDESK_CODEX_MODEL : null, effort = hasEffort ? env.EGDESK_CODEX_EFFORT : null
  if (hasModel && (typeof model !== 'string' || !MODEL_ID.test(model))) throw Object.assign(new Error('EGDESK_CODEX_MODEL must be a bounded model identifier'), { code: 'INVALID_CODEX_MODEL_OVERRIDE' })
  if (hasEffort && (typeof effort !== 'string' || !REASONING_EFFORTS.has(effort))) throw Object.assign(new Error('EGDESK_CODEX_EFFORT must be a supported reasoning effort'), { code: 'INVALID_CODEX_EFFORT_OVERRIDE' })
  return { ...(hasModel ? { model } : {}), ...(hasEffort ? { effort } : {}) }
}

export function buildCodexAppServerLaunch({ env = process.env, listen, codexHome = null } = {}) {
  if (typeof listen !== 'string' || !listen) throw new TypeError('An app-server listen URL is required')
  if (codexHome != null && (typeof codexHome !== 'string' || !path.isAbsolute(codexHome) || codexHome.includes('\0') || codexHome.length > 4096)) {
    throw Object.assign(new Error('codexHome must be an absolute path'), { code: 'INVALID_CODEX_HOME' })
  }
  const hasModel = Object.hasOwn(env, 'EGDESK_CODEX_MODEL')
  const hasEffort = Object.hasOwn(env, 'EGDESK_CODEX_EFFORT')
  const disableMemories = Object.hasOwn(env, 'EGDESK_CODEX_DISABLE_MEMORIES')
  const model = hasModel ? env.EGDESK_CODEX_MODEL : null
  const effort = hasEffort ? env.EGDESK_CODEX_EFFORT : null
  if (hasModel && (typeof model !== 'string' || !MODEL_ID.test(model))) {
    throw Object.assign(new Error('EGDESK_CODEX_MODEL must be a bounded model identifier'), { code: 'INVALID_CODEX_MODEL_OVERRIDE' })
  }
  if (hasEffort && (typeof effort !== 'string' || !REASONING_EFFORTS.has(effort))) {
    throw Object.assign(new Error('EGDESK_CODEX_EFFORT must be a supported reasoning effort'), { code: 'INVALID_CODEX_EFFORT_OVERRIDE' })
  }
  if (disableMemories && env.EGDESK_CODEX_DISABLE_MEMORIES !== '1') {
    throw Object.assign(new Error('EGDESK_CODEX_DISABLE_MEMORIES accepts only 1'), { code: 'INVALID_CODEX_MEMORY_OVERRIDE' })
  }
  const args = ['app-server']
  if (hasModel) args.push('-c', `model=${JSON.stringify(model)}`)
  if (hasEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`)
  if (disableMemories) args.push('-c', 'features.memories=false')
  args.push('--listen', listen)
  return { args, configuredModel: model, configuredEffort: effort, hasOverrides: hasModel || hasEffort, disableMemories, envOverrides: codexHome ? { CODEX_HOME: codexHome } : {} }
}

export async function verifyCodexMemoryFeatureDisabled(request) {
  const seen = new Set()
  let cursor = null, found = false
  const unavailable = () => Object.assign(new Error('Owned App Server did not confirm Memories disabled'), { code: 'CODEX_MEMORY_ISOLATION_UNVERIFIED' })
  for (let page = 0; page < 8; page++) {
    let result
    try { result = await request('experimentalFeature/list', { limit: 100, ...(cursor ? { cursor } : {}) }) }
    catch { throw unavailable() }
    if (!Array.isArray(result?.data)) throw unavailable()
    for (const feature of result.data) if (feature?.name === 'memories') {
      if (found || feature.enabled !== false) throw unavailable()
      found = true
    }
    if (result.nextCursor == null) {
      if (!found) throw unavailable()
      return { status: 'verified-disabled', feature: 'memories' }
    }
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) throw unavailable()
    seen.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw unavailable()
}

export function verifyCodexLaunchConfiguration(launch, result) {
  const config = result?.config
  const effectiveModel = typeof config?.model === 'string' && config.model ? config.model : null
  const effectiveEffort = typeof config?.model_reasoning_effort === 'string' && config.model_reasoning_effort ? config.model_reasoning_effort : null
  for (const [expected, actual] of [[launch.configuredModel, effectiveModel], [launch.configuredEffort, effectiveEffort]]) {
    if (expected !== null && actual === null) throw Object.assign(new Error('Codex did not report the configured model or reasoning effort'), { code: 'CODEX_LAUNCH_CONFIG_UNVERIFIED' })
    if (expected !== null && actual !== expected) throw Object.assign(new Error('Codex reported a different effective model or reasoning effort'), { code: 'CODEX_LAUNCH_CONFIG_MISMATCH' })
  }
  return { status: 'verified', configuredModel: launch.configuredModel, configuredEffort: launch.configuredEffort, effectiveModel, effectiveEffort }
}

// Run the same ordered metadata preflight used by the bridge before making
// Chat ready. If Memories isolation was requested, *any* failed preflight
// stops only the App Server child owned by that bridge, including a model or
// effort mismatch that happens before the Memories feature check.
export async function preflightOwnedAppServer({ launch, request, cwd, isCurrent = () => true, stopOwnedChild = () => {} }) {
  let modelProof = null, memoryProof = null, stage = 'model'
  try {
    if (launch.hasOverrides) {
      const config = await request('config/read', { includeLayers: false, cwd })
      if (!isCurrent()) return { stale: true }
      modelProof = verifyCodexLaunchConfiguration(launch, config)
    }
    stage = 'memories'
    if (launch.disableMemories) {
      memoryProof = await verifyCodexMemoryFeatureDisabled(request)
      if (!isCurrent()) return { stale: true }
    }
    return { stale: false, ready: true, reconnectBlocked: false, modelProof, memoryProof }
  } catch (error) {
    if (!isCurrent()) return { stale: true }
    if (launch.disableMemories) {
      try { stopOwnedChild() } catch {}
    }
    return { stale: false, ready: false, reconnectBlocked: true, failedStage: stage, error, modelProof, memoryProof }
  }
}

export function resolveCodexExecutable(env = process.env, { platform = process.platform } = {}) {
  const selected = env.EGDESK_CODEX_BIN || 'codex'
  const name = platform === 'win32' && !path.extname(selected) ? `${selected}.exe` : selected
  const searchPath = env.PATH || env.Path || env.path || ''
  const candidates = path.isAbsolute(selected) ? [selected] : /[\\/]/.test(selected) ? []
    : searchPath.split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean).map(dir => path.join(dir, name))
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate) } catch {}
  }
  throw new Error('Configured Codex executable is unavailable; set EGDESK_CODEX_BIN to an existing absolute executable path')
}

export function inspectNativeCapabilities({ executable, env = process.env, cwd = process.cwd(), run = spawnSync, probe = probeGeneratedNativeSchema, fingerprint = fingerprintNativeExecutable, deleteProbe = probeThreadDeleteSchema, steerProbe = probeTurnSteerSchema }) {
  const result = run(executable, ['--version'], { env, cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] })
  const version = result.status === 0 ? String(result.stdout || '').trim().match(/^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/)?.[1] || null : null
  let proof = null, binaryFingerprint = null
  if (CONTEXT_CONTRACT_VERSIONS.has(version)) {
    try {
      proof = probe({ executable, env, cwd, run })
      if (proof?.contextContract && /^[a-f0-9]{64}$/.test(proof.schemaFingerprint || '')) binaryFingerprint = fingerprint(executable)
    } catch { proof = null; binaryFingerprint = null }
  }
  // thread/delete (L2 c18): an optional contract of the generated schema. A contract version reads it from the same probe; any other identified
  // version is checked for it alone (deleteProbe), which grants nothing else.
  let deleteFingerprint = null, deleteBinary = binaryFingerprint
  try {
    deleteFingerprint = CONTEXT_CONTRACT_VERSIONS.has(version) ? proof?.threadDeleteSchemaFingerprint ?? null : version ? deleteProbe({ executable, env, cwd, run }) : null
    if (/^[a-f0-9]{64}$/.test(deleteFingerprint || '') && !deleteBinary) deleteBinary = fingerprint(executable)
  } catch { deleteFingerprint = null }
  const threadDelete = /^[a-f0-9]{64}$/.test(deleteFingerprint || '') && /^[a-f0-9]{64}$/.test(deleteBinary || '')
  // turn/steer (c23): a capability of this binary's own generated schema, for any identified version (no version pin); it covers a plain message
  // steered into a working turn only, never additional context (that stays the board peer contract).
  let steerFingerprint = null, steerBinary = deleteBinary || binaryFingerprint
  try {
    steerFingerprint = CONTEXT_CONTRACT_VERSIONS.has(version) ? proof?.turnSteerSchemaFingerprint ?? null : version ? steerProbe({ executable, env, cwd, run }) : null
    if (/^[a-f0-9]{64}$/.test(steerFingerprint || '') && !steerBinary) steerBinary = fingerprint(executable)
  } catch { steerFingerprint = null }
  const steerContract = /^[a-f0-9]{64}$/.test(steerFingerprint || '') && /^[a-f0-9]{64}$/.test(steerBinary || '')
    ? createHash('sha256').update(`steer\0${version}\0${steerBinary}\0${steerFingerprint}`).digest('hex') : null
  const contextContract = CONTEXT_CONTRACT_VERSIONS.has(version) && proof?.contextContract === true && /^[a-f0-9]{64}$/.test(binaryFingerprint || '')
  const qaContract = contextContract && QA_POLICY_CONTRACT_VERSIONS.has(version) && proof.qaContract === true
  const contractFingerprint = contextContract ? createHash('sha256').update(`${version}\0${binaryFingerprint}\0${proof.schemaFingerprint}`).digest('hex') : null
  return {
    executable, version, schemaVersion: NATIVE_SCHEMA_VERSION,
    // Ordinary Chat (range policy); schemaMatch stays the exact experimental contract.
    versionStatus: engineVersionStatus(version, CODEX_CHAT_VERSION_POLICY),
    schemaMatch: contextContract, experimentalApi: true,
    dynamicTools: contextContract, readerReadOnly: contextContract,
    qaReadOnly: qaContract,
    // This source version's handler validates expectedTurnId and enqueues the
    // untrusted additional context. Never infer either fact from ordinary chat.
    boardPeerContract: contextContract && version === '0.162.1' && /^[a-f0-9]{64}$/.test(proof?.boardPeerSchemaFingerprint || '')
      ? createHash('sha256').update(contractFingerprint + '\0' + proof.boardPeerSchemaFingerprint).digest('hex') : null,
    // The generated schema of this binary lists thread/delete with { threadId }: deleting a conversation also deletes its native thread.
    threadDelete,
    // A plain message may be steered into a working turn: the schema of this binary has turn/steer in the shape verifyTurnSteerSchema reads.
    steerContract,
    binaryFingerprint: contextContract ? binaryFingerprint : null,
    schemaFingerprint: contextContract ? proof.schemaFingerprint : null,
    contractFingerprint,
  }
}

/**
 * What one Codex binary can do, as the generated schema of THAT binary says (L1 c22): dynamicTools (the Context contract), ephemeral (thread/start's
 * `ephemeral`, part of the same contract), turnSteer (the verified peer-input contract of turn/steer) and threadDelete. Each binary is probed on its
 * own (a profile's app-server may run another build than the shared one) and remembered by path, size and modification time, so a replaced binary is
 * probed again. A probe that fails is not remembered. Nothing here is inherited from another binary.
 */
export function capabilitiesOf(native) {
  if (!native || typeof native !== 'object') return null
  return Object.freeze({
    version: typeof native.version === 'string' ? native.version : null,
    dynamicTools: native.dynamicTools === true, ephemeral: native.schemaMatch === true,
    turnSteer: typeof native.boardPeerContract === 'string' && native.boardPeerContract.length > 0, threadDelete: native.threadDelete === true,
    boardPeerContract: typeof native.boardPeerContract === 'string' ? native.boardPeerContract : null,
    steer: typeof native.steerContract === 'string' && native.steerContract.length > 0, steerContract: typeof native.steerContract === 'string' ? native.steerContract : null,
    executable: native.executable ?? null,
  })
}
export function createNativeCapabilityCache({ inspect = inspectNativeCapabilities, stat = statSync, env = process.env, cwd = process.cwd() } = {}) {
  const seen = new Map()
  return function forExecutable(executable) {
    if (typeof executable !== 'string' || !executable) return null
    let key = null
    try { const s = stat(executable); key = `${executable}\0${s.size}\0${Math.round(s.mtimeMs)}` } catch { return null }
    if (seen.has(key)) return seen.get(key)
    let caps = null
    try { caps = capabilitiesOf(inspect({ executable, env, cwd })) } catch { caps = null }
    if (caps) { seen.set(key, caps); while (seen.size > 16) seen.delete(seen.keys().next().value) }
    return caps
  }
}
