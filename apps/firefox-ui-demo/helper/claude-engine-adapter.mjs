// Claude behind the EngineAdapter contract (engine-adapter.mjs), decision
// D-S1 (b) adopted 2026-10-24: the installed, unmodified `claude` runs as one
// child process per conversation over the stdio control channel the official
// Agent SDK speaks. This module only composes parts that already exist:
//   claude-engine-transport.mjs  process, NDJSON framing, control requests (d76bb67)
//   claude-engine-permissions.mjs approvals and questions → runtime server requests (2a8d699)
//   egdesk-claude-mcp.mjs         EG-Desk tools as an in-process 'sdk' MCP server (2a8d699)
//   claude-stream-translate.mjs   Claude output → the internal reference events
//   claude-engine-auth.mjs        static gate: installed, version range, signed in (b650366)
// The internal reference is the Codex app-server vocabulary, so the chat
// runtime keeps every rule it already applies (run binding, approvals,
// Agent rules, sanitizers) without knowing Claude exists.
//
// Patterns followed (rewritten here, not copied):
//   anthropics/claude-agent-sdk-python (MIT, Copyright (c) 2025 Anthropic, PBC)
//     _internal/client.py:177-189 — initialize first, then write the prompt as a
//     user line; _internal/query.py interrupt() — stop is a control request.
//   agentclientprotocol/claude-agent-acp (Apache-2.0, patterns only)
//     src/acp-agent.ts:8620-8913 cancelTurns — mark the turn cancelled, call
//     interrupt, and arm a backstop so a wedged CLI still settles the turn
//     'cancelled'; src/session-mode.ts:358-362 — 'Manual' is the "always ask
//     before making changes" mode (read-only tools still run).
//   docs/references/engine-adapter-design.md §4.1 (a lost Claude process ends
//   only its own turn, never the whole engine) and §9 (one process per
//   conversation, idle 5 min, two resident at most, ENGINE_BUSY beyond that).
//
// D-S2 isolation comes from the transport (hooks off, only EG-Desk's MCP,
// claude.ai connectors off, no CLAUDE.md or skills unless `inherit` turns them
// on, login shared). D-S4: an Anthropic API key in EG-Desk's environment stops
// every new start until the user confirms (confirmApiKeyEnv); the key is never
// given to the child either way, and EG-Desk never asks for one — the API key
// profile is the CLI's own Console login (claude-engine-auth
// claudeLoginTerminalCommand). D-S5: no automatic continue after a usage
// limit; the reset time is kept for display only (autoResume: false).
//
// Never logged or kept: message text, tool inputs, answers, credentials.

import { randomUUID as nodeRandomUUID } from 'node:crypto'
import { deleteClaudeSessionFiles } from './claude-session-files.mjs'
import os from 'node:os'
import path from 'node:path'
import { chatError } from './codex-chat-values.mjs'
import { usageDisplay } from './codex-account-usage.mjs'
import { engineError } from './engine-adapter.mjs'
import { describeClaudeEngine } from './engine-registry.mjs'
import { resolveClaudeExecutable } from './claude-engine-auth.mjs'
import {
  CLAUDE_EFFORT_LEVELS, CLAUDE_TRANSPORT_CHECKED_VERSION, CLAUDE_TRANSPORT_MIN_VERSION,
  buildClaudeArgs, compareVersions, createClaudeTransport, detectApiKeyEnv,
} from './claude-engine-transport.mjs'
import { createClaudePermissionBroker } from './claude-engine-permissions.mjs'
import { EGDESK_MCP_SERVER_NAME, createEgdeskClaudeMcp, egdeskAllowedToolsRule, egdeskMcpConfig } from './egdesk-claude-mcp.mjs'
import { applyClaudeRateLimit, createClaudeTranslator } from './claude-stream-translate.mjs'
import { CLAUDE_BOUNDED_MIN_VERSION, CLAUDE_BOUNDED_POLICIES, claudeBoundedInitViolation, claudeBoundedLaunch } from './egdesk-claude-bounded.mjs'
import { CLAUDE_MCP_OUTPUT_LIMIT_TOKENS, claudeParentLimitEnv, createClaudeProcessBudget } from './egdesk-claude-limits.mjs'

export const CLAUDE_ENGINE_ID = 'claude'

// What the runtime and the screen may rely on (ENGINE_CAPABILITIES names).
// Not offered: nativeHistory (the CLI gives no past turns back; local history
// is the record), approvals.tool (only Bash/PowerShell and file edits get a
// card; other tools that would ask are refused), ephemeralThreads,
// threadFork. Model and effort per turn restart the process with --resume.
// boundedQa covers only browserBounded (SUB-10, egdesk-claude-bounded).
export const CLAUDE_CAPABILITIES = Object.freeze([
  'stream', 'resume', 'interrupt', 'approvals.command', 'approvals.fileChange',
  'userInput', 'userInput.multiSelect', 'subagents', 'dynamicTools',
  'modelSelect.perTurn', 'effortSelect.perTurn', 'usage.rateLimits', 'boundedQa',
])

export const CLAUDE_ADAPTER_DEFAULTS = Object.freeze({
  residentLimit: 2, // design §9
  idleTimeoutMs: 300_000, // design §9: quit 5 min after the last turn
  interruptMs: 10_000, // the interrupt control request
  interruptSettleMs: 15_000, // backstop: a turn still open after this is ended by closing the process
  maxSessions: 500, // remembered conversations (records only; no process)
  usageTimeoutMs: 3000, // get_context_usage control request (Reader capacity evidence)
})

// `--permission-mode manual` and `--system-prompt-snapshot off` were checked
// in `claude 2.1.300 --help` only; an older CLI gets neither flag.
export const CLAUDE_HELP_CHECKED_VERSION = CLAUDE_TRANSPORT_CHECKED_VERSION

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RPC_ID = /^claude:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(perm|mcp):\d{1,12}$/i
const MAX_RPC_COUNTER = 999_999_999_999 // Keep every allocated id within RPC_ID's 12-digit suffix.
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
const coreVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+/.test(value) ? value.split(/[-+]/)[0] : null

/** The EG-Desk conversation id (= Claude session UUID) inside an adapter rpc id, or null. */
export function claudeRpcThreadId(rpcId) {
  const match = typeof rpcId === 'string' ? RPC_ID.exec(rpcId) : null
  return match ? match[1].toLowerCase() : null
}

// An error raised before anything reached Claude: the runtime may treat it as
// a definite rejection (no turn started, nothing to reconcile).
function definite(error, engineCode = null) {
  return Object.assign(error, { definite: true, ...(engineCode ? { engineCode } : {}) })
}

/** Transport start failure → the error the runtime and HTTP layer show. */
export function claudeStartError(error) {
  const code = typeof error?.code === 'string' ? error.code : null
  if (code === 'CLAUDE_API_KEY_DETECTED') return apiKeyDetectedError(Array.isArray(error.detected) ? error.detected : [])
  if (code === 'CLAUDE_NOT_FOUND' || code === 'CLAUDE_EXECUTABLE_INVALID' || code === 'CLAUDE_EXECUTABLE_BATCH_REFUSED') return definite(engineError('ENGINE_NOT_INSTALLED'), code)
  if (code === 'CLAUDE_VERSION_UNSUPPORTED' || code === 'CLAUDE_VERSION_UNKNOWN') return definite(engineError('ENGINE_VERSION_UNSUPPORTED'), code)
  if (code === 'CLAUDE_OPTION_INVALID') return definite(chatError('INVALID_ENGINE_OPTION', 'A Claude setting for this conversation is not valid', 400), code)
  return definite(engineError('ENGINE_UNAVAILABLE', 'Claude could not be started'), code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'CLAUDE_START_FAILED')
}

function apiKeyDetectedError(detected) {
  return definite(Object.assign(
    chatError('CLAUDE_API_KEY_DETECTED', 'An Anthropic API key is set in EG-Desk\'s environment. Confirm to run Claude on your subscription without it.', 409),
    // Variable names only; a value is never read.
    { detected: detected.filter(name => typeof name === 'string').slice(0, 4) },
  ))
}

/**
 * Turn input (runtime turn/start params) → the user message content.
 *   input: [{ type: 'text', text }, { type: 'image', url: 'data:image/png;base64,...' }]
 *   additionalContext: { key: { kind, value } } from tool providers (Context descriptors)
 * One text and nothing else stays a plain string (the SDK's prompt line);
 * otherwise blocks: context first, then the user's items in order.
 */
export function claudeTurnContent({ input, additionalContext = null } = {}) {
  const blocks = []
  for (const [key, entry] of Object.entries(plainObject(additionalContext) || {})) {
    const value = typeof entry === 'string' ? entry : typeof entry?.value === 'string' ? entry.value : null
    if (value && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) blocks.push({ type: 'text', text: `[EG-Desk context: ${key}]\n${value}` })
  }
  let userItems = 0
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      if (item.text.trim()) { blocks.push({ type: 'text', text: item.text }); userItems++ }
    } else if (item?.type === 'image' && typeof item.url === 'string') {
      const match = DATA_IMAGE.exec(item.url)
      if (!match) throw definite(chatError('UNSUPPORTED_INPUT', 'Claude accepts only inline PNG, JPEG, GIF or WebP images here', 400))
      blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
      userItems++
    } else if (item != null) throw definite(chatError('UNSUPPORTED_INPUT', 'This message part cannot be sent to Claude', 400))
  }
  if (!userItems) throw definite(chatError('EMPTY_MESSAGE', 'Message is required', 400))
  return blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks
}

/**
 * createClaudeEngineAdapter(options) — the runnable Claude engine.
 *
 * options
 *   snapshot()            claude-engine-auth status snapshot { installed, version, versionStatus, auth }
 *   refreshStatus(opts)   Promise; re-runs the static check (createClaudeEngineStatus().refresh)
 *   env, platform         EG-Desk's environment (API key detection, child env) / platform
 *   defaultCwd            absolute folder for conversations that name none (bridge: its cwd)
 *   inherit               D-S2 option slot { instructions, skills } (both off by default)
 *   minVersion, requiredCapabilities[]   run gates (version before spawn, init.capabilities on system/init)
 *   residentLimit, idleTimeoutMs, interruptMs, interruptSettleMs, maxSessions
 *   onStatusChange()      called when the public row may have changed (bridge: engineStatus.check())
 *   processBudget         egdesk-claude-limits budget shared with the Reader (SUB-09: one Claude
 *                         process limit across parents and Readers); own budget when omitted
 *   mcpOutputLimitTokens  MAX_MCP_OUTPUT_TOKENS given to each parent and enforced by its EG-Desk MCP
 *   collectContextUsage   false skips the get_context_usage observations (Reader capacity evidence)
 *   profiles              SUB-11 () → [{ id, label, owned, active, configDir }] (egdesk-engine-profiles
 *                         list + configDir); the active one's configDir becomes CLAUDE_CONFIG_DIR of
 *                         each new process. Omitted: the shared login only ('claude-default').
 *   resolveExecutable, createTransport, transportOptions, randomUUID, now, setTimer, clearTimer   (tests)
 *
 * Besides the EngineAdapter methods: owns(rpcId), syncStatus(), apiKeyEnv(),
 * confirmApiKeyEnv(confirmed), usage(), stats().
 */
export function createClaudeEngineAdapter(options = {}) {
  const {
    snapshot = () => ({ installed: null, version: null, versionStatus: null, auth: null }),
    refreshStatus = async () => snapshot(),
    env = process.env, platform = process.platform,
    defaultCwd = os.homedir(), inherit = {},
    minVersion = CLAUDE_TRANSPORT_MIN_VERSION, requiredCapabilities = [],
    onStatusChange = () => {},
    resolveExecutable = resolveClaudeExecutable, createTransport = createClaudeTransport, transportOptions = {},
    randomUUID = nodeRandomUUID, now = Date.now, getEpoch = () => 0,
    setTimer = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer },
    clearTimer = timer => clearTimeout(timer),
    mcpOutputLimitTokens = CLAUDE_MCP_OUTPUT_LIMIT_TOKENS, collectContextUsage = true,
    profiles = null,
    // Deleting a conversation also removes the session files Claude Code keeps for it (claude-session-files.mjs). Developer flag, default off.
    deleteSessionFiles = () => false, claudeHome = null,
  } = options
  const limits = { ...CLAUDE_ADAPTER_DEFAULTS }
  for (const key of Object.keys(limits)) if (Number.isSafeInteger(options[key]) && options[key] > 0) limits[key] = options[key]
  const processBudget = options.processBudget || createClaudeProcessBudget({ total: Math.max(3, limits.residentLimit), parent: limits.residentLimit })
  const limitEnv = claudeParentLimitEnv(mcpOutputLimitTokens)
  const isAbsolute = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && (platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value))
  if (!isAbsolute(defaultCwd)) throw new TypeError('createClaudeEngineAdapter requires an absolute defaultCwd')

  const sinks = new Set()
  const sessions = new Map() // threadId → session record
  // Adapter lifetime, not process/session lifetime: release, restart and record
  // eviction must never let a delayed answer consume a new request's id.
  let rpcCounter = 0
  let disposed = false
  let apiKeyConfirmed = false
  let gateFailure = null // { code, version } from a refused system/init; cleared when the version changes
  let rate = null // applyClaudeRateLimit state (display only, D-S5)
  let billing = null // 'subscription' | 'apiKey' from the last system/init apiKeySource
  let usageOwner = null // usage and billing belong to one signed-in slot
  let lastReady = false
  let lastOwner = null
  let ownerEpoch = 0 // includes signed-out/back-in to the same owner
  let baseline = null // newest pre-first-message get_context_usage observation (Reader evidence)
  const isolation = { hookEvents: 0, hookCallbacks: 0 } // D-S2 evidence: must stay 0 with hooks off

  const deliver = (kind, value) => { for (const sink of [...sinks]) { try { sink[kind]?.(CLAUDE_ENGINE_ID, value) } catch {} } }
  const statusChanged = () => { try { onStatusChange() } catch {} }
  const status = () => { try { return snapshot() || {} } catch { return {} } }
  // No profile integration means the shared CLI. An unavailable configured
  // selection is different: it must never launch that CLI in place of a slot.
  const profileList = () => {
    if (profiles == null) return [{ id: 'claude-default', owned: false, active: true, configDir: null }]
    let rows
    try { rows = profiles() } catch { return [] }
    if (!Array.isArray(rows)) return []
    const chosen = rows.filter(row => row?.active === true)
    if (chosen.length !== 1 || rows.filter(row => row?.id === chosen[0].id).length !== 1) return []
    const slot = chosen[0]
    const valid = slot.id === 'claude-default' ? slot.owned !== true && slot.configDir == null
      : /^claude-[a-z0-9]{1,40}$/.test(slot.id) && slot.owned === true && isAbsolute(slot.configDir)
    return valid ? rows.filter(row => row && typeof row.id === 'string') : []
  }
  const activeProfile = () => profileList().find(row => row.active === true)
  const liveCount = () => [...sessions.values()].filter(session => session.proc || session.starting).length

  function nextRpcId(threadId, kind) {
    // The transport turns this into a control error; never wrap or emit an
    // unparseable id, even after all earlier requests have been settled.
    if (rpcCounter >= MAX_RPC_COUNTER) throw new RangeError('Claude RPC id space exhausted')
    return `claude:${threadId}:${kind}:${++rpcCounter}`
  }

  function usageRow() {
    if ((!rate && !billing) || !usageOwner || usageOwner !== ownerKey()) return null
    const row = name => {
      const hit = rate?.windows.find(entry => entry.window === name)
      return hit ? { usedPercent: hit.usedPercent, windowMinutes: hit.windowMinutes, resetsAt: hit.resetsAt } : null
    }
    const limitsView = rate ? { primary: row('fiveHour'), secondary: row('weekly'), reachedType: rate.rejected ? 'rate_limit_reached' : null, usageAllowed: !rate.rejected, observedAt: rate.observedAt } : null
    return {
      ...usageDisplay(limitsView, now()),
      windows: rate ? rate.windows.map(entry => ({ ...entry })) : [],
      rejected: rate?.rejected ? { ...rate.rejected } : null,
      creditsRequired: rate?.creditsRequired === true,
      billing,
      // D-S5: never continue by itself after a limit; resetsAt is for display.
      autoResume: false,
    }
  }

  function describe() {
    const check = status()
    if (gateFailure && gateFailure.version !== (check.version ?? null)) gateFailure = null
    const choices = profileList()
    const row = describeClaudeEngine(choices.length ? check : { ...check, auth: null }, {
      minVersion, capabilities: [...CLAUDE_CAPABILITIES],
      residentProcesses: liveCount(), residentLimit: limits.residentLimit, idleTimeoutMs: limits.idleTimeoutMs,
      gateFailure: gateFailure?.code ?? null, apiKeyEnv: apiKeyEnv(), usage: usageRow(), disposed,
      profiles: choices.map(({ id, label, owned, active }) => ({ id, label, owned: owned === true, active: active === true })),
    })
    return choices.length ? row : { ...row, status: disposed ? 'disabled' : 'offline', statusReason: 'profileUnavailable', profiles: [] }
  }

  function apiKeyEnv() {
    let detected = []
    try { detected = detectApiKeyEnv(env, { platform }) } catch {}
    return { detected, confirmed: apiKeyConfirmed }
  }

  function ownerKey() {
    const auth = status().auth
    if (auth?.status !== 'signedIn') return null
    const method = typeof auth.method === 'string' ? auth.method : 'unknown'
    const who = typeof auth.account === 'string' && auth.account ? auth.account.toLowerCase() : typeof auth.label === 'string' ? auth.label : ''
    // SUB-11: an EG-Desk-owned profile is its own account slot even for the
    // same email, so a conversation bound to one never continues on another.
    const profile = activeProfile()
    if (!profile) return null
    return `claude:${method}:${who}${profile.owned === true ? `@${profile.id}` : ''}`
  }

  const isReady = () => describe().status === 'ready'

  function assertUsable() {
    if (disposed) throw definite(engineError('ENGINE_UNAVAILABLE', 'Claude has been stopped in this EG-Desk session'))
    const row = describe()
    if (row.status === 'ready') return
    if (row.statusReason === 'profileUnavailable') throw definite(chatError('ENGINE_PROFILE_UNAVAILABLE', 'Check the selected Claude account before starting a conversation', 409))
    if (row.status === 'notInstalled') throw definite(engineError('ENGINE_NOT_INSTALLED'))
    if (row.status === 'versionUnsupported') throw definite(engineError('ENGINE_VERSION_UNSUPPORTED'), row.statusReason || null)
    if (row.status === 'loginRequired') throw definite(engineError('ENGINE_LOGIN_REQUIRED', 'Sign in to Claude first (claude auth login)'))
    throw definite(engineError('ENGINE_UNAVAILABLE', 'Claude has not been checked yet or did not answer'), row.statusReason || null)
  }

  function assertApiKeyEnv() {
    const { detected } = apiKeyEnv()
    if (detected.length && !apiKeyConfirmed) throw apiKeyDetectedError(detected)
  }

  // Thread settings: cwd, model, effort, Agent instructions, EG-Desk tools.
  function specFrom(params, previous = null) {
    const p = plainObject(params) || {}
    const spec = previous ? { ...previous } : { cwd: defaultCwd, model: null, effort: null, appendPrompt: null, tools: [], bounded: null }
    // SUB-10: the runtime's bounded Browser policy; it never widens back on resume.
    if (p.egdeskBoundedPolicy !== undefined && p.egdeskBoundedPolicy !== null) {
      if (!CLAUDE_BOUNDED_POLICIES.includes(p.egdeskBoundedPolicy)) throw definite(chatError('QA_POLICY_UNAVAILABLE', 'Claude supports only the bounded Browser policy', 503))
      spec.bounded = p.egdeskBoundedPolicy
    }
    if (p.cwd !== undefined && p.cwd !== null) {
      if (!isAbsolute(p.cwd)) throw definite(chatError('INVALID_CWD', 'The working folder must be an absolute path', 400))
      spec.cwd = p.cwd
    }
    if (p.model !== undefined && p.model !== null) spec.model = checkedModel(p.model)
    // '' is the runtime's explicit "no instructions" (profile off).
    if (p.developerInstructions !== undefined) spec.appendPrompt = typeof p.developerInstructions === 'string' && p.developerInstructions.trim() ? p.developerInstructions : null
    if (Array.isArray(p.dynamicTools)) spec.tools = p.dynamicTools
    // u1 (EG-Desk harness, flag EGDESK_CLAUDE_HARNESS): the built-in Claude Code tools EG-Desk's own tools replace are switched off with --disallowedTools (names only; the CLI binary is untouched)
    // u1: a private turn's thread has NO built-in tools (--tools ""): names only, [] disables them all
    if (Array.isArray(p.egdeskBuiltinTools)) spec.builtin = Object.freeze(p.egdeskBuiltinTools.filter(name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)).slice(0, 32))
    if (Array.isArray(p.egdeskDisallowedTools)) spec.disallowed = Object.freeze(p.egdeskDisallowedTools.filter(name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)).slice(0, 32))
    return spec
  }

  function checkedModel(model) {
    try { buildClaudeArgs({ model, platform }) } catch { throw definite(chatError('INVALID_MODEL', 'Invalid model', 400)) }
    return model
  }

  function newSession(threadId, spec, hasHistory) {
    if (sessions.size >= limits.maxSessions) {
      const oldest = [...sessions.values()].filter(entry => !entry.proc && !entry.starting && !entry.activeTurn).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (oldest) sessions.delete(oldest.threadId)
    }
    const session = {
      threadId, spec, hasHistory, loaded: true, proc: null, starting: null, activeTurn: null, turnStarting: false,
      lastUsedAt: now(), idleTimer: null, settleTimer: null, dispatchEpoch: 0,
      translator: createClaudeTranslator({ threadId, egdeskMcpServer: EGDESK_MCP_SERVER_NAME }),
    }
    sessions.set(threadId, session)
    return session
  }

  const clearIdle = session => { if (session.idleTimer) { clearTimer(session.idleTimer); session.idleTimer = null } }
  const clearSettle = session => { if (session.settleTimer) { clearTimer(session.settleTimer); session.settleTimer = null } }
  // Approvals/questions waiting on the user, and EG-Desk tool calls in flight
  // (egdesk-claude-mcp has no size(), so the adapter counts the ids it handed out).
  const pendingOf = proc => proc ? proc.broker.size() + proc.mcpPending.size : 0

  function scheduleIdle(session) {
    clearIdle(session)
    if (!session.proc || session.activeTurn || pendingOf(session.proc)) return
    session.idleTimer = setTimer(() => {
      session.idleTimer = null
      if (session.proc && !session.activeTurn && !pendingOf(session.proc)) void closeProcess(session)
    }, limits.idleTimeoutMs)
  }

  async function closeProcess(session, closeOptions) {
    clearIdle(session)
    clearSettle(session)
    const proc = session.proc
    if (!proc) return
    await proc.transport.close(closeOptions).catch(() => {})
    if (session.proc === proc) session.proc = null
    if (proc.transport.state?.() === 'exited') proc.lease?.release()
  }

  // SUB-09 capacity evidence: this conversation's own native usage, never a
  // model-name table. Kept only while the same owner/process answered it.
  async function collectUsage(session, proc, basis) {
    if (!collectContextUsage || proc.exited || session.proc !== proc) return null
    const owner = ownerKey(), epoch = ownerEpoch
    let usage
    try { usage = await proc.transport.request('get_context_usage', {}, { timeoutMs: limits.usageTimeoutMs }) } catch { return null }
    if (!plainObject(usage) || owner === null || owner !== ownerKey() || epoch !== ownerEpoch || session.proc !== proc || proc.exited) return null
    let copy
    try { copy = structuredClone(usage) } catch { return null }
    const observation = Object.freeze({ threadId: session.threadId, ownerKey: owner, engineBuild: proc.engineBuild,
      usage: copy, observedAt: now(), mcpOutputLimitTokens: proc.mcp.outputLimitTokens(), basis })
    session.observation = observation
    if (basis === 'baseline') baseline = observation
    return observation
  }

  // Two resident processes at most; the longest-idle one makes room.
  async function makeRoom(session) {
    const live = [...sessions.values()].filter(entry => entry !== session && (entry.proc || entry.starting))
    if (live.length < limits.residentLimit) return
    const idle = live.filter(entry => entry.proc && !entry.starting && !entry.activeTurn && !entry.turnStarting && !pendingOf(entry.proc))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    if (live.length - idle.length >= limits.residentLimit) {
      throw definite(engineError('ENGINE_BUSY', `${limits.residentLimit} Claude conversations are already working; wait for one to finish`))
    }
    for (const entry of idle.slice(0, live.length - limits.residentLimit + 1)) await closeProcess(entry, { graceMs: 2000 })
  }

  // SUB-09: the process budget shared with source Readers. An idle parent
  // gives its slot up; a busy one (or Readers holding the rest) means BUSY.
  async function leaseProcess(session) {
    let lease = processBudget.tryAcquire('parent')
    if (lease) return lease
    const idle = [...sessions.values()].filter(entry => entry !== session && entry.proc && !entry.starting && !entry.activeTurn && !entry.turnStarting && !pendingOf(entry.proc))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    if (idle.length) {
      await closeProcess(idle[0], { graceMs: 2000 })
      lease = processBudget.tryAcquire('parent')
    }
    if (!lease) throw definite(engineError('ENGINE_BUSY', 'Every Claude process slot (conversations and source Readers) is in use; wait for one to finish'))
    return lease
  }

  function onProcessExit(session, proc) {
    proc.exited = true
    proc.lease?.release()
    for (const notification of proc.broker.abortAll()) deliver('notification', notification)
    proc.mcp.abortAll()
    proc.mcpPending.clear()
    if (session.proc === proc) session.proc = null
    clearIdle(session)
    clearSettle(session)
    const turn = session.activeTurn
    if (turn) {
      // Only this conversation's turn ends; the engine stays connected (design §4.1).
      session.activeTurn = null
      const interrupted = turn.interruptRequested === true
      const code = proc.gateCode || 'RUNTIME_LOST'
      deliver('notification', { method: 'turn/completed', params: {
        threadId: session.threadId, turnId: turn.turnId,
        turn: { id: turn.turnId, status: interrupted ? 'interrupted' : 'failed', items: [],
          error: interrupted ? null : { message: `The Claude process ended before the turn finished (${code})`, code, kind: 'unknown', origin: 'claude' } },
      } })
    }
    statusChanged()
  }

  const boundedDescriptor = spec => spec.bounded
    ? { egdeskBounded: { mode: spec.bounded, builtinTools: 'none', permissionMode: 'dontAsk', mcp: 'egdesk-only', restricted: true } }
    : {}

  function onProcessMessage(session, proc, message) {
    if (proc.blocked) return // a bounded process that failed its init check: nothing it says is accepted
    if (proc.bounded && message?.type === 'system' && message.subtype === 'init') {
      const violation = claudeBoundedInitViolation(message, { serverName: EGDESK_MCP_SERVER_NAME })
      if (violation) {
        proc.blocked = true
        proc.gateCode = 'CLAUDE_BOUNDED_UNVERIFIED'
        void proc.transport.close({ graceMs: 0 }).catch(() => {})
        return
      }
      proc.boundedVerified = true
    }
    // D-S2: hooks are off (--settings disableAllHooks, no SDK hooks). A hook
    // event means a managed or otherwise unswitchable hook ran for this build.
    if (message?.type === 'system' && typeof message.subtype === 'string' && message.subtype.startsWith('hook_')) isolation.hookEvents++
    const mayRecordUsage = () => {
      if (session.proc !== proc || proc.exited || proc.ownerEpoch !== ownerEpoch || !proc.owner || proc.owner !== ownerKey()) return false
      if (usageOwner !== proc.owner) { usageOwner = proc.owner; rate = null; billing = null }
      return true
    }
    if (message?.type === 'system' && message.subtype === 'init') {
      session.hasHistory = true
      const init = proc.transport.info().init
      if (init && mayRecordUsage()) {
        const next = init.billsApiKey ? 'apiKey' : 'subscription'
        if (next !== billing) { billing = next; statusChanged() }
      }
    } else if (message?.type === 'result' || message?.type === 'assistant') session.hasHistory = true
    for (const event of session.translator.translate(message)) {
      if (event.method === 'egdesk/engine/rateLimit') {
        if (!mayRecordUsage()) continue
        rate = applyClaudeRateLimit(rate, event.params, now())
        statusChanged()
      }
      deliver('notification', event)
      if (event.method === 'turn/completed' && session.activeTurn && event.params?.turn?.id === session.activeTurn.turnId) {
        session.activeTurn = null
        session.lastUsedAt = now()
        clearSettle(session)
        scheduleIdle(session)
        void collectUsage(session, proc, 'turn')
      }
    }
  }

  function ensureProcess(session, assertDispatch = () => {}) {
    if (session.proc && !session.proc.exited) return Promise.resolve(session.proc)
    if (session.starting) return session.starting
    session.starting = (async () => {
      await makeRoom(session)
      const lease = await leaseProcess(session)
      try { assertDispatch() } catch (error) { lease.release(); throw error }
      let executablePath = null
      try { executablePath = resolveExecutable(env, { platform }) } catch {}
      if (!executablePath) { lease.release(); throw definite(engineError('ENGINE_NOT_INSTALLED'), 'CLAUDE_NOT_FOUND') }
      const check = status()
      const spec = session.spec
      const helpChecked = coreVersion(check.version) && compareVersions(coreVersion(check.version), CLAUDE_HELP_CHECKED_VERSION) >= 0
      if (spec.bounded && !(coreVersion(check.version) && compareVersions(coreVersion(check.version), CLAUDE_BOUNDED_MIN_VERSION) >= 0)) {
        lease.release()
        throw definite(chatError('QA_POLICY_UNAVAILABLE', `A bounded Browser conversation needs Claude ${CLAUDE_BOUNDED_MIN_VERSION} or newer`, 503))
      }
      const threadId = session.threadId
      const proc = {
        transport: null, exited: false, gateCode: null, owner: ownerKey(), ownerEpoch, mcpPending: new Map(), // rpc id → control request id
        lease, engineBuild: typeof check.version === 'string' ? check.version : null,
        bounded: spec.bounded || null, blocked: false, boundedVerified: false,
        flags: { cwd: spec.cwd, model: spec.model, effort: spec.effort, appendPrompt: spec.appendPrompt, tools: spec.tools, bounded: spec.bounded || null, disallowed: spec.disallowed ?? null, builtin: spec.builtin ?? null },
        broker: createClaudePermissionBroker({ threadId, egdeskServer: EGDESK_MCP_SERVER_NAME, offerSessionGrant: true,
          nextRpcId: () => nextRpcId(threadId, 'perm') }),
        mcp: createEgdeskClaudeMcp({ threadId, tools: spec.tools, serverName: EGDESK_MCP_SERVER_NAME,
          nextRpcId: () => nextRpcId(threadId, 'mcp'), outputLimitTokens: mcpOutputLimitTokens }),
      }
      const hasTools = proc.mcp.listTools().length > 0
      const turnOf = () => session.activeTurn?.turnId ?? null
      const profile = activeProfile()
      if (!profile) { lease.release(); throw definite(chatError('ENGINE_PROFILE_UNAVAILABLE', 'Selected Claude account unavailable', 409)) }
      const profileDir = profile.configDir
      proc.transport = createTransport({
        ...transportOptions,
        ...(typeof profileDir === 'string' && profileDir ? { claudeConfigDir: profileDir } : {}),
        extraEnv: { ...(plainObject(transportOptions.extraEnv) || {}), ...limitEnv },
        executablePath, cwd: spec.cwd, version: typeof check.version === 'string' ? check.version : null,
        minVersion, requiredCapabilities, apiKeyEnvPolicy: apiKeyConfirmed ? 'strip' : 'stop', env, platform, inherit,
        model: spec.model, effort: spec.effort, appendPrompt: spec.appendPrompt,
        ...(helpChecked ? { permissionMode: 'manual', systemPromptSnapshot: 'off' } : {}),
        ...(spec.bounded ? claudeBoundedLaunch() : {}),
        ...(session.hasHistory ? { resume: threadId } : { sessionId: threadId }),
        mcpConfig: hasTools ? egdeskMcpConfig(EGDESK_MCP_SERVER_NAME) : null,
        allowedTools: hasTools ? [egdeskAllowedToolsRule(EGDESK_MCP_SERVER_NAME)] : null,
        ...(spec.disallowed?.length && !spec.bounded ? { disallowedTools: [...spec.disallowed] } : {}),
        ...(spec.builtin && !spec.bounded ? { tools: [...spec.builtin] } : {}),
        controlHandlers: {
          can_use_tool: (request, { requestId }) => {
            // dontAsk already denies; a bounded process never shows an approval card.
            if (proc.blocked || (proc.bounded && !String(request?.tool_name || '').startsWith(`mcp__${EGDESK_MCP_SERVER_NAME}__`))) {
              return { response: { behavior: 'deny', message: 'This bounded Browser conversation has EG-Desk tools only', interrupt: false } }
            }
            const routed = proc.broker.request({ kind: 'canUseTool', requestId, subtype: 'can_use_tool', request }, { turnId: turnOf(), cwd: spec.cwd })
            if (routed.write) return { write: routed.write }
            if (routed.serverRequest) { clearIdle(session); deliver('serverRequest', routed.serverRequest) }
            return undefined
          },
          mcp_message: (request, { requestId }) => {
            if (proc.blocked) return { error: 'This Claude process failed its bounded policy check' }
            const routed = proc.mcp.handle({ kind: 'mcpMessage', requestId, request }, { turnId: turnOf() })
            if (routed.write) return { write: routed.write }
            if (routed.serverRequest) {
              proc.mcpPending.set(routed.serverRequest.id, requestId)
              clearIdle(session)
              // A source read is admitted against this conversation's usage
              // measured now, not after the previous turn (Reader evidence).
              if (routed.serverRequest.params?.tool === 'egdesk_read_source' && collectContextUsage) {
                void collectUsage(session, proc, 'tool-call').finally(() => {
                  if (proc.mcpPending.has(routed.serverRequest.id)) deliver('serverRequest', routed.serverRequest)
                })
              } else deliver('serverRequest', routed.serverRequest)
            }
            return undefined
          },
          hook_callback: () => {
            // EG-Desk registers no SDK hooks (initialize hooks: null).
            isolation.hookCallbacks++
            isolation.hookEvents++
            return { error: 'EG-Desk registers no hooks' }
          },
        },
        onControlCancel: (requestId, subtype, reason) => {
          // 'exit' is settled once, with abortAll, in onExit.
          if (reason !== 'cancelled') return
          if (subtype === 'can_use_tool') {
            const cancelled = proc.broker.cancel(requestId)
            if (cancelled?.notification) deliver('notification', cancelled.notification)
          } else if (subtype === 'mcp_message' && proc.mcp.cancel(requestId)) {
            for (const [rpcId, controlId] of proc.mcpPending) if (controlId === requestId) proc.mcpPending.delete(rpcId)
          }
        },
        onMessage: message => onProcessMessage(session, proc, message),
        onNotice: notice => {
          if (!notice?.fatal || typeof notice.code !== 'string') return
          proc.gateCode = notice.code
          gateFailure = { code: notice.code, version: status().version ?? null }
          syncStatus()
        },
        onExit: () => onProcessExit(session, proc),
      })
      session.proc = proc
      try {
        await proc.transport.start()
        assertDispatch()
        if (!session.hasHistory) void collectUsage(session, proc, 'baseline')
      } catch (error) {
        if (session.proc === proc) session.proc = null
        await proc.transport.close({ graceMs: 0 }).catch(() => {})
        lease.release()
        if (error?.definite === true) throw error
        throw claudeStartError(error)
      }
      statusChanged()
      return proc
    })().finally(() => { session.starting = null })
    return session.starting
  }

  // Process flags fixed at spawn; a turn that changes one restarts with --resume.
  const flagsDiffer = (flags, spec) => flags.cwd !== spec.cwd || flags.model !== spec.model || flags.effort !== spec.effort
    || flags.appendPrompt !== spec.appendPrompt || flags.tools !== spec.tools || flags.bounded !== (spec.bounded || null) || JSON.stringify(flags.disallowed ?? null) !== JSON.stringify(spec.disallowed ?? null) || JSON.stringify(flags.builtin ?? null) !== JSON.stringify(spec.builtin ?? null)

  function syncStatus() {
    const ready = isReady()
    const owner = ownerKey()
    const accountChanged = lastReady && ready && owner !== lastOwner
    if (!ready || accountChanged) {
      ownerEpoch++
      rate = null; billing = null; usageOwner = null
      baseline = null
      for (const session of sessions.values()) session.observation = null
      for (const session of sessions.values()) void closeProcess(session, { graceMs: 0 })
    }
    if (accountChanged) deliver('connection', { ready: false })
    if (ready !== lastReady || accountChanged) deliver('connection', { ready })
    lastReady = ready
    lastOwner = owner
    statusChanged()
    return ready
  }

  function sessionOfRpc(rpcId) {
    const threadId = claudeRpcThreadId(rpcId)
    return threadId ? sessions.get(threadId) || null : null
  }

  return {
    id: CLAUDE_ENGINE_ID,
    describe,
    async refresh() {
      try { await refreshStatus({ force: true }) } catch {}
      syncStatus()
      return describe()
    },
    capabilities: () => new Set(CLAUDE_CAPABILITIES),
    ownerKey,
    isReady,
    // No model list is read from the CLI yet; null means "unknown, not checked".
    models: () => null,

    async startThread(params = {}) {
      assertUsable()
      if (params?.ephemeral === true) throw definite(chatError('STATELESS_UNSUPPORTED', 'Claude cannot start a conversation without saved history here', 409))
      assertApiKeyEnv()
      const spec = specFrom(params)
      const threadId = String(randomUUID()).toLowerCase()
      if (!UUID.test(threadId)) throw new TypeError('randomUUID must return a UUID')
      // The process starts with the first turn, which also carries the effort.
      newSession(threadId, spec, false)
      return { thread: { id: threadId, ephemeral: false, cwd: spec.cwd }, cwd: spec.cwd, model: spec.model, ...boundedDescriptor(spec) }
    },

    async resumeThread(params = {}) {
      assertUsable()
      assertApiKeyEnv()
      const threadId = typeof params?.threadId === 'string' ? params.threadId.toLowerCase() : ''
      if (!UUID.test(threadId)) throw definite(chatError('THREAD_NOT_FOUND', 'This is not a Claude conversation id', 404))
      let session = sessions.get(threadId)
      if (session?.activeTurn || session?.turnStarting) throw definite(chatError('RUN_IN_PROGRESS', 'This conversation already has an active turn', 409))
      if (session) {
        if (session.hasHistory && params.cwd != null && params.cwd !== session.spec.cwd) {
          throw definite(chatError('CWD_CHANGE_UNSUPPORTED', 'A Claude conversation keeps the folder it started in; start a new conversation for another folder', 409))
        }
        const spec = specFrom(params, session.spec)
        if (session.proc && flagsDiffer(session.proc.flags, spec)) await closeProcess(session)
        session.spec = spec
        session.loaded = true
      } else {
        // Not started in this EG-Desk run: --resume finds it by id in the same folder.
        session = newSession(threadId, specFrom(params), true)
      }
      session.lastUsedAt = now()
      return { thread: { id: threadId, turns: [], cwd: session.spec.cwd }, cwd: session.spec.cwd, model: session.spec.model, ...boundedDescriptor(session.spec) }
    },

    // The files Claude Code kept for a conversation EG-Desk started (L2 c19). Only with the flag, only for an id EG-Desk's own record binds
    // to that conversation (recorded), under the config folder of the profile the conversation was bound to. The process is closed first.
    threadDeleteSupported: () => { try { return deleteSessionFiles() === true } catch { return false } },
    async deleteThread(threadId, profileId, { recorded = false } = {}) {
      let allowed = false
      try { allowed = deleteSessionFiles() === true } catch { allowed = false }
      if (!allowed) throw chatError('THREAD_DELETE_UNSUPPORTED', 'Deleting Claude session files is not enabled', 409)
      const id = typeof threadId === 'string' ? threadId.toLowerCase() : ''
      const slot = profileId && profileId !== 'claude-default' ? profileList().find(row => row.id === profileId) : null
      if (profileId && profileId !== 'claude-default' && !(slot && typeof slot.configDir === 'string')) return { state: 'remains', files: 0, reason: 'profile_unavailable' }
      const home = claudeHome ?? env.HOME ?? os.homedir()
      const configured = typeof env.CLAUDE_CONFIG_DIR === 'string' && isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : null
      const configDir = slot ? slot.configDir : configured ?? path.join(home, '.claude')
      const session = sessions.get(id)
      if (session) { session.loaded = false; session.dispatchEpoch++; await closeProcess(session); sessions.delete(id) }
      return deleteClaudeSessionFiles({ configDir, sessionId: id, recorded: recorded === true, platform })
    },

    async releaseThread(threadId) {
      const session = typeof threadId === 'string' ? sessions.get(threadId.toLowerCase()) : null
      if (!session || !session.loaded) return { status: 'notLoaded' }
      session.loaded = false
      session.dispatchEpoch++
      await closeProcess(session)
      return { status: 'unsubscribed' }
    },

    async startTurn(params = {}) {
      const threadId = typeof params?.threadId === 'string' ? params.threadId.toLowerCase() : ''
      const session = sessions.get(threadId)
      if (!session || !session.loaded) throw definite(chatError('THREAD_NOT_LOADED', 'Resume this Claude conversation first', 409))
      if (session.activeTurn || session.turnStarting) throw definite(chatError('RUN_IN_PROGRESS', 'This conversation already has an active turn', 409))
      assertUsable()
      assertApiKeyEnv()
      const content = claudeTurnContent(params)
      const next = { ...session.spec }
      if (params.model !== undefined && params.model !== null) next.model = checkedModel(params.model)
      if (params.effort !== undefined && params.effort !== null) {
        if (!CLAUDE_EFFORT_LEVELS.includes(params.effort)) throw definite(chatError('EFFORT_UNSUPPORTED', `Claude effort must be one of ${CLAUDE_EFFORT_LEVELS.join(', ')}`, 400))
        next.effort = params.effort
      }
      if (params.cwd !== undefined && params.cwd !== null && params.cwd !== session.spec.cwd) {
        if (session.hasHistory) throw definite(chatError('CWD_CHANGE_UNSUPPORTED', 'A Claude conversation keeps the folder it started in; start a new conversation for another folder', 409))
        if (!isAbsolute(params.cwd)) throw definite(chatError('INVALID_CWD', 'The working folder must be an absolute path', 400))
        next.cwd = params.cwd
      }
      session.turnStarting = true
      const expectedOwner = ownerKey(), expectedEpoch = ownerEpoch, externalEpoch = getEpoch(), dispatchEpoch = session.dispatchEpoch
      const assertDispatch = () => {
        if (ownerKey() !== expectedOwner || ownerEpoch !== expectedEpoch || getEpoch() !== externalEpoch) {
          throw definite(chatError('ACCOUNT_CHANGED', 'Claude account scope changed before dispatch', 409))
        }
        if (!session.loaded || session.dispatchEpoch !== dispatchEpoch || sessions.get(threadId) !== session) {
          throw definite(chatError('READ_CANCELLED', 'Claude dispatch was stopped before input was sent', 409))
        }
        assertUsable()
        assertApiKeyEnv()
      }
      try {
        clearIdle(session)
        if (session.proc && flagsDiffer(session.proc.flags, next)) await closeProcess(session)
        assertDispatch()
        session.spec = next
        const proc = await ensureProcess(session, assertDispatch)
        assertDispatch()
        const turnId = String(randomUUID()).toLowerCase()
        // Synchronous from here: no stdout line can arrive between these steps.
        const started = session.translator.beginTurn(turnId)
        session.activeTurn = { turnId, interruptRequested: false }
        try {
          proc.transport.sendUserMessage(content)
        } catch (error) {
          session.activeTurn = null
          throw definite(engineError('ENGINE_UNAVAILABLE', 'Claude did not accept the message'), typeof error?.code === 'string' ? error.code : 'CLAUDE_WRITE_FAILED')
        }
        session.lastUsedAt = now()
        for (const event of started) deliver('notification', event)
        return { turn: { id: turnId, status: 'inProgress', items: [] } }
      } finally {
        session.turnStarting = false
      }
    },

    async interruptTurn(threadId, turnId) {
      const session = typeof threadId === 'string' ? sessions.get(threadId.toLowerCase()) : null
      const turn = session?.activeTurn
      // A stop while makeRoom/initialize is pending has no native turn yet.
      // Invalidate that dispatch without inventing a successful native stop.
      if (!turn && session?.turnStarting && turnId == null) {
        session.dispatchEpoch++
        await closeProcess(session, { graceMs: 0 })
        return {}
      }
      if (!turn || (turnId != null && turn.turnId !== turnId)) return {}
      turn.interruptRequested = true
      session.translator.markInterruptRequested()
      const proc = session.proc
      if (!proc) return {}
      // Backstop (claude-agent-acp cancelTurns): a CLI that never writes the
      // interrupted result is closed, and onExit ends the turn 'interrupted'.
      clearSettle(session)
      session.settleTimer = setTimer(() => {
        session.settleTimer = null
        if (session.activeTurn === turn) void closeProcess(session, { graceMs: 0 })
      }, limits.interruptSettleMs)
      try {
        await proc.transport.interrupt({ timeoutMs: limits.interruptMs })
      } catch {
        if (session.activeTurn === turn) await closeProcess(session, { graceMs: 0 })
      }
      return {}
    },

    // The runtime's answer to an approval, question or EG-Desk tool call.
    respond(rpcId, result, error) {
      const session = sessionOfRpc(rpcId)
      const proc = session?.proc
      if (!proc || proc.exited) return false
      const answer = proc.broker.respond(rpcId, result, error) || proc.mcp.respond(rpcId, result, error)
      if (!answer?.write) return false
      proc.mcpPending.delete(rpcId)
      const requestId = answer.write.response.request_id
      let written = false
      try { written = proc.transport.respondControl(requestId, { write: answer.write }) }
      catch { try { written = proc.transport.respondControl(requestId, { error: 'EG-Desk could not deliver this answer' }) } catch {} }
      if (!session.activeTurn) scheduleIdle(session)
      return written
    },

    owns(rpcId) {
      const proc = sessionOfRpc(rpcId)?.proc
      return Boolean(proc && !proc.exited && (proc.broker.owns(rpcId) || proc.mcp.owns(rpcId)))
    },

    subscribe(sink) {
      sinks.add(sink)
      return () => { sinks.delete(sink) }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      await Promise.all([...sessions.values()].map(session => closeProcess(session, { graceMs: 0 })))
      if (lastReady) deliver('connection', { ready: false })
      lastReady = false
      sinks.clear()
      statusChanged()
    },

    /** Re-reads the static check: readiness and account changes reach the runtime as connection events. */
    syncStatus,
    /** D-S4: API key variable names in EG-Desk's environment and whether the user confirmed running without them. */
    apiKeyEnv,
    /** D-S4 confirmation for this helper run only (never saved). */
    confirmApiKeyEnv(confirmed = true) {
      apiKeyConfirmed = confirmed === true
      statusChanged()
      return apiKeyEnv()
    },
    usage: usageRow,
    /** SUB-09 Reader evidence: this conversation's newest native get_context_usage (frozen) or null. */
    contextObservation(threadId) {
      const session = typeof threadId === 'string' ? sessions.get(threadId.toLowerCase()) : null
      const observation = session?.observation
      return observation && observation.ownerKey === ownerKey() ? observation : null
    },
    baselineObservation: () => (baseline && baseline.ownerKey === ownerKey() ? baseline : null),
    async collectContextUsage(threadId) {
      const session = typeof threadId === 'string' ? sessions.get(threadId.toLowerCase()) : null
      return session?.proc ? collectUsage(session, session.proc, session.hasHistory ? 'turn' : 'baseline') : null
    },
    isolationEvents: () => ({ ...isolation }),
    processBudget: () => processBudget,
    stats: () => ({
      sessions: sessions.size, residentProcesses: liveCount(),
      activeTurns: [...sessions.values()].filter(session => session.activeTurn).length,
      gateFailure: gateFailure?.code ?? null, billing,
    }),
  }
}
