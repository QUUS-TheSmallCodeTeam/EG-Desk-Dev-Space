// Server-owned evidence for the Claude source Reader (SUB-09/SUB-10, engine
// design §14.9 "실계정 활성화 전에 남은 연결" 1-3).
//
//   readCapacity({authority, run, configuration})   ContextRuntime/Reader getReadCapacity
//     The selected parent Claude conversation's own native get_context_usage
//     (collected by claude-engine-adapter after init, after each turn and right
//     before an egdesk_read_source call is handed to the runtime), the MCP
//     output ceiling EG-Desk applied to that very process (MAX_MCP_OUTPUT_TOKENS,
//     egdesk-claude-limits) and the UTF-8 byte upper-bound estimator. Nothing is
//     taken from a model-name table, an HTTP field or Codex metadata.
//   isolationProof({authority, configuration})      Reader getIsolationProof
//     A local managed-policy inventory (managed-settings.json, its .d drop-ins,
//     managed-mcp.json, the macOS managed-preferences plist) plus the absence of
//     hook events on any parent stream of this build and of API-key variables.
//     Managed hooks cannot be switched off by --settings/--safe-mode, so any
//     managed hook, apiKeyHelper or unreadable policy refuses the Reader.
//
// Both are synchronous (the Reader re-checks them every 50 ms) and return null
// when the evidence is missing, stale or for another scope; callers then report
// ENGINE_CAPACITY_UNKNOWN / READER_ISOLATION_UNAVAILABLE. Never logs.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { detectApiKeyEnv } from './claude-engine-transport.mjs'
import { claudeReaderCapacityObservation } from './egdesk-claude-reader.mjs'
import { CLAUDE_UTF8_ESTIMATOR } from './egdesk-claude-limits.mjs'

export const CLAUDE_CAPACITY_DEFAULTS = Object.freeze({
  observationTtlMs: 30 * 60_000, // same conversation; the tool-call refresh supplies fresh values at read time
  policyTtlMs: 60_000,
  // [추정] tool_result + MCP CallToolResult framing around a delivered packet.
  parentInputOverheadTokens: 512,
  // [추정] Reader fixed input beyond its payload (CLI base prompt with
  // --system-prompt replaced, no tools). The Reader also re-measures natively
  // with its own get_context_usage before sending (egdesk-claude-reader start()).
  readerInputOverheadTokens: 8192,
  readerMaxInputTokens: 65536,
})

const MANAGED_DIRS = Object.freeze({
  darwin: '/Library/Application Support/ClaudeCode',
  win32: 'C:\\Program Files\\ClaudeCode',
  other: '/etc/claude-code',
})
const MACOS_MANAGED_PLISTS = Object.freeze(['/Library/Managed Preferences/com.anthropic.claudecode.plist'])

const sha = text => createHash('sha256').update(text).digest('hex')
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
const nonempty = value => Array.isArray(value) ? value.length > 0 : Boolean(plainObject(value) && Object.keys(value).length)

/** Where Claude Code reads managed (administrator) policy on this platform. */
export function claudeManagedPolicyPaths(platform = process.platform) {
  const dir = MANAGED_DIRS[platform] || MANAGED_DIRS.other
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  return {
    settings: join(dir, 'managed-settings.json'),
    settingsDir: join(dir, 'managed-settings.d'),
    mcp: join(dir, 'managed-mcp.json'),
    plists: platform === 'darwin' ? [...MACOS_MANAGED_PLISTS] : [],
  }
}

/**
 * Local managed-policy inventory. Pure apart from the injected fs.
 *   → { status: 'clear' | 'blocked', reasons: [code...], sources: [path...], hash }
 * Codes: managed-hooks, managed-api-key-helper, managed-api-key-env,
 * managed-mcp, managed-plist-unverifiable, managed-settings-unreadable.
 */
export function probeClaudeManagedPolicy({ platform = process.platform, fileSystem = fs } = {}) {
  const paths = claudeManagedPolicyPaths(platform)
  const reasons = new Set(), sources = [], digest = []
  const exists = file => { try { return fileSystem.existsSync(file) } catch { return true } } // unknown counts as present
  const inspectSettings = file => {
    sources.push(file)
    let value
    try {
      const text = fileSystem.readFileSync(file, 'utf8')
      digest.push(`${file}\0${sha(text)}`)
      value = JSON.parse(text)
    } catch { reasons.add('managed-settings-unreadable'); return }
    if (!plainObject(value)) { reasons.add('managed-settings-unreadable'); return }
    if (nonempty(value.hooks) || value.allowManagedHooksOnly === true) reasons.add('managed-hooks')
    if (typeof value.apiKeyHelper === 'string' && value.apiKeyHelper) reasons.add('managed-api-key-helper')
    const env = plainObject(value.env)
    if (env && detectApiKeyEnv(env, { platform }).length) reasons.add('managed-api-key-env')
    if (nonempty(value.mcpServers) || nonempty(value.allowedMcpServers) || value.enableAllProjectMcpServers === true) reasons.add('managed-mcp')
  }
  if (exists(paths.settings)) inspectSettings(paths.settings)
  if (exists(paths.settingsDir)) {
    let names = null
    try { names = fileSystem.readdirSync(paths.settingsDir).filter(name => name.endsWith('.json')).sort() } catch { reasons.add('managed-settings-unreadable') }
    const join = platform === 'win32' ? path.win32.join : path.posix.join
    for (const name of names || []) inspectSettings(join(paths.settingsDir, name))
  }
  if (exists(paths.mcp)) { sources.push(paths.mcp); reasons.add('managed-mcp') }
  // A binary plist is not parsed here; its presence alone means unverifiable.
  for (const plist of paths.plists) if (exists(plist)) { sources.push(plist); reasons.add('managed-plist-unverifiable') }
  const list = [...reasons].sort()
  return { status: list.length ? 'blocked' : 'clear', reasons: list, sources,
    hash: sha(JSON.stringify({ platform, sources, digest, reasons: list })) }
}

/**
 * createClaudeReaderEvidence({ adapter, snapshot, env, platform, now, probe, ... })
 *   adapter: claude-engine-adapter (contextObservation, baselineObservation,
 *            ownerKey, isolationEvents)
 *   snapshot(): claude-engine-auth status { version, auth }
 */
export function createClaudeReaderEvidence({ adapter, snapshot, env = process.env, platform = process.platform, now = Date.now,
  probe = () => probeClaudeManagedPolicy({ platform }), limits = {} } = {}) {
  if (!adapter || typeof adapter.contextObservation !== 'function' || typeof snapshot !== 'function') {
    throw new TypeError('createClaudeReaderEvidence requires the Claude adapter and status snapshot')
  }
  const L = { ...CLAUDE_CAPACITY_DEFAULTS, ...limits }
  let policy = null // { at, value }

  function observationFor(authority, run) {
    const threadId = run?.conversationId || authority?.conversationId || null
    const own = threadId ? adapter.contextObservation(threadId) : null
    if (own) return own
    // A conversation whose process has not started yet: the newest baseline
    // (taken after init, before any user message) of this owner. [추정]
    return typeof adapter.baselineObservation === 'function' ? adapter.baselineObservation() : null
  }

  function readCapacity({ authority, run = null, configuration = null } = {}) {
    if (authority?.engineId !== 'claude') return null
    const status = snapshot() || {}
    const observation = observationFor(authority, run)
    if (!observation || observation.ownerKey !== authority.ownerKey || observation.ownerKey !== adapter.ownerKey()) return null
    if (observation.engineBuild !== status.version || !(observation.observedAt > 0) || observation.observedAt > now() ||
        now() - observation.observedAt > L.observationTtlMs) return null
    const model = configuration?.model || observation.usage?.model
    let native
    try { native = claudeReaderCapacityObservation(observation.usage, { model, engineBuild: observation.engineBuild, now: observation.observedAt }) }
    catch { return null }
    if (!Number.isSafeInteger(observation.mcpOutputLimitTokens) || observation.mcpOutputLimitTokens <= 0) return null
    const revision = sha(JSON.stringify([model, observation.engineBuild, observation.ownerKey, observation.threadId]))
    const metadataHash = sha(JSON.stringify([native.metadataHash, observation.mcpOutputLimitTokens, CLAUDE_UTF8_ESTIMATOR.version, observation.basis]))
    const window = native.usableContextWindow
    const maxInputTokens = Math.min(L.readerMaxInputTokens, window - Math.min(4096, Math.floor(window / 4)) - Math.max(1024, Math.ceil(window * 0.15)))
    if (!(maxInputTokens > L.readerInputOverheadTokens)) return null
    return {
      capacity: { ...native, status: 'verified', metadataHash, modelSelectionRevision: revision,
        toolOutputLimitTokens: observation.mcpOutputLimitTokens, inputOverheadTokens: L.parentInputOverheadTokens,
        estimator: { ...CLAUDE_UTF8_ESTIMATOR }, basis: observation.basis,
        scope: { engineId: authority.engineId, engineProfileId: authority.engineProfileId, ownerKey: authority.ownerKey, epoch: authority.epoch } },
      usage: { usedTokens: native.usedTokens },
      readerBudget: { maxInputTokens, inputOverheadTokens: L.readerInputOverheadTokens },
      selection: { model, revision },
      engineBuild: observation.engineBuild,
    }
  }

  function policyInventory() {
    if (!policy || now() - policy.at > L.policyTtlMs || policy.at > now()) {
      let value
      try { value = probe() } catch { value = { status: 'blocked', reasons: ['managed-settings-unreadable'], sources: [], hash: sha('probe-failed') } }
      policy = { at: now(), value }
    }
    return policy.value
  }

  function isolationProof({ authority } = {}) {
    if (authority?.engineId !== 'claude' || authority.ownerKey !== adapter.ownerKey()) return null
    const status = snapshot() || {}
    if (typeof status.version !== 'string') return null
    const inventory = policyInventory()
    const hookEvents = typeof adapter.isolationEvents === 'function' ? adapter.isolationEvents() : null
    if (inventory?.status !== 'clear' || !hookEvents || hookEvents.hookEvents > 0) return null
    let apiKeys = []
    try { apiKeys = detectApiKeyEnv(env, { platform }) } catch { return null }
    if (apiKeys.length) return null
    return { status: 'verified', engineId: 'claude', engineProfileId: authority.engineProfileId, ownerKey: authority.ownerKey, epoch: authority.epoch,
      engineBuild: status.version, metadataHash: sha(JSON.stringify([inventory.hash, status.version])),
      expiresAt: policy.at + L.policyTtlMs, hooksDisabled: true, noApiKey: true, sources: [...inventory.sources] }
  }

  /** Why the Reader is not ready, for the engine row/status (codes only). */
  function explain({ authority, run = null, configuration = null } = {}) {
    const inventory = policyInventory()
    return {
      capacity: readCapacity({ authority, run, configuration }) ? 'verified' : 'unknown',
      policy: inventory?.status || 'blocked', policyReasons: [...(inventory?.reasons || [])],
      hookEvents: adapter.isolationEvents?.()?.hookEvents ?? null,
    }
  }

  return { readCapacity, isolationProof, explain, refreshPolicy: () => { policy = null; return policyInventory() } }
}
