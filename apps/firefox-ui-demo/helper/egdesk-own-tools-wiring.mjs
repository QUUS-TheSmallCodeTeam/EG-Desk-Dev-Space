import fs from 'node:fs'
import path from 'node:path'
import { createCommandExecutorProvider, executorAssess } from './egdesk-command-executor.mjs'
import { createCommandRunner } from './egdesk-command-runner.mjs'
import { createFileToolsProvider } from './egdesk-file-tools.mjs'
import { createGateHookBroker } from './egdesk-gate-hook-broker.mjs'

// The bridge's wiring of EG-Desk's own tools (c19). Developer flag EGDESK_OWN_TOOLS=on, default off: without it this returns null and
// the bridge passes nothing new (no provider, no ownTools, no ledger), so every current path is unchanged.
// With it: Codex is a pure model engine (codex-chat-runtime.mjs ownTools) in an empty folder under EG-Desk's own data folder, and the
// command and file tools run on the real folder through one approval ledger; commands run with the real spawn, in their own process
// group, killed as a group.
export const OWN_TOOLS_FLAG = 'EGDESK_OWN_TOOLS'
export const ownToolsEnabled = env => env?.[OWN_TOOLS_FLAG] === 'on'

/** The empty folder Codex runs in: <dataDir>/engine-folders/empty, owner-only. Null when it cannot be made or is not empty. */
export function prepareEngineFolder(dataDir, { fsImpl = fs } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) return null
  const folder = path.join(dataDir, 'engine-folders', 'empty')
  try {
    fsImpl.mkdirSync(folder, { recursive: true, mode: 0o700 })
    return fsImpl.readdirSync(folder).length === 0 ? folder : null
  } catch { return null }
}

/** Kill a command's whole process group (it was spawned detached, so its pid is the group id); the child alone as a fallback. */
export function processGroupKill(kill = (pid, signal) => process.kill(pid, signal)) {
  return (child, signal) => {
    if (Number.isSafeInteger(child?.pid) && child.pid > 0) { try { kill(-child.pid, signal); return } catch { /* the group is gone or not ours */ } }
    try { child?.kill?.(signal) } catch { /* already gone */ }
  }
}

/**
 * createOwnToolsWiring({ env, dataDir, spawn, getChat, inspect?, killGroup?, home? }) → null | {
 *   ownTools, toolProviders, ledger, terminalGate(base) }
 *   getChat() → the CodexChatRuntime (read lazily: the runtime is made after this wiring)
 */
export function createOwnToolsWiring({ env = process.env, dataDir, spawn, getChat, inspect = null, killGroup = processGroupKill(), home = env?.HOME } = {}) {
  if (!ownToolsEnabled(env)) return null
  if (typeof spawn !== 'function' || typeof getChat !== 'function') throw new TypeError('own tools need spawn and getChat')
  const ledger = createGateHookBroker({ mode: () => 'on', home, assess: executorAssess(args => getChat().gateHookAssess(args), { home }) })
  const runner = createCommandRunner({ spawn, env, killGroup })
  const workspaceOf = run => getChat().runFolder(run)
  const outputFor = run => ({ append: (itemId, text) => getChat().runOutputs.appendCommandOutput(run.answerId, itemId, text),
    complete: itemId => getChat().runOutputs.completeCommand(run.answerId, itemId) })
  const executor = createCommandExecutorProvider({ mode: () => 'on', ledger, workspaceOf, runner, outputFor })
  const files = createFileToolsProvider({ mode: () => 'on', ledger, workspaceOf, inspect })
  return {
    ledger, executor, files, toolProviders: [executor, files],
    ownTools: { mode: () => 'on', neutralFolder: () => prepareEngineFolder(dataDir) },
    // the executor's judgement needs the command gate on (predicates through the run's egress) and the ledger for replies and turns
    terminalGate: base => ({ ...(base ?? { inspect }), mode: base?.mode ?? (() => 'on'), hookBroker: ledger }),
  }
}
