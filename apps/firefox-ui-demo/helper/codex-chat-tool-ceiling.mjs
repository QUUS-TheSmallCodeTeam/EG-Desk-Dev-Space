import { chatError } from './codex-chat-values.mjs'
import {
  NATIVE_COMPUTER_FEATURES, disabledNativeMcpConfig, featuresNotOff, listNativeMcpServers, readNativeDirectMcpServerIds, readNativeThreadFeatures,
} from './codex-chat-execution-policy.mjs'
import { nativeMcpServerKind } from './codex-inherited-mcp.mjs'
import { normalizeToolCeiling } from './egdesk-profile-store.mjs'

// AGENT-04: a saved Agent profile's tool ceiling, enforced on the Codex
// thread it runs on. A ceiling only narrows what the user's own Codex setup
// and this run's grants allow; it never widens them. null means no ceiling.

// Browser tools a ceiling of 'observe' still allows.
const BROWSER_OBSERVE_TOOLS = new Set(['egdesk_browser_observe'])
// MCP server kinds (codex-inherited-mcp rules) that drive a browser or the desktop.
const COMPUTER_CONTROL_KINDS = new Set(['browser', 'desktop'])
const controlsComputer = server => COMPUTER_CONTROL_KINDS.has(nativeMcpServerKind(server))
const LIVE_SERVER_STATUSES = new Set(['connected', 'starting'])

export const CEILING_MESSAGES = Object.freeze({
  browserNone: '이 Agent는 브라우저 사용이 허용되지 않습니다',
  browserObserve: '이 Agent는 브라우저 조작이 허용되지 않습니다',
  browserDropped: '이 Agent는 브라우저를 쓸 수 없어 선택한 브라우저를 연결하지 않았습니다',
  browserDowngraded: '이 Agent는 브라우저를 보기만 할 수 있어 조작 허용은 적용하지 않았습니다',
  files: '이 Agent는 파일 쓰기가 허용되지 않습니다',
  terminal: '이 Agent는 터미널 명령이 허용되지 않습니다',
  network: '이 Agent는 인터넷 연결이 허용되지 않습니다',
  browserExternalInherited: '직접 연결한 외부 브라우저·컴퓨터 조작 도구(MCP)는 이 Agent에서도 쓸 수 있습니다. 막으려면 외부 도구(MCP)도 끄세요',
  nativeCheckUnavailable: '이 Codex 버전은 기능 상태를 알려 주지 않아, 브라우저·터미널 기능이 꺼졌는지는 확인하지 못했습니다',
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

/** Codex feature switches a ceiling turns off, which the thread must report as off. */
function ceilingFeaturesOff(ceiling) {
  return [...(ceiling.terminal === 'none' ? ['shell_tool'] : []), ...(ceiling.browser !== 'interact' ? NATIVE_COMPUTER_FEATURES : [])]
}

/**
 * Native thread/start or thread/resume overrides for a narrowing ceiling.
 * Bounded QA threads are already read-only, offline and MCP-free; they only
 * gain the shell and native browser switches.
 * Browser 'none'/'observe' also turns off plugins whose MCP server drives a
 * browser or the desktop (Codex's computer-use plugin serves cua_repl even
 * with the browser features off). Servers the user added under mcp_servers
 * stay with the MCP axis; verifyCeilingNativeThread reports them.
 */
export async function loadCeilingThreadOverrides(request, ceiling, { bounded = false, cwd = null } = {}) {
  if (!ceilingNarrows(ceiling)) return null
  const features = {}
  for (const name of ceilingFeaturesOff(ceiling)) features[name] = false
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
    const browserLimited = ceiling.browser !== 'interact'
    if (ceiling.mcp === 'none' || browserLimited) {
      let servers
      try { servers = await listNativeMcpServers(request, null) } catch { throw unavailable() }
      if (ceiling.mcp === 'none') {
        let mcp
        try { mcp = disabledNativeMcpConfig(servers, await readNativeDirectMcpServerIds(request, cwd)) }
        catch { throw unavailable() }
        Object.assign(config, mcp)
        features.apps = false
      }
      if (browserLimited) {
        const plugins = config.plugins || Object.create(null)
        for (const server of servers) if (server.pluginId && controlsComputer(server)) plugins[server.pluginId] = { enabled: false }
        if (Object.keys(plugins).length) config.plugins = plugins
      }
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

/**
 * Checks the started or resumed native thread against the ceiling before any
 * turn: the reported sandbox, the thread's MCP catalog, and (through
 * experimentalFeature/list) that the shell and built-in browser/computer
 * switches are off. Returns what the run should show:
 * - nativeFeatures: 'verified', 'unavailable' (this Codex build cannot
 *   report thread features; the other checks still ran) or null (none needed).
 * - externalBrowserToolsStillInherited: browser is limited, MCP is inherited,
 *   and a non-plugin server that drives a browser or the desktop is enabled.
 */
export async function verifyCeilingNativeThread(request, ceiling, result, threadId) {
  const report = { nativeFeatures: null, externalBrowserToolsStillInherited: false }
  if (!ceilingNarrows(ceiling)) return report
  const sandbox = result?.sandbox
  if (ceiling.files === 'read' && sandbox?.type !== 'readOnly') throw unverified('read-only files')
  if (ceiling.network === 'off' && !(['readOnly', 'workspaceWrite'].includes(sandbox?.type) && sandbox.networkAccess !== true)) throw unverified('offline network')
  const browserLimited = ceiling.browser !== 'interact'
  if (ceiling.mcp === 'none' || browserLimited) {
    let servers
    try { servers = await listNativeMcpServers(request, threadId) } catch { throw unverified(ceiling.mcp === 'none' ? 'MCP-off' : 'browser') }
    if (ceiling.mcp === 'none' && servers.some(server => Object.keys(server.tools).length || server.resources.length || server.resourceTemplates.length || server.toolsError != null)) throw unverified('MCP-off')
    if (browserLimited) {
      // A turned-off plugin's server is gone from the thread or listed without tools.
      if (servers.some(server => server.pluginId && controlsComputer(server) && (Object.keys(server.tools).length || LIVE_SERVER_STATUSES.has(server.runtimeStatus)))) throw unverified('browser')
      report.externalBrowserToolsStillInherited = ceiling.mcp !== 'none'
        && servers.some(server => !server.pluginId && controlsComputer(server) && server.runtimeStatus !== 'disabled')
    }
  }
  const required = ceilingFeaturesOff(ceiling)
  if (required.length) {
    const axis = ceiling.terminal === 'none' && !browserLimited ? 'terminal' : 'browser'
    let features
    try { features = await readNativeThreadFeatures(request, threadId) } catch { throw unverified(axis) }
    if (features === null) report.nativeFeatures = 'unavailable'
    else {
      const open = featuresNotOff(features, required)
      if (open.length) throw unverified(open.includes('shell_tool') ? 'terminal' : 'browser')
      report.nativeFeatures = 'verified'
    }
  }
  return report
}

/** Activity notices for what verifyCeilingNativeThread reported; fixed keys only. */
export function ceilingReportNotices(ceiling, report) {
  const notices = []
  if (report?.externalBrowserToolsStillInherited === true) {
    notices.push({ key: 'browser-external-inherited', axis: 'browser', title: CEILING_MESSAGES.browserExternalInherited, status: 'completed', externalBrowserToolsStillInherited: true })
  }
  if (report?.nativeFeatures === 'unavailable') {
    notices.push({ key: 'native-feature-check', axis: ceiling?.browser !== 'interact' ? 'browser' : 'terminal', title: CEILING_MESSAGES.nativeCheckUnavailable, status: 'completed', nativeFeatureCheck: 'unavailable' })
  }
  return notices
}
