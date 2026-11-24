import { execFile as nodeExecFile } from 'node:child_process'
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
// c20: EGDESK_OWN_TOOLS=shadow keeps Codex's own tools as today and only records what the own tools would have done.
export const ownToolsShadow = env => env?.[OWN_TOOLS_FLAG] === 'shadow'

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
// c21: `git status --porcelain=v1` in the run folder, for the worktree condition (structured; null outside a repository or on any error).
export function gitPorcelain(execFile = nodeExecFile) {
  return cwd => new Promise(resolve => {
    try {
      execFile('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd, timeout: 1500, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
        (error, stdout) => resolve(error ? null : String(stdout)))
    } catch { resolve(null) }
  })
}

export function createOwnToolsWiring({ env = process.env, dataDir, spawn, getChat, inspect = null, killGroup = processGroupKill(), home = env?.HOME, gitStatus = gitPorcelain() } = {}) {
  // shadow: no provider, no ledger, no spawn, no engine folder, no gate change; the runtime only records (codex-chat-runtime observeOwnToolsShadow)
  if (ownToolsShadow(env)) return { shadow: true, toolProviders: [], ownTools: { mode: () => 'shadow', neutralFolder: () => null }, terminalGate: base => base }
  if (!ownToolsEnabled(env)) return null
  if (typeof spawn !== 'function' || typeof getChat !== 'function') throw new TypeError('own tools need spawn and getChat')
  const ledger = createGateHookBroker({ mode: () => 'on', home, assess: executorAssess(args => getChat().gateHookAssess(args), { home }) })
  const runner = createCommandRunner({ spawn, env, killGroup })
  const workspaceOf = run => getChat().runFolder(run)
  const outputFor = run => ({ append: (itemId, text) => getChat().runOutputs.appendCommandOutput(run.answerId, itemId, text),
    complete: itemId => getChat().runOutputs.completeCommand(run.answerId, itemId) })
  // the auxiliary predicate on a command's output tail: only with the person's Decision mode on (or advisory) and a saved key, and only
  // where the run may send command output (the output of commands this run's engine asked for, which its model already receives)
  const ask = async (run, request) => {
    const chat = getChat(), setup = chat?.decisionContext
    if (!setup?.client || setup.configured?.() !== true || !['advisory', 'on'].includes(setup.mode?.())) return null
    if (chat.decisionEgressFor(run).allows('command_output') !== true) return null
    return setup.client.decide({ ...request, timeoutMs: 1500 })
  }
  const executor = createCommandExecutorProvider({ mode: () => 'on', ledger, workspaceOf, runner, outputFor, ask, gitStatus,
    onConditions: (run, record) => getChat().noteOwnCommand(run, record) })
  const files = createFileToolsProvider({ mode: () => 'on', ledger, workspaceOf, inspect })
  return {
    ledger, executor, files, toolProviders: [executor, files],
    // c22: EGDESK_OWN_TOOLS_ENVIRONMENTS=none (developer flag, default unset) also starts the thread with environments: [] ("disables environment access" in the
    // 0.171 ThreadStartParams). A candidate for keeping the person's MCP servers and Codex's own exec environment away; not confirmed on a real binary.
    ownTools: { mode: () => 'on', neutralFolder: () => prepareEngineFolder(dataDir), ...(env?.EGDESK_OWN_TOOLS_ENVIRONMENTS === 'none' ? { environments: () => 'none' } : {}) },
    // the executor's judgement needs the command gate on (predicates through the run's egress) and the ledger for replies and turns
    terminalGate: base => ({ ...(base ?? { inspect }), mode: base?.mode ?? (() => 'on'), hookBroker: ledger }),
  }
}
