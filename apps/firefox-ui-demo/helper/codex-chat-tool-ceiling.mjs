import { chatError } from './codex-chat-values.mjs'
import { disabledNativeMcpConfig, listNativeMcpServers, readNativeDirectMcpServerIds } from './codex-chat-execution-policy.mjs'
import { normalizeToolCeiling } from './egdesk-profile-store.mjs'

// AGENT-04: a saved Agent profile's tool ceiling, enforced on the Codex
// thread it runs on. A ceiling only narrows what the user's own Codex setup
// and this run's grants allow; it never widens them. null means no ceiling.

// Browser tools a ceiling of 'observe' still allows.
const BROWSER_OBSERVE_TOOLS = new Set(['egdesk_browser_observe'])
// Codex native features that drive a browser or the desktop themselves.
const NATIVE_BROWSER_FEATURES = ['browser_use', 'browser_use_external', 'computer_use']

export const CEILING_MESSAGES = Object.freeze({
  browserNone: '이 Agent는 브라우저 사용이 허용되지 않습니다',
  browserObserve: '이 Agent는 브라우저 조작이 허용되지 않습니다',
  browserDropped: '이 Agent는 브라우저를 쓸 수 없어 선택한 브라우저를 연결하지 않았습니다',
  browserDowngraded: '이 Agent는 브라우저를 보기만 할 수 있어 조작 허용은 적용하지 않았습니다',
  files: '이 Agent는 파일 쓰기가 허용되지 않습니다',
  terminal: '이 Agent는 터미널 명령이 허용되지 않습니다',
  network: '이 Agent는 인터넷 연결이 허용되지 않습니다',
})

/**
 * What this run enforces: the profile's ceiling with terminal 'allow' read
 * as 'ask' (automatic approval is not implemented). Fixed keys, or null.
 */
export function effectiveToolCeiling(value) {
  let ceiling
  try { ceiling = normalizeToolCeiling(value) }
  catch { throw chatError('INVALID_PROFILE', 'Saved profile has an unreadable tool ceiling', 500) }
  if (!ceiling) return null
  return { ...ceiling, terminal: ceiling.terminal === 'allow' ? 'ask' : ceiling.terminal }
}

/** A recorded run ceiling, re-read from history; anything else is dropped. */
export function recordedToolCeiling(value) {
  try { return value && typeof value === 'object' ? effectiveToolCeiling(value) : null } catch { return null }
}

export function ceilingNarrows(ceiling) {
  return Boolean(ceiling) && (ceiling.browser !== 'interact' || ceiling.files !== 'write'
    || ceiling.terminal === 'none' || ceiling.network === 'off' || ceiling.mcp === 'none')
}

export function ceilingAllowsBrowserTool(ceiling, tool) {
  if (!ceiling || ceiling.browser === 'interact') return true
  return ceiling.browser === 'observe' && BROWSER_OBSERVE_TOOLS.has(tool)
}

/** The message for a refused Browser tool call. */
export function browserRefusal(ceiling) {
  return { axis: 'browser', title: ceiling.browser === 'none' ? CEILING_MESSAGES.browserNone : CEILING_MESSAGES.browserObserve }
}

/**
 * Which axis refuses a native approval request, or null. An escalated
 * command leaves the sandbox, so it may also write files or reach the
 * network: a read-only or offline ceiling refuses it as well.
 */
export function ceilingApprovalRefusal(ceiling, { kind, network = false }) {
  if (!ceiling) return null
  if (kind === 'fileChange') return ceiling.files === 'read' ? { axis: 'files', title: CEILING_MESSAGES.files } : null
  if (kind !== 'commandExecution') return null
  if (network) return ceiling.network === 'off' ? { axis: 'network', title: CEILING_MESSAGES.network } : null
  if (ceiling.terminal === 'none') return { axis: 'terminal', title: CEILING_MESSAGES.terminal }
  if (ceiling.files === 'read') return { axis: 'files', title: CEILING_MESSAGES.files }
  if (ceiling.network === 'off') return { axis: 'network', title: CEILING_MESSAGES.network }
  return null
}

/**
 * The selected sources a Browser provider may see under this ceiling.
 * 'observe' turns an interaction grant into observation; 'none' drops the
 * Browser provider's preparation altogether (the caller skips it).
 */
export function ceilingBrowserSelection(ceiling, sources) {
  if (!ceiling || ceiling.browser === 'interact' || !Array.isArray(sources)) return { sources, downgraded: false }
  let downgraded = false
  const narrowed = sources.map(source => {
    if (source?.browserToolPermission !== 'interact') return source
    downgraded = true
    return { ...source, browserToolPermission: 'observe' }
  })
  return { sources: narrowed, downgraded }
}

export function liveBrowserSelected(sources) {
  return Array.isArray(sources) && sources.some(source => source?.browserToolSelection != null)
}

const unavailable = () => chatError('PROFILE_CEILING_UNAVAILABLE', 'Agent tool limits could not be prepared from the native configuration; no turn was started', 502)
const unverified = axis => chatError('PROFILE_CEILING_UNVERIFIED', `The native thread did not confirm the Agent ${axis} limit; no turn was started`, 502)

async function readSandboxMode(request, cwd) {
  let result
  try { result = await request('config/read', { includeLayers: false, cwd }) } catch { throw unavailable() }
  const mode = result?.config?.sandbox_mode
  if (!result?.config || (mode != null && !['read-only', 'workspace-write', 'danger-full-access'].includes(mode))) throw unavailable()
  return mode ?? null
}

/**
 * Native thread/start or thread/resume overrides for a narrowing ceiling.
 * Bounded QA threads are already read-only, offline and MCP-free; they only
 * gain the shell and native browser switches.
 */
export async function loadCeilingThreadOverrides(request, ceiling, { bounded = false, cwd = null } = {}) {
  if (!ceilingNarrows(ceiling)) return null
  const features = {}
  if (ceiling.terminal === 'none') features.shell_tool = false
  if (ceiling.browser !== 'interact') for (const name of NATIVE_BROWSER_FEATURES) features[name] = false
  const config = {}
  const overrides = {}
  if (!bounded) {
    if (ceiling.files === 'read') overrides.sandbox = 'read-only'
    if (ceiling.network === 'off') {
      config.web_search = 'disabled'
      config.sandbox_workspace_write = { network_access: false }
      if (ceiling.files !== 'read') {
        // Narrow full access to the workspace sandbox; never widen read-only.
        // An unset mode keeps the native default, checked after start.
        const mode = await readSandboxMode(request, cwd)
        if (mode === 'danger-full-access' || mode === 'workspace-write') overrides.sandbox = 'workspace-write'
        else if (mode === 'read-only') overrides.sandbox = 'read-only'
      }
    }
    if (ceiling.mcp === 'none') {
      let mcp
      try { mcp = disabledNativeMcpConfig(await listNativeMcpServers(request, null), await readNativeDirectMcpServerIds(request, cwd)) }
      catch { throw unavailable() }
      Object.assign(config, mcp)
      features.apps = false
    }
  }
  if (Object.keys(features).length) config.features = features
  if (Object.keys(config).length) overrides.config = config
  return Object.keys(overrides).length ? overrides : null
}

/** Adds ceiling overrides; nested config tables merge, other fields are set. */
export function mergeCeilingOverrides(target, extra) {
  if (!extra) return target
  for (const [key, value] of Object.entries(extra)) {
    if (key !== 'config') { target[key] = value; continue }
    const config = { ...(target.config || {}) }
    for (const [name, part] of Object.entries(value)) {
      config[name] = part && typeof part === 'object' && !Array.isArray(part) && config[name] && typeof config[name] === 'object'
        ? { ...config[name], ...part } : part
    }
    target.config = config
  }
  return target
}

/** Checks the native thread's reported sandbox and MCP catalog against the ceiling. */
export async function verifyCeilingNativeThread(request, ceiling, result, threadId) {
  if (!ceilingNarrows(ceiling)) return
  const sandbox = result?.sandbox
  if (ceiling.files === 'read' && sandbox?.type !== 'readOnly') throw unverified('read-only files')
  if (ceiling.network === 'off' && !(['readOnly', 'workspaceWrite'].includes(sandbox?.type) && sandbox.networkAccess !== true)) throw unverified('offline network')
  if (ceiling.mcp === 'none') {
    let servers
    try { servers = await listNativeMcpServers(request, threadId) } catch { throw unverified('MCP-off') }
    if (servers.some(server => Object.keys(server.tools).length || server.resources.length || server.resourceTemplates.length || server.toolsError != null)) throw unverified('MCP-off')
  }
}
