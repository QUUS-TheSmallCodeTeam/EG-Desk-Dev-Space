import { COMPUTER_ADAPTER_CODES, createComputerAdapter, refusedResult } from './egdesk-computer-adapter.mjs'
import { publicText } from './codex-chat-values.mjs'

// U1 B1: EG-Desk's own computer tools, observation only (owner decision D-C1 2026-10-24: EG-Desk's own Rust helper; D-C4: observe first).
// One tool provider for the two engines: Codex gets these specs as dynamicTools, Claude through the in-process `egdesk` MCP server
// (mcp__egdesk__egdesk_computer_*): the same catalog, the same checks (codex-chat-runtime refuseComputerCall: Agent ceiling, computer control off,
// host lease policy), and the same approval card (askComputerApp). Developer flag EGDESK_COMPUTER_OBSERVE=on, default off: without it
// nothing here is created, no helper is asked for content and Claude does not see the computer tools.
//
// There is no input tool here and no way to add one through this module: click, type_text, key, scroll and drag stay unimplemented in the
// adapter's provider, and the helper has no request that posts input (helper-rust/src/host/observe.rs).
//
// Protection defaults (owner-approved shape from reports/l6-u1.md section c, as a proposal until the owner says otherwise):
//   - one window at a time, only of an app the person allowed in THIS run (a card on the first look at each app; [이번만 허락] never remembered);
//   - EG-Desk's own windows (own pids, Firefox-based bundle ids), terminals, the Codex/ChatGPT/Claude apps, password managers and system security
//     prompts are never listed, read or captured, and the list can only grow (EGDESK_COMPUTER_DENY adds bundle ids);
//   - the helper blacks out password fields and fields that name a secret, and refuses the whole image when it cannot check the window;
//   - pixels go to the run's engine model only (egdesk-decision-egress screen_capture is closed for the decision model) and EG-Desk keeps
//     none: the result is returned once, the stored tool item carries only the tool name, and nothing here writes a file.
export const COMPUTER_OBSERVE_FLAG = 'EGDESK_COMPUTER_OBSERVE'
export const computerObserveEnabled = env => env?.[COMPUTER_OBSERVE_FLAG] === 'on'
// Same value as codex-chat-runtime COMPUTER_PROVIDER_ID (a test keeps them equal; importing the runtime here would pull in the whole chat).
export const COMPUTER_OBSERVE_PROVIDER_ID = 'egdesk-computer'
export const COMPUTER_OBSERVE_TOOLS = Object.freeze({
  listApps: 'egdesk_computer_list_apps',
  listWindows: 'egdesk_computer_list_windows',
  capture: 'egdesk_computer_capture',
  readElements: 'egdesk_computer_read_elements',
})
const METHOD_OF = Object.freeze({
  [COMPUTER_OBSERVE_TOOLS.listApps]: 'listApps',
  [COMPUTER_OBSERVE_TOOLS.listWindows]: 'listWindows',
  [COMPUTER_OBSERVE_TOOLS.capture]: 'capture',
  [COMPUTER_OBSERVE_TOOLS.readElements]: 'readElements',
})

const APP_ARG = { type: 'string', minLength: 1, maxLength: 256, description: 'Bundle id (best) or exact name of an app from egdesk_computer_list_apps' }
const WINDOW_ARG = { type: 'integer', minimum: 0, description: 'windowId from egdesk_computer_list_windows; omitted = the app\'s frontmost window' }
export const COMPUTER_OBSERVE_SPECS = Object.freeze([
  Object.freeze({ type: 'function', name: COMPUTER_OBSERVE_TOOLS.listApps,
    description: 'List the apps open on this Mac that you may look at (name, bundleId, active). Terminals, password managers and EG-Desk itself are not listed. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } }),
  Object.freeze({ type: 'function', name: COMPUTER_OBSERVE_TOOLS.listWindows,
    description: 'List the on-screen windows of the apps you may look at (windowId, app, bounds; the title only for an app the person already allowed in this run). Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { app: APP_ARG } } }),
  Object.freeze({ type: 'function', name: COMPUTER_OBSERVE_TOOLS.capture,
    description: 'Take one picture of one window of an app (not the whole screen). The first look at an app in a run asks the person. Password fields and fields that name a secret are blacked out; if that cannot be checked, no picture is made. Coordinates in the picture are its own pixels. Read-only: it does not click or type.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['app'], properties: { app: APP_ARG, windowId: WINDOW_ARG, maxEdge: { type: 'integer', minimum: 256, maximum: 2048, description: 'Longest picture edge in pixels (default 1280)' } } } }),
  Object.freeze({ type: 'function', name: COMPUTER_OBSERVE_TOOLS.readElements,
    description: 'Read the accessibility elements of one window of an app (role, label, value, rect in window points). Values of password-like fields are never read. The first look at an app in a run asks the person. Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['app'], properties: { app: APP_ARG, windowId: WINDOW_ARG } } }),
])

// Apps that are never listed, read or captured, by bundle id (exact or prefix ending in a dot).
export const COMPUTER_DENY_BUNDLES = Object.freeze([
  // EG-Desk itself (Firefox-based) and the browsers built on the same bundle family
  'org.mozilla.',
  // terminals
  'com.apple.Terminal', 'com.googlecode.iterm2', 'dev.warp.', 'com.mitchellh.ghostty', 'net.kovidgoyal.kitty', 'io.alacritty', 'co.zeit.hyper',
  'com.github.wez.wezterm', 'org.tabby', 'com.raphaelamorim.rio',
  // Codex / ChatGPT / Claude and Codex Computer Use
  'com.openai.', 'com.anthropic.',
  // password managers and keychains
  'com.1password.', 'com.agilebits.', 'com.bitwarden.', 'com.lastpass.', 'org.keepassxc.', 'org.keepassx.', 'com.apple.keychainaccess', 'com.apple.Passwords',
  'com.dashlane.', 'com.nordsec.', 'me.proton.pass', 'com.enpass.', 'com.apple.PasswordsMenuBarExtra',
  // system security prompts and settings
  'com.apple.SecurityAgent', 'com.apple.loginwindow', 'com.apple.systempreferences', 'com.apple.coreservices.uiagent', 'com.apple.UserNotificationCenter',
])
const DENY_NAME = /^(?:eg-?desk\b|terminal$|iterm2?$|1password|bitwarden|lastpass|dashlane|keychain access$|passwords$|chatgpt$|codex\b|claude$)/i

export function bundleDenied(bundleId, extra = []) {
  if (typeof bundleId !== 'string' || !bundleId) return false
  const lower = bundleId.toLowerCase()
  return [...COMPUTER_DENY_BUNDLES, ...extra].some(rule => {
    const r = String(rule).toLowerCase()
    return r.endsWith('.') ? lower.startsWith(r) : lower === r || lower.startsWith(`${r}.`)
  })
}
export const appDenied = (app, { ownPids = [], extraDeny = [] } = {}) =>
  Boolean(app) && (ownPids.includes(app.pid) || bundleDenied(app.bundleId, extraDeny) || (!app.bundleId && DENY_NAME.test(String(app.name ?? ''))) || DENY_NAME.test(String(app.name ?? '')))

// What a failed helper request means to the model (closed codes + one fixed hint each; no helper text is passed on).
const HELPER_CODES = Object.freeze({
  permission_missing: ['permission_missing', 'macOS has not granted this permission to EG-Desk\'s helper yet. Tell the person to allow Screen Recording and Accessibility in System Settings > Privacy & Security; EG-Desk does not change them.'],
  mask_unavailable: ['mask_unavailable', 'Sensitive fields in this window could not be checked completely, so no picture was made. Try read_elements, or another window.'],
  window_changed: ['window_changed', 'The window changed while it was read. List the windows again.'],
  window_not_found: ['window_not_found', 'No such on-screen window. List the windows again.'],
  // U3 (D12): a locked screen made every read look like "no such window"; the helper now says what is wrong.
  screen_locked: ['screen_locked', 'The Mac\'s screen is locked, so no window can be read or captured. Tell the person to unlock it; do not retry until they have.'],
  ax_unavailable: ['accessibility_unavailable', 'The app does not expose this window through accessibility right now (the screen may be locked, or the app has not built its accessibility tree). Try again after the person unlocks or brings the app forward; capture may still work.'],
  window_mismatch: ['window_mismatch', 'The accessibility tree reports different window positions than the screen list, so elements cannot be placed safely. List the windows again.'],
  ambiguous_window: ['ambiguous_window', 'Two windows look the same to the accessibility tree, so this one cannot be told apart safely. Use another window.'],
  ax_failed: ['accessibility_failed', 'The app did not answer the accessibility read.'],
  capture_failed: ['capture_failed', 'The window picture could not be made.'],
  encode_failed: ['capture_failed', 'The window picture could not be made.'],
  observe_only: ['content_off', 'The Mac helper is not set up to read windows.'],
})
const OWN = Object.freeze({
  appDenied: ['app_unavailable', 'That app is not available to you.'],
  appNotFound: ['app_not_found', 'No such open app. Call egdesk_computer_list_apps.'],
  appAmbiguous: ['app_ambiguous', 'More than one open app has that name. Use its bundleId.'],
  notApproved: ['app_not_approved', 'The person did not allow you to look at this app in this run. Do not ask again; continue without it or tell them.'],
  windowNotFound: ['window_not_found', 'That app has no such on-screen window. Call egdesk_computer_list_windows.'],
  helperUnavailable: ['helper_unavailable', 'The Mac helper is not running here.'],
})
const refusal = ([code, hint]) => refusedResult(code, { hint })
const reply = (success, body) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(body) }] })
// A refusal is an ordinary closed result (effect 'refused', error.code, a hint), delivered as success: the runtime rewrites every success:false
// tool result into its fixed public wording, which would drop the code and the hint the model needs to tell the person what to do.
const refuse = body => reply(true, body)
const SAFE_NAME = value => typeof value === 'string' && value ? publicText(value, 128) : null

/** The text of the first-look card (a proposal: owner approval pending; the card itself is the existing computerElicitation card). */
export const computerAppCard = appName => ({
  appName,
  message: `Agent가 '${appName}' 앱의 창 하나를 화면 이미지와 접근성 요소로 읽으려 합니다. 비밀번호 칸 등은 가려지고, 이번 작업에서만 허락됩니다.`,
})

/**
 * createComputerObserveProvider({ host, ask, ownPids?, extraDeny?, onRecord? })
 *   host: { ready(), listApps(), listWindows({ titles }), capture({ windowId, pid, maxEdge }), readElements({ windowId, pid }) } (the helper agent)
 *   ask(run, { appName, message }) → Promise<'accept'|'decline'|'expired'|'cancel'>  (CodexChatRuntime.askComputerApp)
 */
export function createComputerObserveProvider({ host, ask, ownPids = [], extraDeny = [], onRecord = () => {} } = {}) {
  if (!host || typeof host.listApps !== 'function') throw new TypeError('the computer observe provider needs a host helper')
  const runState = new WeakMap() // run → { accepted: Set, declined: Set, pending: Map }
  const stateOf = run => { let s = runState.get(run); if (!s) { s = { accepted: new Set(), declined: new Set(), pending: new Map() }; runState.set(run, s) } return s }
  const deny = app => appDenied(app, { ownPids, extraDeny })
  const keyOf = app => app.bundleId || `name:${app.name}`

  async function openApps() {
    await host.ready()
    const raw = await host.listApps()
    return (Array.isArray(raw?.apps) ? raw.apps : []).filter(app => app && Number.isSafeInteger(app.pid) && app.pid > 0 && app.policy === 'regular')
  }
  async function resolveApp(name, apps) {
    const wanted = String(name).trim()
    const byId = apps.filter(app => app.bundleId === wanted)
    const lower = wanted.toLowerCase()
    // bundle id, the (localized) name, then the last part of the bundle id ('Calculator' for com.apple.calculator on a Mac whose app is named '계산기')
    const byName = () => apps.filter(app => typeof app.name === 'string' && app.name.toLowerCase() === lower)
    const byIdTail = () => apps.filter(app => typeof app.bundleId === 'string' && app.bundleId.split('.').at(-1).toLowerCase() === lower)
    const found = byId.length ? byId : byName().length ? byName() : byIdTail()
    if (!found.length) return { error: OWN.appNotFound }
    const identities = new Set(found.map(app => app.bundleId || `name:${app.name}`))
    if (identities.size > 1) return { error: OWN.appAmbiguous }
    // several processes of one app: the one that is active, else the first
    const app = found.find(candidate => candidate.active) ?? found[0]
    return deny(app) ? { error: OWN.appDenied } : { app }
  }
  async function windowsOf(app) {
    const raw = await host.listWindows({ titles: true })
    return (Array.isArray(raw?.windows) ? raw.windows : []).filter(w => w && w.pid === app.pid && w.layer === 0 && w.onScreen !== false)
  }
  async function approve(run, app) {
    const s = stateOf(run), key = keyOf(app)
    if (s.accepted.has(key)) return true
    if (s.declined.has(key)) return false
    let pending = s.pending.get(key)
    if (!pending) {
      pending = Promise.resolve().then(() => (typeof ask === 'function' ? ask(run, computerAppCard(SAFE_NAME(app.name) || app.bundleId || 'app')) : 'decline'))
        .catch(() => 'decline')
        .then(answer => { if (answer === 'accept') s.accepted.add(key); else if (answer === 'decline') s.declined.add(key); s.pending.delete(key); return answer === 'accept' })
      s.pending.set(key, pending)
    }
    return pending
  }

  // The adapter provider for one call: it resolves the target again (so a window that changed between the card and the read is caught), and
  // keeps what the closed adapter result drops (the helper's mask summary, the helper's failure code) in `extras`.
  function callProvider(extras) {
    const locate = async target => {
      const resolved = await resolveApp(target.app, await openApps())
      if (resolved.error) { extras.error = resolved.error; throw new Error('app') }
      const app = resolved.app
      const windows = await windowsOf(app)
      const window = target.windowId === undefined ? windows.find(w => w.bounds?.width >= 120 && w.bounds?.height >= 80) ?? windows[0] : windows.find(w => w.windowId === target.windowId)
      if (!window) { extras.error = OWN.windowNotFound; throw new Error('window') }
      return { app, window }
    }
    const asked = async fn => {
      try { return await fn() } catch (error) {
        if (!extras.error) extras.error = error?.helperCode && HELPER_CODES[error.helperCode] ? HELPER_CODES[error.helperCode] : error?.code === 'HOST_AGENT_REFUSED' ? HELPER_CODES.capture_failed : OWN.helperUnavailable
        throw error
      }
    }
    return {
      id: 'egdesk-helper',
      async listApps() {
        const apps = await asked(openApps)
        return { apps: apps.filter(app => !deny(app)).map(app => ({ name: app.name, bundleId: app.bundleId, pid: app.pid, active: app.active === true })) }
      },
      async listWindows(args) {
        return asked(async () => {
          const apps = await openApps()
          const allowed = apps.filter(app => !deny(app))
          const only = args.target ? allowed.filter(app => app.bundleId === args.target.app || (typeof app.name === 'string' && app.name.toLowerCase() === args.target.app.toLowerCase())) : allowed
          const out = []
          // a locked screen leaves the window list in place but nothing readable behind it
          try { extras.screenLocked = (await host.permissions?.())?.screenLocked === true } catch { /* unknown: say nothing */ }
          const raw = await host.listWindows({ titles: true })
          for (const w of Array.isArray(raw?.windows) ? raw.windows : []) {
            const app = only.find(candidate => candidate.pid === w?.pid)
            if (!app || w.layer !== 0 || w.onScreen === false) continue
            const known = extras.run ? stateOf(extras.run).accepted.has(keyOf(app)) : false
            out.push({ windowId: w.windowId, app: app.bundleId || app.name, pid: app.pid, title: known ? w.title ?? null : null, bounds: w.bounds, onScreen: true })
          }
          return { windows: out }
        })
      },
      async capture(args) {
        const { app, window } = await asked(() => locate(args.target))
        const result = await asked(() => host.capture({ windowId: window.windowId, pid: app.pid, ...(args.maxEdge ? { maxEdge: args.maxEdge } : {}) }))
        extras.masked = result?.masked && Number.isSafeInteger(result.masked.count) ? { count: result.masked.count, reasons: Array.isArray(result.masked.reasons) ? result.masked.reasons.filter(r => typeof r === 'string').slice(0, 8).map(r => r.slice(0, 40)) : [] } : null
        extras.app = app.bundleId || app.name
        return result
      },
      async readElements(args) {
        const { app, window } = await asked(() => locate(args.target))
        extras.app = app.bundleId || app.name
        return asked(() => host.readElements({ windowId: window.windowId, pid: app.pid }))
      },
    }
  }

  async function handle(run, event) {
    const tool = event?.tool, method = METHOD_OF[tool]
    if (event?.namespace || !method) return refuse(refusal(['unknown_tool', 'No such computer tool.']))
    const args = event.arguments && typeof event.arguments === 'object' && !Array.isArray(event.arguments) ? event.arguments : {}
    const allowed = method === 'listApps' ? [] : method === 'listWindows' ? ['app'] : method === 'capture' ? ['app', 'windowId', 'maxEdge'] : ['app', 'windowId']
    if (Object.keys(args).some(key => !allowed.includes(key))) return refuse(refusedResult(COMPUTER_ADAPTER_CODES.INVALID_ARGUMENTS, { hint: 'Remove arguments this tool does not take.' }))
    const adapterArgs = {}
    if (method !== 'listApps') {
      if (typeof args.app === 'string' && args.app.trim()) adapterArgs.target = { app: args.app.trim(), ...(args.windowId === undefined ? {} : { windowId: args.windowId }) }
      else if (method !== 'listWindows') return refuse(refusedResult(COMPUTER_ADAPTER_CODES.INVALID_ARGUMENTS, { hint: 'Check the target.app argument.' }))
      if (method === 'capture' && args.maxEdge !== undefined) adapterArgs.maxEdge = args.maxEdge
    }
    const extras = { run }
    const records = []
    const adapter = createComputerAdapter({ provider: callProvider(extras), lease: null, deliveryCeiling: 'view-only', onRecord: record => { records.push(record); try { onRecord(record) } catch {} } })
    if (method === 'capture' || method === 'readElements') {
      // A look at an app needs the person's answer first. The app is resolved by the same rules as the read itself.
      let resolved
      try { resolved = await resolveApp(adapterArgs.target?.app ?? '', await openApps()) } catch (error) {
        return refuse(refusal(error?.helperCode && HELPER_CODES[error.helperCode] ? HELPER_CODES[error.helperCode] : OWN.helperUnavailable))
      }
      if (resolved.error) return refuse(refusal(resolved.error))
      // Do not ask the person for an app a locked screen cannot show anyway (U3, D12).
      try { if ((await host.permissions?.())?.screenLocked === true) return refuse(refusal(HELPER_CODES.screen_locked)) } catch { /* unknown: go on */ }
      if (!(await approve(run, resolved.app))) return refuse(refusal(OWN.notApproved))
    }
    const result = await adapter.call(method, adapterArgs, { commandId: `${event.callId ?? 'call'}`.slice(0, 128) })
    if (result.ok !== true) return refuse(extras.error ? refusal(extras.error) : refusal(HELPER_CODES.capture_failed))
    if (method === 'listApps') return reply(true, { status: 'apps', apps: result.apps.map(({ name, bundleId, active }) => ({ name, bundleId, active })) })
    if (method === 'listWindows') {
      return reply(true, { status: 'windows', ...(extras.screenLocked ? { screenLocked: true, hint: HELPER_CODES.screen_locked[1] } : {}),
        windows: result.windows.map(({ windowId, app, title, bounds }) => ({ windowId, app, ...(title ? { title } : {}), bounds })) })
    }
    if (method === 'readElements') return reply(true, { status: 'elements', app: extras.app ?? null, ...result.elements })
    if (!result.image) return refuse(refusal(HELPER_CODES.capture_failed))
    const { frame } = result
    const body = { status: 'captured', app: extras.app ?? null, windowId: frame.windowId, image: { width: frame.width, height: frame.height, scale: frame.scale, geometryRevision: frame.geometryRevision },
      masked: extras.masked ?? { count: 0, reasons: [] }, note: 'Pixel coordinates belong to this picture. Black boxes hide sensitive fields.' }
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(body) }, { type: 'inputImage', imageUrl: `data:${result.image.mime};base64,${result.image.data}` }] }
  }

  return {
    providerId: COMPUTER_OBSERVE_PROVIDER_ID,
    // Read by CodexChatRuntime.providerSupportsEngine: with this flag on the computer tools may reach Claude.
    exposeToClaude: true,
    specs() { return COMPUTER_OBSERVE_SPECS },
    dispatch(run, event) { return handle(run, event).catch(() => refuse(refusal(OWN.helperUnavailable))) },
  }
}
