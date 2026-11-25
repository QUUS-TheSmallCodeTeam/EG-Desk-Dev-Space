import { COMPUTER_OBSERVE_FLAG, computerObserveEnabled, createComputerObserveProvider } from './egdesk-computer-observe.mjs'

// The bridge's wiring of EG-Desk's own computer observe tools (U1 B1). Developer flag EGDESK_COMPUTER_OBSERVE=on, default off: without it this
// returns null, the bridge builds the host helper exactly as before (no --observe-content, so the helper answers capture and readElements with
// observe_only) and adds no tool provider, so neither engine sees an egdesk_computer_* tool.
// With it: the host helper is started with --observe-content (agentOptions), the provider's tools go to both engines, and the first look at an app
// in a run asks the person through CodexChatRuntime.askComputerApp.
export { COMPUTER_OBSERVE_FLAG }
export const COMPUTER_OBSERVE_TIMEOUTS = Object.freeze({ readyMs: 12_000, listMs: 8_000, captureMs: 20_000, elementsMs: 15_000 })

/**
 * createComputerObserveWiring({ env, getChat, getHostControl, ownPids? }) → null | { provider, agentOptions, attach(agent) }
 *   getChat() → the CodexChatRuntime (read lazily: it is made after this wiring)
 *   getHostControl() → createHostControl(...) result (read lazily); ensureAgent() starts the helper once
 *   attach(agent): the bridge calls it with the agent its hostControl makes (makeAgent), so the provider asks that same helper
 */
export function createComputerObserveWiring({ env = process.env, getChat, getHostControl, ownPids = [process.pid, process.ppid], timeouts = {} } = {}) {
  if (!computerObserveEnabled(env)) return null
  if (typeof getChat !== 'function' || typeof getHostControl !== 'function') throw new TypeError('computer observe needs getChat and getHostControl')
  const T = { ...COMPUTER_OBSERVE_TIMEOUTS, ...timeouts }
  let agent = null
  const extraDeny = String(env?.EGDESK_COMPUTER_DENY ?? '').split(',').map(item => item.trim()).filter(item => /^[A-Za-z0-9.-]{1,255}$/.test(item))
  const current = () => { if (!agent) throw Object.assign(new Error('The host helper is not available'), { code: 'HOST_AGENT_UNAVAILABLE' }); return agent }
  const host = {
    async ready() {
      getHostControl().ensureAgent()
      const live = current()
      let timer
      try {
        await Promise.race([live.start(), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('The host helper did not become ready'), { code: 'HOST_AGENT_TIMEOUT' })), T.readyMs); timer.unref?.() })])
      } finally { clearTimeout(timer) }
    },
    listApps: () => current().listApps({ timeoutMs: T.listMs }),
    permissions: () => current().permissions({ timeoutMs: T.listMs }),
    listWindows: query => current().listWindows({ titles: query?.titles === true }, { timeoutMs: T.listMs }),
    capture: query => current().capture(query, { timeoutMs: T.captureMs }),
    readElements: query => current().readElements(query, { timeoutMs: T.elementsMs }),
  }
  return {
    // heartbeat 8 s: one capture keeps the helper busy for a few seconds and its pings wait behind it
    agentOptions: Object.freeze({ observeContent: true, heartbeatTimeoutMs: 8000 }),
    attach(next) { agent = next },
    provider: createComputerObserveProvider({ host, ask: (run, card) => getChat().askComputerApp(run, card), ownPids, extraDeny }),
  }
}
