import { accessSync, constants, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fingerprintNativeExecutable, probeGeneratedNativeSchema } from './codex-native-schema-probe.mjs'

// 0.157.1 is the existing pinned Context/Reader baseline. 0.160.1 was checked
// against this CLI's generated experimental schemas and the public App Server
// contract. Unknown versions remain closed until their protocol is reviewed.
export const NATIVE_SCHEMA_VERSION = '0.160.1'
const CONTEXT_CONTRACT_VERSIONS = new Set(['0.157.1', '0.160.1'])
const QA_POLICY_CONTRACT_VERSIONS = new Set(['0.160.1'])

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

// These process-local overrides are an exact allowlist. No shell or config
// file is changed. With all variables unset, argv is the old launch.
export function buildCodexAppServerLaunch({ env = process.env, listen } = {}) {
  if (typeof listen !== 'string' || !listen) throw new TypeError('An app-server listen URL is required')
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
  return { args, configuredModel: model, configuredEffort: effort, hasOverrides: hasModel || hasEffort, disableMemories }
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

export function resolveCodexExecutable(env = process.env) {
  const selected = env.EGDESK_CODEX_BIN || 'codex'
  const candidates = path.isAbsolute(selected) ? [selected] : selected.includes(path.sep) ? [] : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, selected))
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate) } catch {}
  }
  throw new Error('Configured Codex executable is unavailable; set EGDESK_CODEX_BIN to an existing absolute executable path')
}

export function inspectNativeCapabilities({ executable, env = process.env, cwd = process.cwd(), run = spawnSync, probe = probeGeneratedNativeSchema, fingerprint = fingerprintNativeExecutable }) {
  const result = run(executable, ['--version'], { env, cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] })
  const version = result.status === 0 ? String(result.stdout || '').trim().match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1] || null : null
  let proof = null, binaryFingerprint = null
  if (CONTEXT_CONTRACT_VERSIONS.has(version)) {
    try {
      proof = probe({ executable, env, cwd, run })
      if (proof?.contextContract && /^[a-f0-9]{64}$/.test(proof.schemaFingerprint || '')) binaryFingerprint = fingerprint(executable)
    } catch { proof = null; binaryFingerprint = null }
  }
  const contextContract = CONTEXT_CONTRACT_VERSIONS.has(version) && proof?.contextContract === true && /^[a-f0-9]{64}$/.test(binaryFingerprint || '')
  const qaContract = contextContract && QA_POLICY_CONTRACT_VERSIONS.has(version) && proof.qaContract === true
  const contractFingerprint = contextContract ? createHash('sha256').update(`${version}\0${binaryFingerprint}\0${proof.schemaFingerprint}`).digest('hex') : null
  return {
    executable, version, schemaVersion: NATIVE_SCHEMA_VERSION,
    schemaMatch: contextContract, experimentalApi: true,
    dynamicTools: contextContract, readerReadOnly: contextContract,
    qaReadOnly: qaContract,
    binaryFingerprint: contextContract ? binaryFingerprint : null,
    schemaFingerprint: contextContract ? proof.schemaFingerprint : null,
    contractFingerprint,
  }
}
