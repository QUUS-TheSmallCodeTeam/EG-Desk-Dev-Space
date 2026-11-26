import { PAGE_TOOLS_FLAG, createPageToolsProvider, pageToolsEnabled } from './egdesk-page-tools.mjs'
import { BROWSER_TASK_PAGE_TEXT_FLAG, BROWSER_TASK_TOOL_FLAG, browserTaskToolEnabled, createBrowserTaskTool } from './egdesk-browser-task-tool.mjs'

// L8 u1: the bridge's wiring of the page tools (helper/egdesk-page-tools.mjs). Developer flag EGDESK_PAGE_TOOLS=on, default off: without it this returns null and the bridge
// passes nothing new. With it one more tool provider is registered; the catalog (collectToolSpecs) offers its tools to Claude (EG-Desk MCP) and to Codex (dynamicTools, the own-tools path)
// only in a run bound to a Browser Card the person granted. Every action goes through the EXISTING Browser provider's dispatch for the same run, so the run binding, the Card grant, the
// Agent ceiling, the action gate, the AI-service sign-in opacity (flag EGDESK_TERMINAL_OPEN_URL) and the activity record all stay as they are. What needs the person's approval goes through the
// approval ledger of the own command and file tools when that is on (EGDESK_OWN_TOOLS=on); without it nothing that needs approval is done.
export { PAGE_TOOLS_FLAG, BROWSER_TASK_TOOL_FLAG }

/**
 * createPageToolsWiring({ env, getChat, ledger? }) -> null | { toolProviders }
 *   getChat() -> the CodexChatRuntime (read lazily: the runtime is made after this wiring); its browserToolProvider() is the Browser provider
 */
export function createPageToolsWiring({ env = process.env, getChat, ledger = null } = {}) {
  if (!pageToolsEnabled(env)) return null
  if (typeof getChat !== 'function') throw new TypeError('page tools need getChat')
  const browser = { dispatch: (run, event) => {
    const provider = getChat()?.browserToolProvider?.()
    if (!provider?.dispatch) throw new Error('no Browser provider')
    return provider.dispatch(run, event)
  } }
  // L8 a1: the browser task tool beside the page tools (EGDESK_BROWSER_TASK_TOOL=on, default off). It drives the Browser provider's own objective loop (runDirectTask) for the same
  // run. The runtime may offer browserTaskMessage(run) (the person's message of the turn: its spans are value candidates) and browserTaskStep(run, event) (the step events); without them
  // the tool still works (spans from the goal only, no step events leave it).
  const provider = () => { const live = getChat()?.browserToolProvider?.(); if (!live?.runDirectTask || !live?.reflexScope) throw new Error('no Browser provider'); return live }
  let pageProvider = null // its runtime (set by the chat runtime) carries lane L5's hooks: browserTaskStep(run, info, ids) and browserTasks()
  const taskTool = browserTaskToolEnabled(env) ? createBrowserTaskTool({
    browser: { runDirectTask: (run, args) => provider().runDirectTask(run, args), reflexScope: (run, event, cardId) => provider().reflexScope(run, event, cardId),
      directEntryEnabled: () => { try { return provider().directEntryEnabled?.() === true } catch { return false } } },
    messageOf: run => getChat()?.browserTaskMessage?.(run) ?? null,
    onStep: (run, event) => { const hook = pageProvider?.runtime?.browserTaskStep; return typeof hook === 'function' ? hook(run, event, { taskId: event.taskId, cardId: event.cardId }) : getChat()?.browserTaskStep?.(run, event) },
    storeOf: () => pageProvider?.runtime?.browserTasks?.() ?? null,
    pageText: env[BROWSER_TASK_PAGE_TEXT_FLAG] === 'on',
  }) : null
  pageProvider = createPageToolsProvider({ mode: () => 'on', browser, ledger, env, ...(taskTool ? { taskTool } : {}) })
  return { toolProviders: [pageProvider] }
}
