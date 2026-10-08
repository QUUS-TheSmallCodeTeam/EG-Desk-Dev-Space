import { accessSync, constants, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

// 0.157.1 is the existing pinned Context/Reader baseline. 0.160.1 was checked
// against this CLI's generated experimental schemas and the public App Server
// contract. Unknown versions remain closed until their protocol is reviewed.
export const NATIVE_SCHEMA_VERSION = '0.160.1'
const CONTEXT_CONTRACT_VERSIONS = new Set(['0.157.1', '0.160.1'])
const QA_POLICY_CONTRACT_VERSIONS = new Set(['0.160.1'])

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

// These two process-local overrides are the entire allowlist. Their values are
// quoted as TOML strings inside separate argv entries; no shell or config file
// is changed. With both variables unset, argv is byte-for-byte the old launch.
export function buildCodexAppServerLaunch({ env = process.env, listen } = {}) {
  if (typeof listen !== 'string' || !listen) throw new TypeError('An app-server listen URL is required')
  const hasModel = Object.hasOwn(env, 'EGDESK_CODEX_MODEL')
  const hasEffort = Object.hasOwn(env, 'EGDESK_CODEX_EFFORT')
  const model = hasModel ? env.EGDESK_CODEX_MODEL : null
  const effort = hasEffort ? env.EGDESK_CODEX_EFFORT : null
  if (hasModel && (typeof model !== 'string' || !MODEL_ID.test(model))) {
    throw Object.assign(new Error('EGDESK_CODEX_MODEL must be a bounded model identifier'), { code: 'INVALID_CODEX_MODEL_OVERRIDE' })
  }
  if (hasEffort && (typeof effort !== 'string' || !REASONING_EFFORTS.has(effort))) {
    throw Object.assign(new Error('EGDESK_CODEX_EFFORT must be a supported reasoning effort'), { code: 'INVALID_CODEX_EFFORT_OVERRIDE' })
  }
  const args = ['app-server']
  if (hasModel) args.push('-c', `model=${JSON.stringify(model)}`)
  if (hasEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`)
  args.push('--listen', listen)
  return { args, configuredModel: model, configuredEffort: effort, hasOverrides: hasModel || hasEffort }
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

export function resolveCodexExecutable(env = process.env) {
  const selected = env.EGDESK_CODEX_BIN || 'codex'
  const candidates = path.isAbsolute(selected) ? [selected] : selected.includes(path.sep) ? [] : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, selected))
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate) } catch {}
  }
  throw new Error('Configured Codex executable is unavailable; set EGDESK_CODEX_BIN to an existing absolute executable path')
}

export function inspectNativeCapabilities({ executable, env = process.env, cwd = process.cwd(), run = spawnSync }) {
  const result = run(executable, ['--version'], { env, cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] })
  const version = result.status === 0 ? String(result.stdout || '').trim().match(/^codex-cli (\d+\.\d+\.\d+)$/)?.[1] || null : null
  const contextContract = CONTEXT_CONTRACT_VERSIONS.has(version)
  return {
    executable, version, schemaVersion: NATIVE_SCHEMA_VERSION,
    schemaMatch: contextContract, experimentalApi: true,
    dynamicTools: contextContract, readerReadOnly: contextContract,
    qaReadOnly: QA_POLICY_CONTRACT_VERSIONS.has(version),
  }
}
