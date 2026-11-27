// c22: the real-engine check. It drives EG-Desk's REAL chat runtime (CodexChatRuntime with own tools, turn memory, draft check, heartbeat,
// terminal gate and the Decision client as codex-bridge-server.mjs builds them) against a Codex app-server binary and home that are given ONLY
// by flags, over the app-server's stdio protocol, and writes one record per scripted turn. scripts/egdesk-real-engine-check.mjs is the CLI.
//
// What is real: the runtime, the own-tools wiring (executor, file tools, ledger, gate), the Decision client and egress gate, turn memory,
// the chat store, the app-server RPC. What the check supplies: the app-server child (given binary), a scripted approver, an owner-only scratch
// folder per conversation, an isolated data folder, and the records. Nothing here starts a Codex unless run() is called with mode 'run'.
//
// Rules the check enforces itself:
//   - ephemeral threads only: a thread/start or thread/fork without ephemeral:true is refused before it is sent, and a thread the engine
//     does not report ephemeral ends the conversation;
//   - own tools are always ON; the engine's folder is EG-Desk's empty folder, the conversation's scratch folder is the only place its tools work;
//   - the app-server gets a small environment (PATH, HOME, locale, TMPDIR, and CODEX_HOME only with --codex-home), never an API key or a
//     Decision key; --person-home leaves CODEX_HOME unset so the person's own login is used; the check never reads that folder;
//   - Decision calls go through the run's egress gate (the runtime's own) with the key from the environment, only with --decisions;
//   - no retries anywhere; one app-server process per conversation, killed as a whole process group (SIGTERM, 2 s, SIGKILL).
import { upperBundleFlags } from './egdesk-upper-bundle.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { constants } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs' // c37: --engine claude drives EG-Desk's own adapter, as the product does
import { createClaudeEngineStatus, probeClaudeEngine, resolveClaudeExecutable } from './claude-engine-auth.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { CLAUDE_DEFAULT_MAX_CONVERSATIONS, CLAUDE_USAGE_STOP_PERCENT, claudeApplicability, claudeRequest, createUsageGuard, fileUsageState, validateClaudeOptions, wrapClaudeAdapter } from './egdesk-real-engine-claude.mjs'
import { formatClaudePlan, planClaudeRun } from './egdesk-real-engine-claude-plan.mjs'
import { CodexChatRuntime, TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS } from './codex-chat-runtime.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { readOwnToolsIsolation } from './egdesk-own-tools-isolation.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openProfileStore } from './egdesk-profile-store.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { createDecisionBudget, createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { createDecisionTransport } from './egdesk-decision-transport.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { openBridgeSettings } from './egdesk-bridge-settings.mjs'
import { createTurnMemoryConfig, turnMemoryFlagsFromEnv } from './egdesk-turn-memory-wiring.mjs'
import { createWikiAdapter, openWikiWrites } from './egdesk-wiki-adapter.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { createGitTargetInspector } from './egdesk-terminal-git-facts.mjs'
import { createDecisionActivity, createDecisionWarmup, warmupConfigFromEnv } from './egdesk-decision-warmup.mjs'
import { parseCodexUserAgent } from './egdesk-codex-version-pin.mjs'
import { buildCodexAppServerLaunch, inspectNativeCapabilities } from './egdesk-native-capabilities.mjs'
import { APPROVER_TEXT, checkTurnExpectations, folderPathProblem, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { memoryNeedsDecisions } from './egdesk-real-engine-memory.mjs' // memory hook (L7 c26)
import { applyRateLimitsUpdate } from './codex-account-usage.mjs' // c34: the engine's own usage readings (account/rateLimits/updated), recorded per turn
import { ENGINE_STALL_FLAG, ENGINE_STALL_LIMITS, isProgressEvent, mergeStallRecords, stallConfigFromEnv, stallLine, stallRecord, stallTotals } from './egdesk-engine-stall.mjs' // c33
import { createChatHttpHandler } from './codex-bridge-http.mjs' // c28: the product's route handler (the window's own request for a conversation delete)
import { registerConversationForgetters } from './egdesk-conversation-forgetters.mjs' // c28: the same per-conversation forgetters the bridge registers
import { seedWrites, writesFacts } from './egdesk-real-engine-delete.mjs'
import { createTurnHooks, registeredDecisionFlags, registeredFlags } from './egdesk-real-engine-extensions.mjs' // the lanes' per-turn hooks (memory, journey, ...): registered in egdesk-real-engine-registrations.mjs
import { CHECK_HOOKS, hookDecisionFlags, hookFlags } from './egdesk-real-engine-hooks.mjs'

export const DECISION_KEY_ENV = 'EGDESK_REAL_CHECK_DECISION_KEY'
export const CHILD_ENV_ALLOW = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'])
export const DEFAULT_TURN_TIMEOUT_MS = 180_000
export const KILL_GRACE_MS = 2000
// Flags a conversation gets when --decisions is on and its script names none of its own (a script's flags are added to these, never replaced):
// the product's advisory draft check (records only; the posted answer is the model's own) and the command gate. Every other flag is off.
// flags that do something only when the Decision model answers: without --decisions a script that sets one would pass or fail for the wrong reason
export const DECISION_DEPENDENT_FLAGS = Object.freeze(['EGDESK_DRAFT_CHECK', 'EGDESK_CONVERSATION_FLOW', 'EGDESK_COMMAND_JUDGE', 'EGDESK_WORKING_MEMORY', 'EGDESK_CONTEXT_RELEVANCE', 'EGDESK_TERMINAL_GATE', 'EGDESK_DECISION_WARMUP', ...hookDecisionFlags(), ...registeredDecisionFlags()])
// c24: nothing is on by default any more; the draft check is a conversation's own opt-in (conversation.draftCheck in the script, like memory) because it costs Decision calls
export const DEFAULT_DECISION_FLAGS = Object.freeze({})
// The bridge's decisionContext keys and the developer flags behind them that this composition reproduces. A test compares this list with
// codex-bridge-server.mjs, so a key or flag the bridge gains and this composition lacks fails loudly instead of being silently absent.
export const BRIDGE_COMPOSITION = Object.freeze({
  // decisionContext keys the bridge sets, and the developer flags behind them, that this composition reproduces
  keys: ['settingsGeneration', 'mode', 'configured', 'client', 'budgetMs', 'coldBudgetMs', 'warm', 'warmup', 'inRunMessages', 'openItems', 'proposalRegistry', 'calibrationLog', 'turnMemory', 'browserEntry', 'draftCheck', 'conversationFlow',
    'relevanceRules', 'commandJudge', 'terminalGate', 'workingMemory', 'topicRecipient', 'recipientForChatChoice', 'reviewRevision', 'memoryEvidence', 'collect', 'briefingPrefill'],
  // top-level options of the bridge's new CodexChatRuntime({ … }) that this composition passes (request / respond / toolProviders etc. are the check's own)
  runtimeKeys: ['contexts', 'toolProviders', 'ownToolsWiring', 'roomAccount', 'store', 'requireStore', 'getOwnerKey', 'emit', 'emitLegacy', 'agentReloadReuse', 'engineStall'],
  flags: ['EGDESK_DRAFT_CHECK', 'EGDESK_DRAFT_CHECK_DESIGN', 'EGDESK_DRAFT_CHECK_FILES', 'EGDESK_DRAFT_CHECK_INCOMPLETE', 'EGDESK_CONVERSATION_FLOW', 'EGDESK_COMMAND_JUDGE', 'EGDESK_TERMINAL_GATE', 'EGDESK_TERMINAL_GATE_METHOD',
    'EGDESK_WORKING_MEMORY', 'EGDESK_CONTEXT_RELEVANCE', 'EGDESK_OWN_TOOLS', 'EGDESK_INRUN_MESSAGES', 'EGDESK_FLOW_STALLED_COPY', 'EGDESK_FLOW_NOTE_WORDING', 'EGDESK_UPPER', 'EGDESK_ROOM_ACCOUNT', 'EGDESK_DECISION_WARMUP', 'EGDESK_AGENT_RELOAD_REUSE', ...hookFlags(), ...registeredFlags()],
  // present in the bridge, deliberately not reproduced: each needs a window, the Desk, a store this check does not open, or another lane's module
  notReproduced: {
    keys: ['browserEntry', 'reviewRevision', 'memoryEvidence', 'settingsGeneration', 'nunchi', 'browserSteps'], // nunchi (u1, flag EGDESK_NUNCHI): its guidance record and route live in the bridge; the check's own scripts do not exercise it
    // a1 (L1): browserSteps (flag EGDESK_BROWSER_STEPS_UI, read in egdesk-browser-steps-channel.mjs) only sends step lines to the screen; nothing in a turn changes
    runtimeKeys: ['localCapacity', 'engines', 'resolveProjectWorkspace', 'resolveRunProjectOrigin', 'expectedProcessConfiguration', 'qaReady', 'getNativeContractFingerprint', 'profiles', 'mcpServerKind', 'computerControlStore', 'onComputerControlChange', 'hostLease'],
    flags: ['EGDESK_BROWSER_ENTRY', 'EGDESK_BROWSER_OPEN_ITEMS', 'EGDESK_BRIEFING_ORDER', 'EGDESK_BRIEFING_FILL_CHECK', 'EGDESK_BRIEFING_COVERAGE', // the briefing flow and its output schema are reproduced by the hook (hookFlags)
           'EGDESK_HUD_ROUTING', 'EGDESK_TERMINAL_JUDGE', 'EGDESK_TERMINAL_OPEN_URL', // c34: the terminal's opener and the sign-in-card rule need a window and a Terminal card (not part of this check's composition)
            'EGDESK_CONTEXT_ROOTS', 'EGDESK_FIREFOX_PROFILE', 'EGDESK_CLAUDE_READER', 'EGDESK_CLAUDE_DELETE_SESSION', 'EGDESK_CHAT_CHOICE', 'EGDESK_BROWSER_STEPS_UI',
           'EGDESK_DECISION_PROVIDER', 'EGDESK_GEMINI_DECISION_KEY_FILE'], // L41: which decision provider and its key file; the check runs the OpenAI client
  },
})

// ---- persisted threads (c24, --persisted-with-cleanup) ----
// A product-like fork needs a PERSISTED source thread (Main's smoke-5: thread/fork of an ephemeral source fails with "no rollout found"). Such a thread lands in the
// Codex home's history, so the mode is only allowed when its removal can be guaranteed: the binary's generated schema has thread/delete (checked before anything
// starts), every thread the check creates is written to <out>/created-threads.jsonl the moment the engine answers, each persisted one is deleted with thread/delete
// and verified gone (thread/resume must fail with "no rollout found") at the end of its conversation, also after an abort, and a ledger that still lists a thread
// that is not verified gone (a killed run) refuses the next start until --cleanup-leftovers has removed it.
export const LEDGER_FILE = 'created-threads.jsonl'
export const THREAD_GONE = /no rollout found|not found|does not exist|unknown thread/i
export function createLedger(out, { now = Date.now } = {}) {
  const file = path.join(out, LEDGER_FILE)
  return {
    file,
    append(entry) { makeDirs(out); fs.appendFileSync(file, `${JSON.stringify({ at: now(), ...entry })}\n`, { mode: 0o600 }) },
    read() { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean) } catch { return [] } },
  }
}
/** Persisted threads the ledger shows as created and not verified gone. */
export function leftoverThreads(entries) {
  const created = new Map(), gone = new Set()
  for (const e of entries) { if (e.op === 'created' && e.ephemeral !== true && typeof e.id === 'string') created.set(e.id, e); else if (e.op === 'gone') gone.add(e.id) }
  return [...created.keys()].filter(id => !gone.has(id))
}
/** c30: the internal turn's trace as the record keeps it: per attempt, closed words and numbers only (at most 3 attempts, 30 events each). */
export function closedTrace(trace) {
  if (!Array.isArray(trace)) return null
  const word = v => (typeof v === 'string' ? v.slice(0, 40) : null)
  return trace.slice(0, 3).map(t => ({ via: word(t?.via), startMs: Number.isFinite(t?.startMs) ? t.startMs : null, firstEventMs: Number.isFinite(t?.firstEventMs) ? t.firstEventMs : null, completed: word(t?.completed),
    events: (Array.isArray(t?.events) ? t.events : []).slice(0, 30).map(e => [Number.isFinite(e?.[0]) ? e[0] : null, word(e?.[1]), word(e?.[2]), word(e?.[3])]), requests: (Array.isArray(t?.requests) ? t.requests : []).slice(0, 10).map(word) }))
}

/** c34: the last allowance reading of a turn as the record keeps it: percent used, window length (minutes) and reset time (epoch ms) per window, and the reached word; numbers and one word only. */
export function closedRateLimits(limits) {
  const win = w => (w && Number.isFinite(w.usedPercent) ? { usedPercent: Math.round(w.usedPercent * 100) / 100, windowMinutes: Number.isInteger(w.windowMinutes) ? w.windowMinutes : null, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null } : null)
  if (!limits || typeof limits !== 'object') return null
  return { primary: win(limits.primary), secondary: win(limits.secondary), reached: typeof limits.reachedType === 'string' ? limits.reachedType.slice(0, 40) : null }
}

/** deleteAndVerify(request, ids, ledger) → { persisted, deleted, verifiedGone, failures: [{ id, step, error }] }. Never throws; no retries. */
export async function deleteAndVerify(request, ids, ledger) {
  const out = { persisted: ids.length, deleted: 0, alreadyGone: 0, verifiedGone: 0, failures: [] }
  for (const id of ids) {
    let deleteError = null
    try { await request('thread/delete', { threadId: id }); out.deleted++; ledger?.append({ op: 'deleted', id }) }
    catch (error) { deleteError = { id, step: 'delete', error: clip(error?.message ?? error?.code ?? 'error', 200) } }
    try {
      await request('thread/resume', { threadId: id }) // a thread that is gone cannot be resumed
      out.failures.push({ id, step: 'verify', error: 'still_resumable' })
      try { await request('thread/unsubscribe', { threadId: id }) } catch { /* best effort */ }
    } catch (error) {
      if (THREAD_GONE.test(String(error?.message ?? ''))) { out.verifiedGone++; ledger?.append({ op: 'gone', id }); if (deleteError) { out.alreadyGone++; deleteError = null } } // already gone is clean
      else out.failures.push({ id, step: 'verify', error: clip(error?.message ?? error?.code ?? 'error', 200) })
    }
    if (deleteError) out.failures.push(deleteError)
  }
  return out
}

/** A calibration row of the conversation flow, copied as it is: its closed words, numbers and booleans only (short strings, flat arrays of those); no nested object, no long text. */
export function closedRow(row) {
  const out = {}, scalar = v => (typeof v === 'string' && v.length <= 60) || typeof v === 'boolean' || Number.isFinite(v)
  for (const [key, value] of Object.entries(row ?? {}).slice(0, 40)) {
    if (scalar(value)) out[key] = typeof value === 'number' ? Math.round(value * 100) / 100 : value
    else if (Array.isArray(value) && value.length <= 20 && value.every(scalar)) out[key] = value
  }
  return out
}

const usage = message => Object.assign(new Error(message), { code: 'usage' })
const isExecutable = file => { try { fs.accessSync(file, constants.X_OK); return fs.statSync(file).isFile() } catch { return false } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ms = start => Math.round(performance.now() - start)
const clip = (value, max = 2000) => { const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''; return text.length > max ? `${text.slice(0, max)}…` : text }

export const HELP = `Usage: node scripts/egdesk-real-engine-check.mjs --codex-bin <path> (--codex-home <dir> | --person-home) --script <file> [--script <file> …] --out <dir> [--dry | --run] [options]
  --dry            (default) print what would run; starts nothing
  --run            run it: one Codex app-server per conversation, ephemeral threads, own tools on, records under --out
  --codex-bin      the Codex binary (an existing executable); nothing else is searched
  --codex-home     a Codex home folder, set as CODEX_HOME for the app-server
  --person-home    leave CODEX_HOME unset: the app-server uses the person's own Codex home and login (the check never reads that folder)
  --script         a conversation script (set real-engine-<name>-v<N>); repeatable
  --out            where scratch folders, the isolated data folder and records go (owner-only; never inside a .codex folder)
  --engine <codex|claude>    (c37) the engine; default codex. claude: EG-Desk's own Claude adapter drives the installed claude CLI exactly as the product does (the CLI keeps its login; EG-Desk never reads it); no --codex-bin / home. A conversation that needs something Claude does not have (steer, thread delete, restart, fork, ...) is recorded as "not applicable", never failed
  --claude-bin <path>        (claude) the CLI (else EGDESK_CLAUDE_BIN, PATH, ~/.local/bin/claude: the product's own resolution)
  --max-conversations <n>    stop after n conversations that ran (claude: default ${CLAUDE_DEFAULT_MAX_CONVERSATIONS}); a conversation that is not applicable does not count
  --usage-stop <percent>     (claude) stop the run, before each conversation and each turn, when any rate-limit window the CLI reported is at or above this (default ${CLAUDE_USAGE_STOP_PERCENT}) or reports a warning or a rejection
  --usage-state <file>       (claude) remember the last observed windows between runs (numbers and window names only) so the next run can refuse to start
  --allow-subscription-smoke (claude) NOT FOR BATCHES: let the check start on a claude.ai SUBSCRIPTION login. Without it the check starts only on an API-key login (claude auth login --console, or the key the CLI itself is configured with: EG-Desk never reads or passes a key) and refuses a subscription: Anthropic's terms expect API-key authentication for products and automation
  --require-usage-signal     (claude) stop after the first conversation when the CLI has reported no usage window at all (it reports on a state change only)
  --decisions      use the Decision model (key from ${DECISION_KEY_ENV}); without it no Decision call is made and "yes" approvals cannot be read
  --model <id>, --effort <low|medium|high|…>   per-turn model and effort (otherwise the home's configuration applies)
  --app-server-config k=v    an extra -c k=v for the app-server (repeatable)
  --stall-watchdog <ms>      (c36) arm the engine's progress watchdog (flag ${ENGINE_STALL_FLAG}, ${ENGINE_STALL_LIMITS.minMs}-${ENGINE_STALL_LIMITS.maxMs}) in EVERY conversation unless its script sets that flag itself: a turn that the engine accepted and then left silent (nothing beyond the preamble) is interrupted and started once more; each record says armed value, stalls, rescued, failed, interrupts, retries; the run prints "stalls: n, rescued: n, failed: n"
  --turn-timeout-ms <n>      per scripted turn (default ${DEFAULT_TURN_TIMEOUT_MS}); on timeout the turn is interrupted once and the conversation ends
  --persisted-with-cleanup   persisted source threads (so product-like forks work); every thread the check creates is deleted with thread/delete and verified gone at the end of its
                   conversation; refuses to start when the binary has no thread/delete or an earlier run left threads (see --cleanup-leftovers); default: ephemeral threads only
  --cleanup-leftovers        delete and verify gone the threads an earlier killed run left in <out>/created-threads.jsonl (needs --codex-bin, a home, --out; no script)
  --json           print the plan or the summary as JSON`

/** c36: the run-wide watchdog (--stall-watchdog) for a conversation: the flag, unless the script sets it itself (an explicit script value, even an invalid one, wins). */
export const stallFlag = (options, conversation) => (Number.isFinite(options?.stallWatchdogMs) && conversation?.flags?.[ENGINE_STALL_FLAG] === undefined ? { [ENGINE_STALL_FLAG]: String(options.stallWatchdogMs) } : {})

/** parseArgs(argv, env) → options. Throws { code: 'usage' }. */
export function parseArgs(argv, env = process.env) {
  const o = { mode: 'dry', codexBin: null, home: null, scripts: [], out: null, decisions: false, model: null, effort: null, appServerConfig: [], persisted: false, stallWatchdogMs: null, engine: 'codex', claudeBin: null, maxConversations: null, usageStopPercent: CLAUDE_USAGE_STOP_PERCENT, usageState: null, requireUsageSignal: false, allowSubscriptionSmoke: false, cleanupLeftovers: false, turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS, json: false, help: false }
  const takes = new Set(['--codex-bin', '--codex-home', '--script', '--out', '--model', '--effort', '--app-server-config', '--turn-timeout-ms', '--stall-watchdog', '--engine', '--claude-bin', '--max-conversations', '--usage-stop', '--usage-state'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { o.help = true; continue }
    if (arg === '--dry') { o.mode = 'dry'; continue }
    if (arg === '--run') { o.mode = 'run'; continue }
    if (arg === '--decisions') { o.decisions = true; continue }
    if (arg === '--json') { o.json = true; continue }
    if (arg === '--persisted-with-cleanup') { o.persisted = true; continue }
    if (arg === '--cleanup-leftovers') { o.cleanupLeftovers = true; continue }
    if (arg === '--require-usage-signal') { o.requireUsageSignal = true; continue }
    if (arg === '--allow-subscription-smoke') { o.allowSubscriptionSmoke = true; continue }
    if (arg === '--person-home') { if (o.home) throw usage('give --codex-home or --person-home, not both'); o.home = { kind: 'person', dir: null }; continue }
    if (!takes.has(arg)) throw usage(`unknown argument ${arg}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw usage(`${arg} needs a value`)
    if (arg === '--codex-bin') o.codexBin = value
    else if (arg === '--codex-home') { if (o.home) throw usage('give --codex-home or --person-home, not both'); o.home = { kind: 'dir', dir: value } }
    else if (arg === '--script') o.scripts.push(value)
    else if (arg === '--out') o.out = value
    else if (arg === '--model') o.model = value
    else if (arg === '--effort') o.effort = value
    else if (arg === '--app-server-config') { if (!/^[A-Za-z0-9_.]+=.+$/.test(value)) throw usage('--app-server-config needs key=value'); o.appServerConfig.push(value) }
    else if (arg === '--engine') { if (!['codex', 'claude'].includes(value)) throw usage('--engine is codex or claude'); o.engine = value }
    else if (arg === '--claude-bin') o.claudeBin = value
    else if (arg === '--max-conversations') { const n = /^\d{1,3}$/.test(value) ? Number(value) : NaN; if (!(n >= 1)) throw usage('--max-conversations is a whole number, 1 or more'); o.maxConversations = n }
    else if (arg === '--usage-stop') { const n = /^\d{1,3}$/.test(value) ? Number(value) : NaN; if (!(n >= 1 && n <= 100)) throw usage('--usage-stop is 1-100 (percent)'); o.usageStopPercent = n }
    else if (arg === '--usage-state') o.usageState = value
    else if (arg === '--stall-watchdog') { const n = /^\d{4,6}$/.test(value) ? Number(value) : NaN; if (!(n >= ENGINE_STALL_LIMITS.minMs && n <= ENGINE_STALL_LIMITS.maxMs)) throw usage(`--stall-watchdog is ${ENGINE_STALL_LIMITS.minMs}-${ENGINE_STALL_LIMITS.maxMs} (milliseconds)`); o.stallWatchdogMs = n }
    else if (arg === '--turn-timeout-ms') { const n = Number(value); if (!Number.isInteger(n) || n < 1000 || n > 3_600_000) throw usage('--turn-timeout-ms is 1000-3600000'); o.turnTimeoutMs = n }
  }
  if (o.help) return o
  if (o.engine === 'claude') { // c37: the Claude engine is EG-Desk's own adapter driving the installed CLI: no Codex binary or home
    if (o.codexBin || o.home) throw usage('--codex-bin, --codex-home and --person-home are for the Codex engine: not with --engine claude')
    if (o.claudeBin && !path.isAbsolute(o.claudeBin)) throw usage('--claude-bin must be an absolute path')
    if (o.usageState && !path.isAbsolute(o.usageState)) throw usage('--usage-state must be an absolute path')
    if (o.maxConversations === null) o.maxConversations = CLAUDE_DEFAULT_MAX_CONVERSATIONS
    const bad = validateClaudeOptions(o); if (bad.length) throw usage(bad.join('; '))
  } else {
    if (o.claudeBin || o.usageState || o.requireUsageSignal || o.allowSubscriptionSmoke) throw usage('--claude-bin, --usage-state, --require-usage-signal and --allow-subscription-smoke are for --engine claude')
    if (!o.codexBin) throw usage('--codex-bin is required (no binary is searched for)')
    if (!path.isAbsolute(o.codexBin)) throw usage('--codex-bin must be an absolute path')
    if (!o.home) throw usage('give --codex-home <dir> or --person-home')
    if (o.home.kind === 'dir' && !path.isAbsolute(o.home.dir)) throw usage('--codex-home must be an absolute path')
  }
  if (!o.scripts.length && !o.cleanupLeftovers) throw usage('at least one --script is required')
  if (!o.out) throw usage('--out is required')
  if (!path.isAbsolute(o.out)) o.out = path.resolve(o.out)
  if (o.out.split(path.sep).includes('.codex')) throw usage('--out must not be inside a .codex folder')
  void env
  return o
}

/** The app-server's argv, from the product's own launch builder (model, effort and the memories switch exactly as the bridge builds them). */
export function appServerArgs(options, buildLaunch = buildCodexAppServerLaunch) {
  const env = { ...(options.model ? { EGDESK_CODEX_MODEL: options.model } : {}), ...(options.effort ? { EGDESK_CODEX_EFFORT: options.effort } : {}), EGDESK_CODEX_DISABLE_MEMORIES: '1' }
  // the launch builder wants a listen URL; the stdio transport is the default, so that pair is dropped
  const launch = buildLaunch({ env, listen: 'stdio://' })
  const args = launch.args.filter((arg, i, all) => arg !== '--listen' && all[i - 1] !== '--listen')
  for (const kv of options.appServerConfig) args.push('-c', kv)
  return args
}

export function childEnv(options, base = process.env) {
  const env = {}
  for (const name of CHILD_ENV_ALLOW) if (typeof base[name] === 'string') env[name] = base[name]
  if (options.home.kind === 'dir') env.CODEX_HOME = options.home.dir
  return env
}

/** loadScripts(files) → [{ file, script }] or throws { code: 'usage' } with every validation error. */
export function loadScripts(files, read = file => fs.readFileSync(file, 'utf8')) {
  const out = [], problems = []
  for (const file of files) {
    let script
    try { script = JSON.parse(read(file)) } catch (error) { problems.push(`${file}: ${error.code === 'ENOENT' ? 'not found' : 'not valid JSON'}`); continue }
    const verdict = validateEngineScript(script)
    if (!verdict.ok) problems.push(...verdict.errors.map(e => `${file}: ${e}`))
    else out.push({ file, script })
  }
  if (problems.length) throw Object.assign(usage(`script problems:\n  ${problems.join('\n  ')}`), { problems })
  return out
}

/** The problems that stop a --run (a dry run reports them as warnings). */
export function preflight(options, scripts, { env = process.env, exists = isExecutable } = {}) {
  const problems = []
  const claude = options.engine === 'claude'
  if (claude) { if (options.claudeBin && !exists(options.claudeBin)) problems.push(`the Claude binary is not an existing executable: ${options.claudeBin}`) } // c37: otherwise the product's own resolution at run time
  else {
    if (!exists(options.codexBin)) problems.push(`the Codex binary is not an existing executable: ${options.codexBin}`)
    if (options.home.kind === 'dir' && !fs.existsSync(options.home.dir)) problems.push(`the Codex home does not exist: ${options.home.dir}`)
  }
  if (options.decisions && !(typeof env[DECISION_KEY_ENV] === 'string' && env[DECISION_KEY_ENV].trim())) problems.push(`--decisions needs the key in ${DECISION_KEY_ENV}`)
  if (!options.decisions) {
    const needs = scripts.flatMap(({ script }) => script.conversations.filter(c => c.turns.some(t => (t.approve ?? []).includes('yes'))).map(c => `${script.set}/${c.id}`))
    if (needs.length) problems.push(`scripted "yes" approvals are read by the Decision model, so they need --decisions: ${needs.join(', ')}`)
    const seeded = scripts.flatMap(({ script }) => script.conversations.filter(memoryNeedsDecisions).map(c => `${script.set}/${c.id}`)) // memory hook
    if (seeded.length) problems.push(`seeded memory pages are picked and read by the Decision model, so they need --decisions: ${seeded.join(', ')}`)
    const flagged = scripts.flatMap(({ script }) => script.conversations.filter(c => c.draftCheck || Object.keys(c.flags ?? {}).some(k => DECISION_DEPENDENT_FLAGS.includes(k))).map(c => `${script.set}/${c.id} (${[...(c.draftCheck ? ['draftCheck'] : []), ...Object.keys(c.flags ?? {}).filter(k => DECISION_DEPENDENT_FLAGS.includes(k))].join(', ')})`))
    const agentRooms = claude ? [] : scripts.flatMap(({ script }) => script.conversations.filter(c => c.agentProfile).map(c => `${script.set}/${c.id}`))
    if (agentRooms.length && !options.persisted) problems.push(`an agentProfile conversation is a direct room, which is not one-time: it needs --persisted-with-cleanup: ${agentRooms.join(', ')}`)
    const engineGone = claude ? [] : scripts.flatMap(({ script }) => script.conversations.filter(c => c.turns.some(t => t.expect?.deleted?.engineGone)).map(c => `${script.set}/${c.id}`)) // c28
    if (engineGone.length && !options.persisted) problems.push(`deleted.engineGone proves that the engine's saved thread is gone (thread/resume fails): the thread must be saved, so it needs --persisted-with-cleanup: ${engineGone.join(', ')}`)
    if (flagged.length) problems.push(`these flags act only through the Decision model, so they need --decisions: ${flagged.join('; ')}`)
  }
  const restarting = claude ? [] : scripts.flatMap(({ script }) => script.conversations.filter(c => c.turns.some(t => t.action === 'restart')).map(c => `${script.set}/${c.id}`)) // c29
  if (restarting.length && !options.persisted) problems.push(`a restart turn needs a saved engine thread to come back to, so it needs --persisted-with-cleanup: ${restarting.join(', ')}`)
  return problems
}

/** What a --run would do, as data (nothing is started). */
export function planRun(options, scripts, { env = process.env, buildLaunch = buildCodexAppServerLaunch, resolveClaude = resolveClaudeExecutable } = {}) {
  if (options.engine === 'claude') return planClaudeRun(options, scripts, { env, resolveClaude, defaultDecisionFlags: DEFAULT_DECISION_FLAGS, stallFlag, clip, decisionKeyEnv: DECISION_KEY_ENV })
  return {
    mode: options.mode, codexBin: options.codexBin,
    home: options.home.kind === 'person' ? { kind: 'person', note: 'CODEX_HOME unset: the person\'s own Codex home and login; the check never reads that folder' } : { kind: 'dir', dir: options.home.dir },
    threads: options.persisted ? { kind: 'persisted-with-cleanup', ledger: path.join(options.out, LEDGER_FILE), note: 'created in the Codex home, deleted with thread/delete and verified gone at the end of each conversation' } : { kind: 'ephemeral' },
    out: options.out, decisions: options.decisions, model: options.model, effort: options.effort, turnTimeoutMs: options.turnTimeoutMs,
    appServer: { argv: [options.codexBin, ...appServerArgs(options, buildLaunch)], env: Object.keys(childEnv(options, env)), perConversation: true, processGroupKill: `SIGTERM, ${KILL_GRACE_MS}ms grace, SIGKILL` },
    rules: [options.persisted ? 'persisted threads, each deleted and verified gone at the end of its conversation (the binary must have thread/delete; the ledger must be clean)' : 'ephemeral threads only (thread/start and thread/fork without ephemeral:true are refused)', 'own tools ON; the engine runs in EG-Desk\'s empty folder', 'scripted approver: yes/no answers sent as the person\'s next message',
      'no retries', `Decision calls only with --decisions (key from ${DECISION_KEY_ENV}), through the run's egress gate`],
    conversations: scripts.flatMap(({ file, script }) => script.conversations.map(c => ({ set: script.set, file, id: c.id, scratch: path.join(options.out, 'scratch', c.id), files: Object.keys(c.folder ?? {}).length,
      flags: { ...(options.decisions ? DEFAULT_DECISION_FLAGS : {}), ...stallFlag(options, c), ...(c.flags ?? {}), EGDESK_OWN_TOOLS: 'on' }, turns: c.turns.map(t => ({ say: t.action === 'restart' ? '(restart: the bridge and the engine stop and start again)' : clip(t.say, 80), approve: t.approve ?? [], expects: Object.keys(t.expect ?? {}) })) }))),
  }
}

export function formatPlan(plan, warnings = []) {
  if (plan.engine === 'claude') return formatClaudePlan(plan, warnings, { decisionKeyEnv: DECISION_KEY_ENV })
  const lines = [`real-engine check (${plan.mode === 'dry' ? 'DRY: nothing is started' : 'RUN'})`, `  binary: ${plan.codexBin}`, `  home: ${plan.home.kind === 'person' ? plan.home.note : plan.home.dir}`, `  out: ${plan.out}`,
    `  threads: ${plan.threads.kind === 'ephemeral' ? 'ephemeral only' : `PERSISTED, then deleted and verified gone (${plan.threads.note}; ledger ${plan.threads.ledger})`}`, `  decisions: ${plan.decisions ? `on (key from ${DECISION_KEY_ENV})` : 'off'}`, `  app-server: ${plan.appServer.argv.join(' ')}   (env: ${plan.appServer.env.join(', ')}${plan.home.kind === 'dir' ? ', CODEX_HOME' : ''})`]
  for (const c of plan.conversations) {
    lines.push(`  conversation ${c.set}/${c.id}: scratch ${c.scratch}, ${c.files} files, flags ${Object.entries(c.flags).map(([k, v]) => `${k}=${v}`).join(' ')}`)
    c.turns.forEach((t, i) => lines.push(`    turn ${i + 1}: "${t.say}"${t.approve.length ? ` approve=${t.approve.join(',')}` : ''} expects ${t.expects.join(',') || '-'}`))
  }
  for (const rule of plan.rules) lines.push(`  rule: ${rule}`)
  for (const w of warnings) lines.push(`  WARNING: ${w}`)
  return lines.join('\n')
}

function makeDirs(base, mode = 0o700) { fs.mkdirSync(base, { recursive: true, mode }); fs.chmodSync(base, mode) }

function writeScratch(scratch, folder = {}) {
  makeDirs(scratch)
  for (const [relative, content] of Object.entries(folder)) {
    if (folderPathProblem(relative)) throw usage(`unsafe folder path ${relative}`)
    const target = path.join(scratch, relative)
    if (!path.resolve(target).startsWith(`${path.resolve(scratch)}${path.sep}`)) throw usage(`folder path leaves the scratch folder: ${relative}`)
    makeDirs(path.dirname(target)); fs.writeFileSync(target, content, { mode: 0o600 })
  }
}

const readScratchFile = (scratch, relative) => {
  if (folderPathProblem(relative)) return null
  const target = path.join(scratch, relative)
  try { if (fs.lstatSync(target).isSymbolicLink()) return null; return fs.readFileSync(target, 'utf8') } catch { return null }
}

/** killGroup(child) → resolves when the child's process group is gone: SIGTERM, then SIGKILL after the grace. */
export function createGroupKiller({ kill = process.kill.bind(process), grace = KILL_GRACE_MS } = {}) {
  return async child => {
    if (!child || child.exitCode != null || child.signalCode != null) return { signal: null }
    const closed = new Promise(resolve => child.once('close', resolve))
    const send = signal => { try { kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} } }
    send('SIGTERM')
    const first = await Promise.race([closed.then(() => 'closed'), sleep(grace).then(() => 'late')])
    if (first === 'closed') return { signal: 'SIGTERM' }
    send('SIGKILL'); await Promise.race([closed, sleep(grace)])
    return { signal: 'SIGKILL' }
  }
}

/**
 * runConversation({ options, set, conversation, deps }) → the conversation record. One app-server, one runtime, one scratch folder, until a `restart` turn: that stops the app-server, the runtime and
 * every hook of the conversation (the bridge and the engine go) and starts them again over the SAME store, folder and persisted thread (c29). The conversation is run in segments, the turns before
 * and after each restart; the segments' records are one record (turn indexes are the script's own, the restart turn has its own record).
 * deps: { spawn, runnerSpawn, fetchImpl, env, killGroup, now }
 */
export async function runConversation({ options, set, conversation, deps = {} }) {
  const cuts = conversation.turns.flatMap((t, i) => (t.action === 'restart' ? [i] : []))
  if (!cuts.length) return runConversationSegment({ options, set, conversation, deps })
  const bounds = [-1, ...cuts, conversation.turns.length]
  let merged = null, previous = null
  for (let s = 0; s < bounds.length - 1; s++) {
    const last = s === bounds.length - 2, out = {}
    const carry = { resumed: s > 0, keep: !last, out, offset: bounds[s] + 1, ...(s > 0 ? { state: previous.state, hooksCarried: previous.hooks, restartTurn: conversation.turns[bounds[s]], restartIndex: bounds[s] } : {}) }
    const rec = await runConversationSegment({ options, set, conversation: { ...conversation, turns: conversation.turns.slice(bounds[s] + 1, bounds[s + 1]) }, deps, carry })
    if (!merged) merged = rec
    else {
      merged.turns.push(...rec.turns); merged.requests.push(...rec.requests); merged.aborted ??= rec.aborted; merged.abortDetail ??= rec.abortDetail
      merged.ok = merged.ok && rec.ok; merged.decisionCalls = (merged.decisionCalls ?? 0) + (rec.decisionCalls ?? 0); merged.totalMs = (merged.totalMs ?? 0) + (rec.totalMs ?? 0)
      if (rec.cleanup) merged.cleanup = rec.cleanup; if (rec.cleanupFailed) merged.cleanupFailed = true
      merged.stallWatchdog = mergeStallRecords(merged.stallWatchdog, rec.stallWatchdog)
      ;(merged.restarts ??= []).push({ afterTurn: bounds[s], engine: rec.engine, phases: { spawnMs: rec.phases.spawnMs, initializeMs: rec.phases.initializeMs, composedMs: rec.phases.composedMs } })
    }
    previous = out
    if (rec.aborted || !out.state) { merged.ok = false; break } // a segment that aborted ends the conversation (its persisted threads were cleaned up in its own cleanup)
  }
  merged.ok = merged.ok && merged.turns.length === conversation.turns.length
  return merged
}
async function runConversationSegment({ options, set, conversation, deps = {}, carry = null }) {
  const env = deps.env ?? process.env
  const spawn = deps.spawn ?? nodeSpawn
  const killGroup = deps.killGroup ?? createGroupKiller()
  const claudeMode = options.engine === 'claude' // c37: EG-Desk's own Claude adapter instead of the Codex app-server
  const claudeRef = { adapter: null }, claudeSessions = []
  const usageHolder = deps.claudeUsage ?? { row: null } // the run's last usage() row (the adapter lives one conversation, the guard spans the run)
  const conversationDir = path.join(options.out, 'data', conversation.id)
  const scratch = path.join(options.out, 'scratch', conversation.id), dataDir = conversationDir
  makeDirs(options.out); makeDirs(path.join(options.out, 'scratch')); makeDirs(path.join(options.out, 'data')); makeDirs(dataDir)
  if (!carry?.resumed) writeScratch(scratch, conversation.folder) // after a restart the folder is as the turns left it
  // the draft check is the conversation's own opt-in (conversation.draftCheck: { mode, design? }), like memory; explicit flags still win
  const dc = conversation.draftCheck
  const flags = upperBundleFlags({ ...(options.decisions ? DEFAULT_DECISION_FLAGS : {}), ...stallFlag(options, conversation), ...(dc ? { EGDESK_DRAFT_CHECK: dc.mode, ...(dc.design === 'choice' ? { EGDESK_DRAFT_CHECK_DESIGN: 'choice' } : {}) } : {}), ...(conversation.flags ?? {}), EGDESK_OWN_TOOLS: 'on' }).flags // u1: EGDESK_UPPER=on in a conversation's flags fills the bundle's flags the script did not set (the bridge does the same for the environment)
  let profileStore = null, agentRoom = null // c25: the synthetic Agent of an agentProfile conversation
  const persisted = options.persisted === true, ledger = persisted ? (deps.ledger ?? createLedger(options.out)) : null, createdThreads = [...(carry?.state?.createdThreads ?? [])]
  const FLAG = { ...flags }
  const hooks = CHECK_HOOKS.filter(h => h.active(FLAG)) // features registered in helper/egdesk-real-engine-hooks.mjs (the briefing flow, ...); attached once the runtime exists
  let attached = []
  const rec = { set, id: conversation.id, flags: FLAG, scratch, startedAt: new Date().toISOString(), phases: {}, requests: [], engine: null, isolation: null, mcpStartup: { starting: 0, ready: 0, failed: 0, other: 0 }, turns: [], aborted: null, ok: false }
  const t0 = performance.now()
  const runnerLog = []
  const runnerSpawn = deps.runnerSpawn ?? nodeSpawn
  const loggedRunnerSpawn = (file, args, opts) => { runnerLog.push(String(args?.at?.(-1) ?? '')); const child = runnerSpawn(file, args, opts); turnHooks.observeCommand(args?.at?.(-1), child); return child } // registered hooks: how the command process ends

  // ---- the app-server child ----
  const argv = claudeMode ? [] : appServerArgs(options, deps.buildLaunch ?? buildCodexAppServerLaunch)
  const child = claudeMode ? { stdin: { write() {} }, stdout: null, stderr: null, on() {}, once() {}, pid: null, exitCode: null, signalCode: null } : spawn(options.codexBin, argv, { cwd: dataDir, env: childEnv(options, env), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  rec.phases.spawnMs = ms(t0)
  let closed = false, stderrTail = ''
  child.on('close', () => { closed = true; try { rpc.close(Object.assign(new Error('the Codex app-server exited'), { code: 'engine_exited' })) } catch {} })
  child.on('error', error => { rec.aborted ??= `spawn_failed:${error?.code ?? 'error'}` })
  child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-1500) })
  let chat = null, store = null, wiring = null, threadClient = null
  const refreshUsage = () => { try { const row = claudeRef.adapter?.usage?.(); if (row) usageHolder.row = row } catch { /* the guard then knows less */ } }
  const turnHooks = createTurnHooks(conversation) // the registered per-turn hooks: memory (seeded pages, what the product sent), journey (turn/steer, turn/interrupt), ...
  const memoryHook = turnHooks.get('memory').hook // memory hook: the ontology graph and the turn-memory setting
  const completions = [], tasks = []
  let limitsNow = null // c34: the engine's latest allowance reading of this conversation
  const turnNow = { notifications: [], engineMessages: {}, pendingRequests: new Map(), toolCalls: new Map(), native: { commandExecution: 0, fileChange: 0, approvals: 0 }, items: {}, usage: null, compacted: false, errors: [], decisions: [], draftRows: [], flowRows: [], internal: [], writers: [], turnStartAt: null, firstEventAt: null, firstProgressAt: null, t0: null, timing: { sendMs: null, engineStartMs: null, events: [], items: [], tools: [] } }
  // c31 (U13 timing): offsets in ms from the start of the scripted turn (turnNow.t0): when the engine's turn was asked for (the memory and action layers come before it), the visible runtime events, the engine's items,
  // EG-Desk's own tool calls, the Decision calls' starts (decisions[].atMs). firstEventMs (c32, L5) stays the one record of how long the engine took to start answering.
  const VISIBLE_EVENTS = new Set(['run.started', 'message.started', 'message.completed', 'activity.updated', 'activity.completed', 'approval.required', 'run.completed', 'run.unavailable'])
  const offsetNow = () => (turnNow.t0 === null ? null : Math.round(performance.now() - turnNow.t0))
  const resetTurnNow = () => { turnNow.notifications.length = 0; turnNow.engineMessages = {}; turnNow.pendingRequests = new Map(); turnNow.toolCalls = new Map(); turnNow.native = { commandExecution: 0, fileChange: 0, approvals: 0 }; turnNow.items = {}; turnNow.usage = null; turnNow.compacted = false; turnNow.errors = []; turnNow.decisions = []; turnNow.draftRows = []; turnNow.flowRows = []; turnNow.internal = []; turnNow.writers = []; turnNow.turnStartAt = null; turnNow.firstEventAt = null; turnNow.firstProgressAt = null; turnNow.rateLimits = null; turnNow.rateLimitReports = 0; turnNow.t0 = null; turnNow.timing = { sendMs: null, engineStartMs: null, events: [], items: [], tools: [] } }
  let initializeResult = null, lastThreadStart = null
  const onEngineNotification = message => {
      const p = message.params ?? {}
      if (turnNow.firstEventAt === null && turnNow.turnStartAt !== null && p.threadId && (p.turnId || p.turn?.id)) turnNow.firstEventAt = performance.now() // c33: the first event of the turn
      if (turnNow.firstProgressAt == null && turnNow.turnStartAt !== null && isProgressEvent(message)) turnNow.firstProgressAt = performance.now() // c34: the first event beyond the preamble (what the watchdog waits for)
      // c34 (the weekly Codex limit reached 100% on 11-25 and no record said how fast it filled): the engine reports its allowance with every model call (account/rateLimits/updated); the closed numbers of the
      // last report of the turn go to the turn record (usedPercent per window, window minutes, reset time, the reached word), so a batch's use is read from the records, never guessed
      if (message.method === 'account/rateLimits/updated') { try { limitsNow = applyRateLimitsUpdate(limitsNow, message); turnNow.rateLimits = closedRateLimits(limitsNow); turnNow.rateLimitReports = (turnNow.rateLimitReports ?? 0) + 1 } catch { /* a reading never affects the turn */ } }
      // c31 (the two 180 s turns of check-24un/22mw: items {userMessage:1}, no completion): every engine message by method, content-free, so a silent turn names itself
      { const m = String(message.method ?? '?').slice(0, 60); if (Object.keys(turnNow.engineMessages).length < 40 || m in turnNow.engineMessages) turnNow.engineMessages[m] = (turnNow.engineMessages[m] ?? 0) + 1 }
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const type = p.item?.type
        try { // c31: when each engine item began and ended (a model round ends with its item)
          const at = offsetNow(), id = String(p.item?.id ?? '')
          if (at !== null && turnNow.timing.items.length < 200) {
            const row = turnNow.timing.items.find(x => x.id === id && x.endMs === null)
            if (message.method === 'item/started' || !row) turnNow.timing.items.push({ id, type: String(type ?? '').slice(0, 40), startMs: message.method === 'item/started' ? at : null, endMs: message.method === 'item/completed' ? at : null })
            else row.endMs = at
          }
        } catch { /* recording only */ }
        if (message.method === 'item/completed') {
          turnNow.items[type] = (turnNow.items[type] ?? 0) + 1
          if (type === 'commandExecution') turnNow.native.commandExecution++
          if (type === 'fileChange') turnNow.native.fileChange++
          if (type === 'contextCompaction') turnNow.compacted = true
        }
      } else if (message.method === 'thread/compacted') turnNow.compacted = true
      else if (message.method === 'thread/tokenUsage/updated') { const last = p.tokenUsage?.last; if (last) turnNow.usage = { input: last.inputTokens, cached: last.cachedInputTokens, output: last.outputTokens, reasoning: last.reasoningOutputTokens, total: last.totalTokens } }
      else if (message.method === 'mcpServer/startupStatus/updated') { const k = ['starting', 'ready', 'failed'].includes(p.status) ? p.status : 'other'; rec.mcpStartup[k]++ }
      else if (message.method === 'error') turnNow.errors.push(clip(p.error?.message ?? 'error', 300))
      else if (message.method === 'turn/completed') { completions.push({ threadId: p.threadId, turnId: p.turn?.id, status: p.turn?.status, error: p.turn?.error?.message ? clip(p.turn.error.message, 300) : null, at: performance.now() }) }
  }
  const onEngineRequest = message => {
      { const m = `request:${String(message.method ?? '?').slice(0, 60)}`; if (Object.keys(turnNow.engineMessages).length < 40 || m in turnNow.engineMessages) turnNow.engineMessages[m] = (turnNow.engineMessages[m] ?? 0) + 1; turnNow.pendingRequests.set(message.id, String(message.method ?? '?').slice(0, 60)) }
      if (message.method === 'item/tool/call') { turnNow.toolCalls.set(message.id, { tool: message.params?.tool, arguments: clip(message.params?.arguments, 1500), result: null }); try { if (turnNow.t0 !== null && turnNow.timing.tools.length < 100) turnNow.timing.tools.push({ id: message.id, tool: String(message.params?.tool ?? '').slice(0, 60), startMs: offsetNow(), endMs: null }) } catch { /* recording only */ } }
      else if (/requestApproval$|^applyPatchApproval$|^execCommandApproval$/.test(message.method)) turnNow.native.approvals++
  }
  // Claude: the same request names the check and its hooks use, answered by the adapter; the adapter's events reach the runtime through its own subscription (wrapClaudeAdapter)
  const claudeRpc = { request: (method, params) => claudeRequest(claudeRef.adapter)(method, params), respond: (id, result, error) => claudeRef.adapter.respond(id, result, error), initialize: async () => {}, close() {}, receive() {}, serverInfo: null }
  const rpc = claudeMode ? claudeRpc : new AppServerRpc({
    send: payload => child.stdin.write(`${payload}\n`), experimentalApi: true, timeoutMs: 60_000,
    onNotification: message => { onEngineNotification(message); if (chat) tasks.push(Promise.resolve(chat.handleNotification(message, 'codex')).catch(() => {})) },
    onRequest: message => { onEngineRequest(message); if (chat) tasks.push(Promise.resolve(chat.handleServerRequest(message, 'codex')).catch(error => turnNow.errors.push(`server_request_failed:${clip(error?.code ?? error?.message, 80)}`))) },
  })
  // stdout lines go to the RPC; the initialize answer is also read here, because the product's RPC keeps only the user agent
  let buffer = ''
  child.stdout?.on('data', chunk => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      try { const m = JSON.parse(line); if (m.id === 1 && m.result?.codexHome) initializeResult = m.result } catch {}
      rpc.receive(line)
    }
  })
  const stop = async () => { try { chat?.setConnection?.(false) } catch {} try { rpc.close() } catch {} rec.phases.killed = claudeMode ? (await Promise.resolve(claudeRef.adapter?.dispose?.('check finished')).catch(() => {}), null) : (await killGroup(child))?.signal ?? null }

  try {
    // ---- initialize, home and version ----
    const t1 = performance.now()
    let agent = null
    if (claudeMode) { // the product's own static check (claude --version, claude auth status --json): who is signed in and how, never a credential
      const claudeEnv = { PATH: env.PATH ?? '', HOME: env.HOME ?? '', ...(options.claudeBin ? { EGDESK_CLAUDE_BIN: options.claudeBin } : typeof env.EGDESK_CLAUDE_BIN === 'string' && env.EGDESK_CLAUDE_BIN.trim() ? { EGDESK_CLAUDE_BIN: env.EGDESK_CLAUDE_BIN } : {}) }
      const status = createClaudeEngineStatus({ probe: deps.claudeProbe ?? (() => probeClaudeEngine({ env: claudeEnv })), onChange: () => { try { claudeRef.adapter?.syncStatus() } catch { /* the gate follows */ } } })
      claudeRef.adapter = createClaudeEngineAdapter({ snapshot: () => status.snapshot(), refreshStatus: o => status.refresh(o), env: claudeEnv, defaultCwd: dataDir, ...(deps.claudeAdapterOptions ?? {}) })
      await status.refresh({ force: true })
      const snap = status.snapshot()
      rec.phases.initializeMs = ms(t1)
      rec.engine = { id: 'claude', installed: snap.installed === true, version: snap.version ?? null, versionStatus: snap.versionStatus ?? null, signedIn: snap.auth?.status === 'signedIn', authMethod: snap.auth?.method ?? null }
      if (snap.installed !== true) throw Object.assign(new Error('the Claude CLI was not found (--claude-bin, EGDESK_CLAUDE_BIN, PATH, ~/.local/bin/claude)'), { code: 'claude_not_installed' })
      if (snap.versionStatus === 'unsupported') throw Object.assign(new Error('this Claude CLI version is not supported by the adapter'), { code: 'claude_version_unsupported' })
      if (snap.auth?.status !== 'signedIn') throw Object.assign(new Error('the Claude CLI is not signed in: sign in inside EG-Desk (or the CLI) first; the check never logs in'), { code: 'claude_login_required' })
      // c37 (compliance): automated real checks run on an API-key (Console) login; a subscription login is refused unless the person's explicit --allow-subscription-smoke is given. Only the method is recorded, never the account.
      const method = snap.auth?.method ?? null
      rec.engine.authAllowed = method === 'apiKey' ? 'apiKey' : method === 'claudeai' && options.allowSubscriptionSmoke === true ? 'subscription-smoke' : null
      if (rec.engine.authAllowed === null) throw Object.assign(new Error(method === 'claudeai' ? 'the Claude CLI is signed in with a claude.ai SUBSCRIPTION: automated checks use an API-key login (claude auth login --console); --allow-subscription-smoke is only for a person who chose it' : `the Claude CLI login method (${method ?? 'unknown'}) is not an API-key login`), { code: method === 'claudeai' ? 'claude_subscription_refused' : 'claude_auth_method_refused' })
      claudeRef.adapter.syncStatus()
    } else {
    await rpc.initialize()
    rec.phases.initializeMs = ms(t1)
    agent = rpc.serverInfo?.userAgent ?? null
    rec.engine = { version: parseCodexUserAgent(agent)?.version ?? null, userAgent: agent ? agent.slice(0, 120) : null, homeMode: options.home.kind, homeMatchesFlag: null }
    if (options.home.kind === 'dir') {
      rec.engine.homeMatchesFlag = initializeResult?.codexHome === options.home.dir || (() => { try { return fs.realpathSync(initializeResult?.codexHome) === fs.realpathSync(options.home.dir) } catch { return false } })()
      if (!rec.engine.homeMatchesFlag) throw Object.assign(new Error('the app-server reports another Codex home than --codex-home'), { code: 'home_mismatch' })
    } else rec.engine.homeMatchesFlag = null
    }

    // ---- the runtime, composed the way codex-bridge-server.mjs composes it ----
    const request = async (method, params) => {
      if (!persisted && !claudeMode && (method === 'thread/start' || method === 'thread/fork') && params?.ephemeral !== true) throw Object.assign(new Error('every thread of this check must be ephemeral'), { code: 'ephemeral_required' })
      const start = performance.now()
      if (method === 'turn/start' && turnNow.t0 !== null && turnNow.timing.engineStartMs === null) turnNow.timing.engineStartMs = offsetNow() // c31: the engine is asked to start: what came before is the memory and action layers
      turnHooks.observe(method, params) // registered hooks
      try {
        const result = await rpc.request(method, params)
        // contextKeys (c27): the NAMES of the additionalContext blocks a turn/start carried (never their text): whether EG-Desk's own blocks (egdesk_stopped_command, ...) rode along
        if (method === 'turn/start') turnNow.turnStartAt = performance.now()
        rec.requests.push({ method, ms: ms(start), ...(method === 'turn/start' && params?.additionalContext && typeof params.additionalContext === 'object' ? { contextKeys: Object.keys(params.additionalContext).filter(k => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)).slice(0, 16) } : {}) })
        if (method === 'thread/start') { lastThreadStart = result; if (claudeMode) { if (typeof result?.thread?.id === 'string' && claudeSessions.length < 50) claudeSessions.push(result.thread.id) } else if (!persisted && result?.thread?.ephemeral !== true) { rec.aborted ??= 'thread_not_ephemeral' } }
        // persisted mode: every thread the engine reports is in the ledger before anything else happens with it (a crash leaves the record of what to delete)
        if (persisted && (method === 'thread/start' || method === 'thread/fork') && typeof result?.thread?.id === 'string') {
          const row = { id: result.thread.id, ephemeral: result.thread.ephemeral === true }; createdThreads.push(row); ledger.append({ op: 'created', via: method, ...row })
        }
        return result
      } catch (error) { rec.requests.push({ method, ms: ms(start), error: String(error?.code ?? 'error').slice(0, 40), message: clip(error?.message ?? '', 300) }); throw error }
    }
    const respond = (id, result, error) => {
      turnNow.pendingRequests.delete(id)
      try { const t = turnNow.timing.tools.find(x => x.id === id); if (t && t.endMs === null) t.endMs = offsetNow() } catch { /* recording only */ }
      const call = turnNow.toolCalls.get(id)
      if (call) { try { call.result = { success: result?.success ?? null, error: error ? clip(error.message ?? error, 300) : null, text: clip(result?.contentItems?.[0]?.text ?? '', 1500) } } catch {} }
      rpc.respond(id, result, error)
    }
    store = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: `real-engine-check:${conversation.id}` })
    // c25: an Agent-profile DIRECT room. The Agent is synthetic and lives in this conversation's isolated profile store (no person data, nothing shared with the installed
    // EG-Desk); every send names it with replyDestination 'direct', which is what makes the room the one the product's draft check judges (channelKind 'direct', not one-time).
    if (conversation.agentProfile) {
      const spec = conversation.agentProfile
      profileStore = openProfileStore({ dataDir: path.join(dataDir, 'profiles'), ownerHash: 'real-engine-check' })
      const created = profileStore.createDraft({ name: spec.name, avatar: { kind: 'initial', value: spec.name.trim().slice(0, 1) }, role: spec.role ?? '', personality: { tone: spec.tone ?? 'plain' }, expertise: spec.expertise ?? [], instructions: spec.instructions })
      profileStore.activate(created.id, 1, null)
      agentRoom = { id: created.id }; rec.agentProfile = { revision: 1, tone: spec.tone ?? 'plain' }
    }
    const settingsDir = path.join(dataDir, 'settings')
    const settings = openBridgeSettings({ dataDir: settingsDir, log() {} })
    const calibrationBase = openCalibrationLog({ dataDir: settingsDir, log() {} })
    // the draft check records one calibration row per check (closed words): the check keeps a copy per turn so a script can say whether it ran
    // (the log object is frozen: an inheriting wrapper, not a Proxy, so that only record is replaced)
    const calibrationLog = Object.create(calibrationBase, { record: { value: row => { try { if (row?.feature === 'draft_check') turnNow.draftRows.push({ mode: row.mode ?? null, attached: row.attached === true, fallback: typeof row.fallback === 'string' ? row.fallback : null, check: typeof row.check === 'string' ? row.check : null, ifUnrevised: typeof row.ifUnrevised === 'string' ? row.ifUnrevised : null, judgments: (Array.isArray(row.judgments) ? row.judgments : []).slice(0, 40).map(j => ({ q: String(j?.q ?? '').slice(0, 40), would: typeof j?.would === 'string' ? j.would : null, p: Number.isFinite(j?.p) ? Math.round(j.p * 100) / 100 : null })), ...(row.evidence ? { evidence: { items: row.evidence.items ?? null, opaque: row.evidence.opaque ?? null, sentences: row.evidence.sentences ?? null, terms: row.evidence.terms ?? null } } : {}) }) } catch { /* recording only */ } try { if (row?.feature === 'conversation_flow') turnNow.flowRows.push(closedRow(row)) } catch { /* recording only */ } return calibrationBase.record(row) }, enumerable: true } })
    const KEY = options.decisions ? String(env[DECISION_KEY_ENV] ?? '').trim() : null
    const decisionCall = []
    const transport = options.decisions && !deps.fetchImpl ? createDecisionTransport() : null
    const fetchImpl = async (url, init) => {
      const started = performance.now(); let questions = []
      try { questions = JSON.parse(String(init?.body ?? '{}')).questions ?? [] } catch {}
      const response = await (deps.fetchImpl ?? transport.fetch)(url, init)
      const row = { names: questions.map(q => q.name), atMs: turnNow.t0 === null ? null : Math.round(started - turnNow.t0), ms: ms(started), status: response?.status ?? null, inputTokens: null, p: {} }
      try { const body = JSON.parse(await response.clone().text()); row.inputTokens = Number.isFinite(body?.usage?.input_tokens) ? body.usage.input_tokens : null; for (const a of body.answers ?? []) row.p[a.name ?? a.id ?? '?'] = a.type === 'predicate' ? Math.round(a.probability * 100) / 100 : a.type === 'choice' ? (a.choice ?? a.picked ?? '?') : a.type } catch {}
      turnNow.decisions.push(row); decisionCall.push(row)
      return response
    }
    // idle warm-up, as the bridge wires it (flag EGDESK_DECISION_WARMUP, default off: nothing below exists)
    const warmupConfig = warmupConfigFromEnv(FLAG)
    const activity = options.decisions && warmupConfig.mode !== 'off' ? createDecisionActivity({ idleMs: warmupConfig.idleMs }) : null
    const client = options.decisions ? createDecisionClient({ getApiKey: async () => KEY, fetchImpl: activity ? activity.wrap(fetchImpl) : fetchImpl, recipientForKey: (v, endpoint, model) => decisionTopicRecipient(v, 1, endpoint, model), budget: createDecisionBudget({ monthlyInputTokenCap: 5_000_000 }) }) : null
    const warmup = client && activity ? createDecisionWarmup({ client, activity, mode: () => warmupConfig.mode, decisionsMode: () => 'on', hasKey: () => Boolean(KEY), idleMs: warmupConfig.idleMs, joinMs: warmupConfig.joinMs }) : null
    const OWNER = `codex:real-engine-check`
    const contexts = new ContextRuntime({ store: new ImmutableContextStore({ dataDir: path.join(dataDir, 'context'), allowedRoots: [scratch] }), getOwnerKey: () => OWNER })
    let wikiAdapter = null
    const wikiWrites = openWikiWrites({ dataDir: settingsDir, log() {} }) // c28: eager, so a script's seeded memory and the deletion proof read the same store the adapter writes
    const ontologyStore = { readGraph: async () => memoryHook.graph() } // memory hook: empty unless the script seeds pages
    const turnMemoryConfig = createTurnMemoryConfig({ settings, ontologyStore, ...turnMemoryFlagsFromEnv(FLAG), getAdapter: () => wikiAdapter ??= createWikiAdapter({ writes: wikiWrites }) })
    if (options.decisions) await settings.turnMemory.save(memoryHook.mode ?? 'advisory') // memory hook
    if (memoryHook.mode === 'on') turnMemoryConfig.eligible = memoryHook.eligible // memory hook: turn memory also on this conversation's one-time thread
    // EG-Desk's own model and effort (EGDESK_CODEX_MODEL / EGDESK_CODEX_EFFORT, as the bridge reads them) reach the wiring from the shell the check runs in:
    // that is how the check exercises the path where no request names a model (--model / --effort still win, as a request does)
    wiring = createOwnToolsWiring({ env: { ...FLAG, PATH: env.PATH ?? '', HOME: env.HOME ?? '', ...Object.fromEntries(['EGDESK_CODEX_MODEL', 'EGDESK_CODEX_EFFORT'].filter(k => typeof env[k] === 'string').map(k => [k, env[k]])) }, dataDir, spawn: loggedRunnerSpawn, getChat: () => chat, inspect: createGitTargetInspector(), ...(deps.gitStatus ? { gitStatus: deps.gitStatus } : {}), ...(deps.killGroupRunner ? { killGroup: deps.killGroupRunner } : {}) })
    const terminalGateConfig = ['advisory', 'on'].includes(FLAG.EGDESK_TERMINAL_GATE) ? { mode: () => FLAG.EGDESK_TERMINAL_GATE, inspect: createGitTargetInspector(), method: FLAG.EGDESK_TERMINAL_GATE_METHOD === 'score' ? 'score' : 'predicates' } : null
    const recipient = () => (KEY ? decisionTopicRecipient(KEY, 1, undefined, client.model) : null)
    let warmed = false
    const decisionContext = {
      settingsGeneration: () => 0, mode: () => (options.decisions ? 'on' : 'off'), configured: () => options.decisions, client,
      budgetMs: TURN_CONTEXT_BUDGET_MS, coldBudgetMs: TURN_CONTEXT_COLD_BUDGET_MS, warm: () => warmed || (warmed = decisionCall.some(r => r.status === 200)),
      ...(['action', 'action+status'].includes(FLAG.EGDESK_CONTEXT_RELEVANCE) ? { relevanceRules: FLAG.EGDESK_CONTEXT_RELEVANCE } : {}),
      ...(warmup ? { warmup } : {}),
      ...(FLAG.EGDESK_INRUN_MESSAGES === 'on' ? { inRunMessages: { mode: () => 'on' } } : {}),
      ...(FLAG.EGDESK_OPEN_ITEMS === 'on' ? { openItems: true } : {}), // c32
      ...(FLAG.EGDESK_PROPOSAL_REGISTRY === 'on' ? { proposalRegistry: { mode: () => 'on' } } : {}),
      calibrationLog, turnMemory: turnMemoryConfig,
      ...(['advisory', 'on'].includes(FLAG.EGDESK_DRAFT_CHECK) ? { draftCheck: { mode: () => FLAG.EGDESK_DRAFT_CHECK, design: () => (FLAG.EGDESK_DRAFT_CHECK_DESIGN === 'choice' ? 'choice' : 'predicates'), ...(FLAG.EGDESK_DRAFT_CHECK_FILES === 'on' ? { fileText: () => true } : {}), ...(FLAG.EGDESK_DRAFT_CHECK_INCOMPLETE === 'hold' ? { incompleteEvidence: () => 'hold' } : {}) } } : {}),
      ...(FLAG.EGDESK_CONVERSATION_FLOW === 'on' ? { conversationFlow: { mode: () => 'on', ...turnHooks.flowOptions({ FLAG, conversation }), ...(FLAG.EGDESK_FLOW_STALLED_COPY === 'none' ? { stalledCopy: () => 'none' } : {}), ...(FLAG.EGDESK_FLOW_NOTE_WORDING === 'waiting' ? { noteWording: () => 'waiting' } : {}) } } : {}), // a registered feature may add keys to the flow, as the bridge does (the collaboration hook: presence, audience, attentionPosted)
      ...(FLAG.EGDESK_COMMAND_JUDGE === 'advisory' ? { commandJudge: { mode: () => 'advisory' } } : {}),
      ...(wiring && !wiring.shadow ? { terminalGate: wiring.terminalGate(terminalGateConfig) } : terminalGateConfig ? { terminalGate: terminalGateConfig } : {}),
      ...(['advisory', 'on'].includes(FLAG.EGDESK_WORKING_MEMORY) ? { workingMemory: { mode: () => FLAG.EGDESK_WORKING_MEMORY } } : {}),
      topicRecipient: recipient, recipientForChatChoice: recipient,
      collect: async ({ body, context, memoryEvidenceFor, speech }) => (await collectDecisionCandidates({ body, memoryEvidenceFor, speech, clientThreadId: context.clientThreadId, excludeMessageId: context.localMessageId, chatStore: store, deskStore: null, ontologyStore })).candidates,
    }
    // In-run messages are settled by steering them into the working turn, which the product allows only for a binary whose steer contract it
    // verified (inspectNativeCapabilities → boardPeerContract). The check reads the same thing from the given binary (it runs the binary's
    // --version and schema generation, as the bridge does at start) and records it; without a contract the message stays pending and is carried.
    let nativeContract = null
    const needsNative = !claudeMode && (FLAG.EGDESK_INRUN_MESSAGES === 'on' || conversation.turns.some(t => t.action === 'steer' || t.action === 'delete'))
    if (needsNative) {
      try { nativeContract = (deps.inspectNative ?? inspectNativeCapabilities)({ executable: options.codexBin, env: childEnv(options, env), cwd: dataDir, ...(deps.run ? { run: deps.run } : {}) }) } catch { nativeContract = null }
      rec.engine.nativeContract = { version: nativeContract?.version ?? null, schemaMatch: nativeContract?.schemaMatch === true, boardPeerContract: typeof nativeContract?.boardPeerContract === 'string', steerContract: typeof nativeContract?.steerContract === 'string', threadDelete: nativeContract?.threadDelete === true }
    }
    const claudeWrapped = claudeMode ? wrapClaudeAdapter({ adapter: claudeRef.adapter, request, respond, tapNotification: m => { onEngineNotification(m); if (m?.method === 'turn/completed') refreshUsage() }, tapRequest: onEngineRequest }) : null
    const codexStub = claudeMode ? createCodexEngineAdapter({ request: async method => { throw Object.assign(new Error(`${method}: the Codex engine is not used with --engine claude`), { code: 'not_applicable_on_claude' }) }, respond: () => false }) : null
    chat = new CodexChatRuntime({ request, respond, ...(claudeMode ? { engines: [codexStub, claudeWrapped] } : {}), ...(profileStore ? { profiles: profileStore } : {}),
      ...(needsNative ? { getBoardPeerContract: () => nativeContract?.boardPeerContract ?? null, getSteerContract: () => nativeContract?.steerContract ?? null, getThreadDelete: () => nativeContract?.threadDelete === true } : {}), emit: event => { try { if (turnNow.t0 !== null && VISIBLE_EVENTS.has(event?.event) && turnNow.timing.events.length < 200) turnNow.timing.events.push({ event: event.event, atMs: offsetNow(), ...(/^activity\./.test(event.event) ? { kind: String(event.details?.activity?.kind ?? event.details?.kind ?? '').slice(0, 40) } : {}) }) } catch { /* recording only */ } }, emitLegacy: () => {}, store, requireStore: true, contexts, getOwnerKey: () => OWNER, verifyFile: async () => null, resolveProjectWorkspace: async () => null,
      ...(FLAG.EGDESK_AGENT_RELOAD_REUSE === 'on' ? { agentReloadReuse: true } : {}), // inert without an Agent-profile conversation (L7 c27)
      ...(stallConfigFromEnv(FLAG) ? { engineStall: stallConfigFromEnv(FLAG) } : {}), // c33: the first-event watchdog (flag EGDESK_ENGINE_STALL_FIRST_EVENT_MS)
      toolProviders: wiring.toolProviders, ownTools: wiring.ownTools, decisionContext,
      roomAccount: { mode: () => (FLAG.EGDESK_ROOM_ACCOUNT === 'on' ? 'on' : 'off') } })
    if (claudeMode) {
      claudeWrapped.subscribe({ notification: (_, m) => { tasks.push(Promise.resolve(chat.handleNotification(m)).catch(() => {})) }, serverRequest: (_, m) => { tasks.push(Promise.resolve(chat.handleServerRequest(m)).catch(error => turnNow.errors.push(`server_request_failed:${clip(error?.code ?? error?.message, 80)}`))) }, connection: (id, state) => chat.setConnection(id, state.ready, state) })
      claudeRef.adapter.syncStatus() // a change after this reaches the runtime through the subscription; the state the adapter already reached is set here
      if (claudeRef.adapter.isReady()) chat.setConnection('claude', true, {})
    } else chat.setConnection(true)
    registerConversationForgetters(chat, { turnMemoryConfig }) // c28: pending readings (c17) and conversation memory (c18), as the bridge registers them
    const chatRoutes = createChatHttpHandler(chat, async () => { throw Object.assign(new Error('the forget route takes no engine account check'), { code: 'unexpected_auth' }) })
    if (!claudeMode) try { chat.setEngineVersion({ engineId: 'codex', userAgent: agent }) } catch {}
    attached = hooks.map(h => h.attach({ chat, contexts, FLAG, conversation, fetchImpl, key: KEY, calibrationLog, requestLog: rec.requests, limits: deps.hookLimits?.[h.name] }))
    turnHooks.attach({ chat, contexts, client, store, FLAG, conversation, fetchImpl, key: KEY, calibrationLog, requestLog: rec.requests, limits: deps.hookLimits, scratch, engineFolder: path.join(dataDir, 'engine-folders', 'empty'), git: deps.git }) // the registered turn hooks that need the live runtime
    rec.phases.composedMs = ms(t0)
    // c25: what the runtime's private turns did, per turn (Main's check-6: a status reply never reached the chat and the record could not say where it stopped).
    // internalTurns: each private turn (draft revision, heartbeat writer, briefing fill): by which path (fork or a fresh thread), how long, how many characters, the text the model
    // wrote (the check's own copy of the model's output, like posted), or the error. writers: each heartbeat message the runtime composed and whether it was posted (null = it
    // was dropped: the check found something in it, it repeated an earlier message, or the model wrote nothing).
    const runPrivate = chat.internalTurns.run.bind(chat.internalTurns)
    chat.internalTurns.run = async args => {
      const began = performance.now()
      try { const out = await runPrivate(args); turnNow.internal.push({ via: out.via ?? null, ms: ms(began), chars: out.text.length, model: out.model ?? null, effort: out.effort ?? null, source: out.source ?? null, text: clip(out.text, 400), schema: Boolean(args.outputSchema), preamble: out.via === 'fresh' && Boolean(args.fresh?.preamble), ...(out.hedged ? { hedged: true } : {}), trace: closedTrace(out.trace) }); return out }
      catch (error) { turnNow.internal.push({ ms: ms(began), error: String(error?.code ?? 'error').slice(0, 60), message: clip(error?.message ?? '', 200), trace: closedTrace(error?.trace) }); throw error }
    }
    const composeWriter = chat.writeChecked.bind(chat)
    chat.writeChecked = async (run, prompt, options) => { const text = await composeWriter(run, prompt, options); turnNow.writers.push({ promptChars: String(prompt).length, posted: text !== null && text !== undefined, ...(typeof text === 'string' ? { text: clip(text, 300) } : {}) }); return text }
    // The one registration point for another lane's module (the briefing hook, memory seeding): deps.extensions = [{ name, setup(ctx) → { afterTurn?(record, info), finish?() } }].
    // setup runs once the runtime is composed; afterTurn after every scripted turn record; finish at the end of the conversation (its value is kept in
    // rec.extensions[name]). An extension that throws is recorded as { error } and never stops the check or changes a turn's verdict.
    const extensions = []
    for (const ext of deps.extensions ?? []) {
      try { extensions.push({ name: String(ext.name).slice(0, 40), api: await ext.setup?.({ conversation, options, chat, store, wiring, client, calibrationLog, dataDir, scratch, flags: FLAG, rec, request }) ?? {} }) }
      catch (error) { (rec.extensions ??= {})[String(ext?.name).slice(0, 40)] = { error: clip(error?.code ?? error?.message ?? 'error', 100) } }
    }
    const pushTurn = async record => {
      if (carry?.offset) record = { ...record, index: record.index + carry.offset } // the script's own turn numbers across restarts
      rec.turns.push(record)
      for (const { name, api } of extensions) { try { await api.afterTurn?.(record, { conversation, index: rec.turns.length - 1 }) } catch (error) { (rec.extensions ??= {})[name] = { error: clip(error?.code ?? error?.message ?? 'error', 100) } } }
    }

    // ---- the scripted turns ----
    const st = carry?.state // after a restart: the room as the last segment left it
    let clientThreadId = st?.clientThreadId ?? `check-${conversation.id}`, requestSeq = st?.requestSeq ?? 0, nativeThread = st?.nativeThread ?? null, first = st?.first ?? true, seen = st?.seen ?? 0
    const engineFolder = path.join(dataDir, 'engine-folders', 'empty')
    const assistantTexts = () => store.listMessages(clientThreadId, { limit: 200 }).messages.filter(m => m.role === 'assistant').map(m => String(m.text ?? ''))
    // beginTurn sends the person's message and returns at once with the running turn; finishTurn waits for it, then lets the runtime settle.
    const beginTurn = async text => {
      resetTurnNow(); runnerLog.length = 0
      const started = performance.now(); turnNow.t0 = started
      if (claudeMode && deps.claudeGuard) { refreshUsage(); const verdict = deps.claudeGuard.assess('turn', { conversationsDone: deps.claudeProgress?.done ?? 0 }); if (verdict.stop) throw Object.assign(new Error(`the usage guard stops the run: ${verdict.reason}`), { code: 'usage_guard_stop', guard: verdict }) } // c37: also between turns
      const run = await chat.send({ message: text, clientThreadId, requestId: `req-${++requestSeq}`, cwd: scratch, ...(claudeMode ? { engineId: 'claude' } : {}), ...(agentRoom ? { profileId: agentRoom.id, replyDestination: 'direct' } : {}), ...Object.assign({}, ...attached.map(a => a.sendExtra?.({ text }) ?? {})), ...(first ? (persisted || claudeMode ? {} : { stateless: true }) : { conversationId: nativeThread }), ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) })
      first = false; nativeThread = run.conversationId; turnNow.timing.sendMs = ms(started)
      return { run, started }
    }
    const finishTurn = async ({ run, started }) => {
      const deadline = started + options.turnTimeoutMs
      let done = null
      // c32: a decision-first turn ends locally (no engine turn): the runtime's own run says completed, the engine never sends turn/completed for it
      const localDone = () => { const r = chat.runFor(run); return r?.decisionFirst?.path === 'fast' && ['completed', 'failed', 'interrupted'].includes(r.status) ? { threadId: run.conversationId, turnId: run.runId, status: r.status, error: null } : null }
      while (!done && performance.now() < deadline && !closed && !rec.aborted) { done = completions.find(c => c.threadId === run.conversationId && c.turnId === run.runId) ?? localDone(); if (!done) await sleep(10) }
      let status = done?.status ?? null
      if (!done) {
        status = closed ? 'engine_exited' : rec.aborted ? 'aborted' : 'timeout'
        if (status === 'timeout') { try { await rpc.request('turn/interrupt', { threadId: run.conversationId, turnId: run.runId }) } catch {} rec.aborted ??= 'turn_timeout' }
      }
      await Promise.allSettled(tasks.splice(0)); try { await chat.queue } catch {} try { await chat.draftCheckIdle() } catch {} await sleep(30); await Promise.allSettled(tasks.splice(0))
      return { run, status, error: done?.error ?? null, latencyMs: ms(started), firstEventMs: turnNow.turnStartAt !== null && turnNow.firstEventAt !== null ? Math.max(0, Math.round(turnNow.firstEventAt - turnNow.turnStartAt)) : null, firstProgressMs: turnNow.turnStartAt !== null && turnNow.firstProgressAt != null ? Math.max(0, Math.round(turnNow.firstProgressAt - turnNow.turnStartAt)) : null, toolCalls: [...turnNow.toolCalls.values()], items: { ...turnNow.items }, engineMessages: { ...turnNow.engineMessages }, rateLimits: turnNow.rateLimits ?? null, unansweredRequests: [...turnNow.pendingRequests.values()], native: { ...turnNow.native }, usage: turnNow.usage, compacted: turnNow.compacted, errors: [...turnNow.errors], decisions: [...turnNow.decisions], draftRows: [...turnNow.draftRows], flowRows: [...turnNow.flowRows], internal: [...turnNow.internal], writers: [...turnNow.writers], commandsRan: [...runnerLog], timing: { ...turnNow.timing, events: [...turnNow.timing.events], items: [...turnNow.timing.items], tools: [...turnNow.timing.tools], doneMs: ms(started) } }
    }
    const sendAndWait = async text => finishTurn(await beginTurn(text))
    // a message typed into the working run, afterMs after that turn started; not a turn of its own (the run's turn keeps going)
    const sendInRun = async (ctx, text, afterMs) => {
      const wait = afterMs - (performance.now() - ctx.started)
      // deps.sleep: a test drives the wait from events instead of the wall clock; it is asked even when afterMs has already passed (a loaded machine may be late), never skipped
      if (deps.sleep) await deps.sleep(Math.max(0, wait)); else if (wait > 0) await sleep(wait)
      while (performance.now() - ctx.started < afterMs) await sleep(1) // a timer may fire a millisecond early: never act before afterMs
      const mark = { afterMs, sentAtMs: ms(ctx.started), tools: turnNow.toolCalls.size, ran: runnerLog.length, posted: assistantTexts().length, accepted: false, error: null }
      try { const out = await chat.send({ clientThreadId, conversationId: nativeThread, message: text, requestId: `req-${++requestSeq}`, inRunMessageTo: ctx.run.runId }); mark.accepted = out?.accepted === true && out?.inRun === true } catch (error) { mark.error = String(error?.code ?? 'error').slice(0, 60) }
      return mark
    }
    const sumNative = list => list.reduce((n, s) => ({ commandExecution: n.commandExecution + s.native.commandExecution, fileChange: n.fileChange + s.native.fileChange, approvals: n.approvals + s.native.approvals }), { commandExecution: 0, fileChange: 0, approvals: 0 })
    const readFiles = turn => Object.fromEntries(Object.keys(turn.expect?.files ?? {}).map(p => [p, readScratchFile(scratch, p)]))
    const undoCount = () => wiring.files?.undoRecords?.({ conversationId: nativeThread })?.length ?? 0

    // an engine-level action on the previous turn's working run, afterMs after that turn started (the person's own message is whileRunning, above)
    const engineAction = async (kind, ctx, step) => {
      const afterMs = step.afterMs ?? 0
      const wait = afterMs - (performance.now() - ctx.started)
      if (deps.sleep) await deps.sleep(Math.max(0, wait)); else if (wait > 0) await sleep(wait)
      while (performance.now() - ctx.started < afterMs) await sleep(1) // a timer may fire a millisecond early: never act before afterMs
      const mark = { afterMs, sentAtMs: ms(ctx.started), tools: turnNow.toolCalls.size, ran: runnerLog.length, posted: assistantTexts().length, accepted: false, error: null }
      try {
        if (kind === 'interrupt') mark.accepted = (await chat.interrupt({ conversationId: nativeThread, runId: ctx.run.runId }))?.accepted === true
        else {
          // the product's own steer path: its engine adapter, with the proof of this binary's steer contract
          const engine = chat.engineOf(nativeThread), slot = chat.threadOperationSlot(nativeThread)
          const proof = engine?.steerContract?.(slot) ?? engine?.boardPeerContract?.(slot)
          if (!proof) mark.error = 'no_steer_contract'
          else mark.accepted = (await engine.steerTurn({ threadId: nativeThread, expectedTurnId: ctx.run.runId, clientUserMessageId: `steer-${++requestSeq}`, input: [{ type: 'text', text: step.say, text_elements: [] }] }, slot, proof))?.turnId === ctx.run.runId
        }
      } catch (error) { mark.error = String(error?.code ?? error?.message ?? 'error').slice(0, 60) }
      return mark
    }
    // the person deletes the conversation (the surface's delete: forgetConversation); the next message turn starts a new one
    let generation = st?.generation ?? 0
    const deleteTurn = async (index, turn) => {
      const key = clientThreadId
      let out = null, error = null, route = null
      // c28: what a deletion is judged against is read before it: the conversation's rows, its memory seeds (synthetic, written into this check's own store), its engine thread
      const seeded = conversation.seededWrites ?? null
      let before = { messages: null }, writesBefore = null
      try { before = { messages: store.listMessages(key, { limit: 500 }).messages.length } } catch { before = { messages: 0 } }
      try {
        if (seeded) { seedWrites(wikiWrites, seeded, { clientThreadId: key, firstMessageRef: (store.localMessageIds?.(key) ?? [])[0] ? `chat-message:${store.localMessageIds(key)[0]}` : null }); writesBefore = writesFacts(wikiWrites, { clientThreadId: key, seeded }) }
      } catch (e) { error = `seed_failed: ${String(e?.message ?? e).slice(0, 80)}` }
      const threadAtDelete = nativeThread
      // the window's own request: POST /chat/conversation/forget { clientThreadId }, handled by the product's route (it is a local write: no engine account check)
      try {
        const payload = Buffer.from(JSON.stringify({ clientThreadId: key }))
        const req = Object.assign(Readable.from([payload]), { url: '/chat/conversation/forget', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } })
        const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(status) { this.status = status }, end(body) { this.body = body ? JSON.parse(body) : null; this.writableEnded = true } })
        const handled = await chatRoutes(req, res, new URL('/chat/conversation/forget', 'http://127.0.0.1:39218'))
        if (handled !== true) throw Object.assign(new Error('route not handled'), { code: 'route_unhandled' })
        route = { status: res.status ?? null, body: res.body ?? null }; out = res.status === 200 ? res.body : null
        if (res.status !== 200) error = `route_status_${res.status}`
      } catch (e) { error = String(e?.code ?? e?.message ?? 'error').slice(0, 60) }
      let stored = null, messages = null, listed = null, localIds = null
      try { stored = Boolean(store.getConversation?.(key)) } catch { stored = null }
      // a conversation the store no longer knows has no message list: listing it throws, which is the answer (0 messages)
      try { messages = store.listMessages(key, { limit: 5 }).messages.length } catch { messages = stored === false ? 0 : null }
      try { listed = store.listConversations().threads.some(x => x.clientThreadId === key) } catch { listed = null }
      try { localIds = (store.localMessageIds?.(key) ?? []).length } catch { localIds = null }
      const gone = stored === false && messages === 0
      // the engine's thread: a persisted thread that was deleted cannot be resumed (the engine answers an error); a thread that is still there resumes
      let resume = null
      if (persisted && threadAtDelete) {
        try { await request('thread/resume', { threadId: threadAtDelete }); resume = { failed: false, error: null } }
        catch (e) { resume = { failed: true, error: clip(String(e?.message ?? e?.code ?? 'error'), 120) } }
      }
      const writesAfter = seeded ? writesFacts(wikiWrites, { clientThreadId: key, seeded }) : null
      const deletion = { route, before, store: { conversation: stored, messages, listed, localIds }, resume, writesBefore, writesAfter, seeded }
      const summary = out ? { stored, messages, interrupted: out.interrupted ?? 0, history: out.history ?? null, engineHistory: (out.engineHistory ?? []).map(h => ({ state: h.state, reason: h.reason ?? null })), modules: out.modules ?? null } : null
      const expectations = [{ check: 'action_taken', ok: out?.accepted === true, detail: { error } }, ...checkTurnExpectations(turn.expect ?? {}, { conversationGone: gone, posted: [], toolCalls: [], native: { commandExecution: 0, fileChange: 0, approvals: 0 }, deletion })]
      await pushTurn({ index: index + 1, action: 'delete', approve: [], subTurns: [{ action: 'delete', accepted: out?.accepted === true, error, conversationGone: gone, summary }], posted: [], asked: 0, undoRecords: undoCount(), deletion: { route: route && { status: route.status, modules: route.body?.modules ?? null }, before, store: deletion.store, resume, writes: seeded ? { before: writesBefore && { pendingFromConversation: writesBefore.pendingFromConversation, conversationPages: writesBefore.conversationPages.length }, after: writesAfter && { pendingFromConversation: writesAfter.pendingFromConversation, conversationPages: writesAfter.conversationPages.length, pages: writesAfter.pages } } : null }, expectations, ok: expectations.every(e => e.ok) })
      clientThreadId = `check-${conversation.id}-${++generation}`; nativeThread = null; first = true; seen = 0
    }

    // ---- after a restart: the window's reconnect (resume the room's saved conversation on the new engine), and the restart turn's own record ----
    if (carry?.resumed) {
      let resumed = null, resumeError = null
      try { resumed = await chat.resume({ conversationId: nativeThread, clientThreadId }) } catch (error) { resumeError = String(error?.code ?? error?.message ?? 'error').slice(0, 80) }
      seen = assistantTexts().length
      const after = await turnHooks.afterRestart({ state: () => ({ store, clientThreadId, conversationId: nativeThread }), expect: carry.restartTurn.expect, carried: carry.hooksCarried })
      const expectations = [{ check: 'restart.resumed', ok: resumeError === null && resumed != null, detail: { error: resumeError, runs: Array.isArray(resumed?.runs) ? resumed.runs.length : null } }, ...after.expectations]
      await pushTurn({ index: carry.restartIndex + 1 - carry.offset, action: 'restart', posted: [], asked: 0, ...after.records, expectations, ok: expectations.every(e => e.ok) })
    }
    for (let index = 0; index < conversation.turns.length; index++) {
      if (rec.aborted || closed) break
      const turn = conversation.turns[index], next = conversation.turns[index + 1]
      if (turn.action === 'delete') { await deleteTurn(index, turn); continue }
      // a message turn takes at most one follow-up: a person's message typed into the run (whileRunning), or an engine-level interrupt / steer
      const follow = next?.whileRunning !== undefined ? 'message' : (next?.action === 'interrupt' || next?.action === 'steer') ? next.action : null, withMessage = follow !== null
      const sub = [], ledger = wiring.ledger, requestsFrom = rec.requests.length
      let asked = 0, mark = null
      const hookCtx = { state: () => ({ store, clientThreadId, conversationId: nativeThread }), chat: () => chat }
      turnHooks.beginTurn(hookCtx) // registered hooks
      await turnHooks.beforeSend({ ...hookCtx, turn, index }) // registered hooks: set up this turn before its message is sent (who sends it)
      const ctx = await beginTurn(turn.say)
      // c30: a CONCURRENT run (turn.alongside, a registered turn field): another room's message sent right after this turn's, on the same runtime, while this one works
      let side = null
      if (turn.alongside) {
        const room = { id: `check-${conversation.id}-alongside-${index + 1}` }
        await turnHooks.beforeSend({ state: () => ({ store, clientThreadId: room.id, conversationId: null }), turn: turn.alongside, index, room: 'alongside' })
        const sent = await chat.send({ message: turn.alongside.say, clientThreadId: room.id, requestId: `req-${++requestSeq}`, cwd: scratch, ...Object.assign({}, ...attached.map(a => a.sendExtra?.() ?? {})), ...(persisted || claudeMode ? {} : { stateless: true }), ...(claudeMode ? { engineId: 'claude' } : {}), ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) })
        side = { room, run: sent, started: performance.now(), status: null, posted: [] }
      }
      if (follow === 'message') { mark = await sendInRun(ctx, next.say, next.whileRunning.afterMs); turnHooks.inRun({ ...hookCtx, text: next.say }) } // registered hooks
      else if (follow) mark = await engineAction(follow, ctx, next)
      sub.push(await finishTurn(ctx))
      if (side) { // the other room's run: wait for it too (same bound), then let the runtime settle
        let done = null
        while (!done && performance.now() < side.started + options.turnTimeoutMs && !closed && !rec.aborted) { done = completions.find(c => c.threadId === side.run.conversationId && c.turnId === side.run.runId); if (!done) await sleep(10) }
        side.status = done?.status ?? (closed ? 'engine_exited' : 'timeout')
        await Promise.allSettled(tasks.splice(0)); try { await chat.queue } catch {} try { await chat.draftCheckIdle() } catch {} await sleep(30); await Promise.allSettled(tasks.splice(0))
        try { side.posted = store.listMessages(side.room.id, { limit: 200 }).messages.filter(m => m.role === 'assistant').map(m => String(m.text ?? '')) } catch { side.posted = [] }
      }
      for (const answer of turn.approve ?? []) {
        if (rec.aborted || closed || !nativeThread) break
        if (!ledger?.awaitingReply?.(nativeThread)) { sub.at(-1).approverUnused = true; break }
        asked++
        sub.push({ approver: answer, ...(await sendAndWait(APPROVER_TEXT[answer])) })
      }
      if (ledger?.awaitingReply?.(nativeThread)) asked++ // a question left open at the end of the scripted turn
      if (index === 0 && !rec.isolation) rec.isolation = await readOwnToolsIsolation(request, { threadId: nativeThread, startResult: lastThreadStart, folders: [engineFolder] })
      const texts = assistantTexts()
      const posted = texts.slice(seen) // the whole window of this turn (and of the message typed into it)
      seen = texts.length
      // a registered feature that has an `expect.<name>` entry in this turn runs now, after the answer is posted, and leaves its record
      const hookRecords = {}
      for (const a of attached) if (turn.expect?.[a.name] !== undefined && a.afterTurn) hookRecords[a.name] = await a.afterTurn({ run: sub.at(-1).run, say: turn.say, answer: posted.at(-1) ?? null, turnIndex: index + 1 })
      const window = rec.requests.slice(requestsFrom), countOf = method => window.filter(r => r.method === method).length
      const engineRequests = {}
      const contextKeys = [...new Set(window.flatMap(r => r.contextKeys ?? []))]
      for (const r of window) engineRequests[r.method] = (engineRequests[r.method] ?? 0) + 1
      const flat = {
        resumes: countOf('thread/resume'), unsubscribes: countOf('thread/unsubscribe'),
        hooks: hookRecords, toolCalls: sub.flatMap(s => s.toolCalls), native: sumNative(sub), posted, asked, commandsRan: sub.flatMap(s => s.commandsRan), files: readFiles(turn), undoRecords: undoCount(),
        turnStatus: sub.at(-1).status, compacted: sub.some(s => s.compacted), draftCheckRows: sub.reduce((n, s) => n + (s.draftRows?.length ?? 0), 0), draftCheckRejects: sub.reduce((n, s) => n + (s.draftRows ?? []).reduce((m, row) => m + (row.judgments ?? []).filter(j => j.would === 'reject').length, 0), 0),
      }
      // registered hooks that wait on the live runtime after the answer is posted (their record goes under their name, their expectations join the turn's)
      const after = await turnHooks.afterTurn({ ...hookCtx, firstEventMs: sub[0]?.firstEventMs ?? null, firstProgressMs: sub[0]?.firstProgressMs ?? null, run: sub.at(-1).run, say: turn.say, answer: posted.at(-1) ?? null, turnIndex: index + 1, expect: turn.expect, toolTexts: sub.flatMap(x => x.toolCalls ?? []).map(c => c.result?.text).filter(t => typeof t === 'string'), ...(side ? { alongside: { run: side.run, clientThreadId: side.room.id, say: turn.alongside.say, answer: side.posted.at(-1) ?? null, status: side.status } } : {}) })
      const ext = turnHooks.finishTurn({ ...hookCtx, expect: turn.expect, nextExpect: withMessage ? next.expect : null, latencyMs: sub[0].latencyMs, timingTurn: { posted, subTurns: [sub[0]] }, steerContract: FLAG.EGDESK_INRUN_MESSAGES === 'on' ? (typeof nativeContract?.steerContract === 'string' || typeof nativeContract?.boardPeerContract === 'string') : null /* c28: the proof the runtime uses is steerContract ?? boardPeerContract (the real 0.171 record said false while engine.nativeContract.steerContract was true) */ }) // registered hooks: records, expectations
      Object.assign(ext.records, after.records); ext.expectations.push(...after.expectations)
      const expectations = [...checkTurnExpectations(turn.expect ?? {}, flat), ...(side ? [{ check: 'alongside.completed', ok: side.status === 'completed' && side.posted.length >= 1, detail: { status: side.status, posted: side.posted.length } }] : []), ...ext.expectations]
      const failedRun = s => s.status === 'timeout' || s.status === 'engine_exited'
      await pushTurn({ index: index + 1, say: clip(turn.say, 200), approve: turn.approve ?? [], subTurns: sub.map(s => ({ approver: s.approver ?? null, status: s.status, error: s.error, latencyMs: s.latencyMs, firstEventMs: s.firstEventMs ?? null, firstProgressMs: s.firstProgressMs ?? null, items: s.items, engineMessages: s.engineMessages ?? {}, rateLimits: s.rateLimits ?? null, unansweredRequests: s.unansweredRequests ?? [], native: s.native, usage: s.usage, compacted: s.compacted, errors: s.errors,
        toolCalls: s.toolCalls, decisions: s.decisions, commandsRan: s.commandsRan, approverUnused: s.approverUnused === true, ...(s.timing ? { timing: s.timing } : {}) })),
        ...(side ? { alongside: { clientThreadId: side.room.id, status: side.status, posted: side.posted.map(t => clip(t, 400)) } } : {}), ...(Object.keys(hookRecords).length ? { hooks: hookRecords } : {}), posted, postedCount: posted.length, finalAnswer: posted.at(-1) ?? null, engineRequests, ...(contextKeys.length ? { contextKeys } : {}), ...(sub.some(s => s.flowRows?.length) ? { flowRows: sub.flatMap(s => s.flowRows) } : {}), ...(sub.some(s => s.internal?.length) ? { internalTurns: sub.flatMap(s => s.internal) } : {}), ...(sub.some(s => s.writers?.length) ? { writers: sub.flatMap(s => s.writers) } : {}), ...(sub.some(s => s.draftRows?.length) || FLAG.EGDESK_DRAFT_CHECK ? { draftCheck: { rows: sub.flatMap(s => s.draftRows ?? []) } } : {}), asked, undoRecords: flat.undoRecords, ...ext.records, expectations, ok: expectations.every(e => e.ok) && !sub.some(failedRun) })
      if (withMessage) {
        // the message typed into the run: what happened after it was sent
        const prev = sub[0], after = texts.slice(mark.posted)
        const flat2 = { toolCalls: prev.toolCalls.slice(mark.tools), native: prev.native, posted: after, asked, commandsRan: prev.commandsRan.slice(mark.ran), files: readFiles(next), undoRecords: undoCount(), turnStatus: sub.at(-1).status, compacted: sub.some(s => s.compacted) }
        const implicit = follow === 'message' ? 'sent_while_running' : 'action_taken'
        const expect2 = [{ check: implicit, ok: mark.accepted, detail: { afterMs: mark.afterMs, sentAtMs: mark.sentAtMs, error: mark.error } }, ...checkTurnExpectations(next.expect ?? {}, flat2), ...(follow === 'message' ? ext.nextExpectations : [])] // registered hooks
        await pushTurn({ index: index + 2, say: clip(next.say ?? '', 200), approve: [], ...(follow === 'message' ? { whileRunning: { afterMs: mark.afterMs } } : { action: follow, afterMs: mark.afterMs }), subTurns: [{ ...(follow === 'message' ? { whileRunning: true } : { action: follow }), accepted: mark.accepted, error: mark.error, sentAtMs: mark.sentAtMs }],
          posted: after, postedCount: after.length, ...(sub.some(s => s.flowRows?.length) ? { flowRows: sub.flatMap(s => s.flowRows) } : {}), asked, undoRecords: flat2.undoRecords, expectations: expect2, ok: expect2.every(e => e.ok) && !sub.some(failedRun) })
        index++
      }
    }
    for (const { name, api } of extensions) { try { const value = await api.finish?.(); if (value !== undefined) (rec.extensions ??= {})[name] = value } catch (error) { (rec.extensions ??= {})[name] = { error: clip(error?.code ?? error?.message ?? 'error', 100) } } }
    // before a restart: what the old hooks hand to the new ones, while the old engine and store are still there
    if (carry?.out && !rec.aborted && !closed) carry.out.hooks = await turnHooks.beforeRestart({ state: () => ({ store, clientThreadId, conversationId: nativeThread }) })
    if (carry?.out) carry.out.state = { clientThreadId, nativeThread, first, seen: assistantTexts().length, generation, requestSeq, createdThreads }
    rec.ok = !rec.aborted && !closed && rec.turns.length === conversation.turns.length + (carry?.resumed ? 1 : 0) && rec.turns.every(t => t.ok)
    rec.decisionCalls = decisionCall.length
    if (limitsNow) rec.rateLimits = closedRateLimits(limitsNow) // c34: the allowance as the conversation ended
  } catch (error) {
    rec.aborted ??= String(error?.code ?? error?.name ?? 'error').slice(0, 60)
    rec.abortDetail = clip(error?.message ?? '', 300)
    if (stderrTail) rec.engineStderrTail = clip(stderrTail.replace(/\s+/g, ' '), 600)
  } finally {
    // persisted mode: the threads this conversation created are deleted and verified gone BEFORE the engine goes, also after an abort
    if (persisted && !(carry?.keep && !rec.aborted)) { // a segment before a restart leaves its persisted threads for the next one (an abort cleans up now)
      const ids = createdThreads.filter(t => !t.ephemeral).map(t => t.id)
      try { rec.cleanup = await deleteAndVerify((method, params) => rpc.request(method, params), ids, ledger) }
      catch (error) { rec.cleanup = { persisted: ids.length, deleted: 0, verifiedGone: 0, failures: [{ id: '*', step: 'cleanup', error: clip(error?.message ?? 'error', 200) }] } }
      rec.cleanup.ephemeral = createdThreads.length - ids.length
      if (rec.cleanup.failures.length) { rec.ok = false; rec.cleanupFailed = true }
    }
    if (claudeMode) { refreshUsage(); try { rec.claude = { sessions: claudeSessions.slice(), billing: claudeRef.adapter?.usage?.()?.billing ?? null, usage: deps.claudeGuard?.log?.().slice(-20) ?? [], sessionFiles: 'left by the CLI (listed above); the check deletes nothing' } } catch { /* advisory */ } }
    try { rec.stallWatchdog = stallRecord({ armed: stallConfigFromEnv(FLAG)?.firstEventMs ?? null, source: conversation.flags?.[ENGINE_STALL_FLAG] !== undefined ? 'script' : 'option', log: chat?.engineStallLog ?? [] }) } catch { /* the record is advisory */ } // c36
    turnHooks.dispose() // registered hooks: timers and the like
    await stop()
    try { store?.close() } catch {}
    try { profileStore?.close() } catch {}
    rec.totalMs = ms(t0)
  }
  return rec
}

/** run(options, scripts, deps) → { records, ok } and writes <out>/records/<set>/<id>.json plus <out>/summary.json. Sequential: one conversation at a time. */
/** Refuses (code cleanup_not_guaranteed) before anything starts when persisted threads could be left behind. */
export function assertCleanupGuaranteed(options, deps = {}, env = process.env) {
  if (!options.persisted) return
  makeDirs(options.out)
  const ledger = deps.ledger ?? createLedger(options.out), left = leftoverThreads(ledger.read())
  if (left.length) throw Object.assign(new Error(`an earlier run left ${left.length} persisted thread(s) listed in ${ledger.file}; run with --cleanup-leftovers first`), { code: 'cleanup_not_guaranteed', leftovers: left })
  let native = null
  try { native = (deps.inspectNative ?? inspectNativeCapabilities)({ executable: options.codexBin, env: childEnv(options, env), cwd: options.out, ...(deps.run ? { run: deps.run } : {}) }) } catch { native = null }
  if (native?.threadDelete !== true) throw Object.assign(new Error('the binary\'s generated schema has no thread/delete (or could not be read), so removing the threads the check creates cannot be guaranteed'), { code: 'cleanup_not_guaranteed' })
}

/**
 * cleanupLeftovers(options, deps) → { leftovers, deleted, verifiedGone, failures }: starts one app-server on the given home, deletes the persisted threads the ledger
 * shows as created and not verified gone, verifies each gone, and stops the app-server (process group). Starts nothing when the ledger is clean.
 */
export async function cleanupLeftovers(options, deps = {}) {
  const env = deps.env ?? process.env, ledger = deps.ledger ?? createLedger(options.out), ids = leftoverThreads(ledger.read())
  const result = { leftovers: ids.length, deleted: 0, verifiedGone: 0, failures: [] }
  if (!ids.length) return result
  const spawn = deps.spawn ?? nodeSpawn, killGroup = deps.killGroup ?? createGroupKiller()
  makeDirs(options.out)
  const child = spawn(options.codexBin, appServerArgs(options, deps.buildLaunch ?? buildCodexAppServerLaunch), { cwd: options.out, env: childEnv(options, env), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let initializeResult = null, buffer = ''
  const rpc = new AppServerRpc({ send: payload => child.stdin.write(`${payload}\n`), experimentalApi: true, timeoutMs: 60_000, onNotification: () => {}, onRequest: () => {} })
  child.on('close', () => { try { rpc.close(Object.assign(new Error('the Codex app-server exited'), { code: 'engine_exited' })) } catch {} })
  child.on('error', () => {})
  child.stdout?.on('data', chunk => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id === 1 && m.result?.codexHome) initializeResult = m.result } catch {} rpc.receive(line) } })
  try {
    await rpc.initialize()
    if (options.home.kind === 'dir') {
      const same = initializeResult?.codexHome === options.home.dir || (() => { try { return fs.realpathSync(initializeResult?.codexHome) === fs.realpathSync(options.home.dir) } catch { return false } })()
      if (!same) throw Object.assign(new Error('the app-server reports another Codex home than --codex-home'), { code: 'home_mismatch' })
    }
    Object.assign(result, await deleteAndVerify((method, params) => rpc.request(method, params), ids, ledger), { leftovers: ids.length })
  } catch (error) { result.failures.push({ id: '*', step: 'start', error: clip(error?.message ?? error?.code ?? 'error', 200) }) }
  finally { try { rpc.close() } catch { /* closed */ } await killGroup(child) }
  return result
}

export async function runCheck(options, scripts, deps = {}) {
  const records = []
  makeDirs(options.out)
  const claude = options.engine === 'claude'
  // c37: the Claude run's guards: the usage guard (before each conversation and each turn), the cap, and what does not apply to Claude
  const usageHolder = { row: null }, progress = { done: 0 }
  const guard = claude ? createUsageGuard({ readUsage: () => usageHolder.row, stopAtPercent: options.usageStopPercent, requireSignal: options.requireUsageSignal, ...(options.usageState ? { state: fileUsageState(options.usageState, deps.fs ?? fs) } : {}) }) : null
  const claudeDeps = claude ? { ...deps, claudeUsage: usageHolder, claudeGuard: guard, claudeProgress: progress } : deps
  const notApplicable = [], stopped = { by: null }
  const agentRooms = claude ? [] : scripts.flatMap(({ script }) => script.conversations.filter(c => c.agentProfile).map(c => `${script.set}/${c.id}`))
  if (agentRooms.length && !options.persisted) throw Object.assign(new Error(`an agentProfile conversation is a direct room, which is not one-time: it needs --persisted-with-cleanup (${agentRooms.join(', ')})`), { code: 'agent_room_needs_persisted' })
  const engineGoneRooms = claude ? [] : scripts.flatMap(({ script }) => script.conversations.filter(c => c.turns.some(t => t.expect?.deleted?.engineGone)).map(c => `${script.set}/${c.id}`)) // c28
  if (engineGoneRooms.length && !options.persisted) throw Object.assign(new Error(`deleted.engineGone needs a saved engine thread: it needs --persisted-with-cleanup (${engineGoneRooms.join(', ')})`), { code: 'engine_gone_needs_persisted' })
  const restartRooms = claude ? [] : scripts.flatMap(({ script }) => script.conversations.filter(c => c.turns.some(t => t.action === 'restart')).map(c => `${script.set}/${c.id}`)) // c29
  if (restartRooms.length && !options.persisted) throw Object.assign(new Error(`a restart turn needs a saved engine thread to come back to: it needs --persisted-with-cleanup (${restartRooms.join(', ')})`), { code: 'restart_needs_persisted' })
  if (!claude) assertCleanupGuaranteed(options, deps, deps.env ?? process.env)
  for (const { script } of scripts) {
    for (const conversation of script.conversations) {
      if (stopped.by) break
      if (claude) {
        const verdict = claudeApplicability(conversation)
        if (!verdict.applicable) { // not a failure: the conversation needs something Claude does not have, so it is not run (and does not count against the cap)
          notApplicable.push({ set: script.set, id: conversation.id, features: verdict.notApplicable.map(n => n.feature) })
          const skipped = { set: script.set, id: conversation.id, engine: 'claude', notApplicable: verdict.notApplicable, turns: [], aborted: null, ok: true, totalMs: 0, skipped: 'not_applicable' }
          records.push(skipped); const dir = path.join(options.out, 'records', script.set); makeDirs(dir); fs.writeFileSync(path.join(dir, `${conversation.id}.json`), `${JSON.stringify(skipped, null, 2)}\n`, { mode: 0o600 }); continue
        }
        if (options.maxConversations !== null && progress.done >= options.maxConversations) { stopped.by = { reason: 'max_conversations', cap: options.maxConversations, before: `${script.set}/${conversation.id}` }; break }
        const verdictNow = guard.assess('conversation', { conversationsDone: progress.done })
        if (verdictNow.stop) { stopped.by = { reason: verdictNow.reason, guard: true, before: `${script.set}/${conversation.id}`, windows: verdictNow.windows }; break }
      }
      const rec = await runConversation({ options, set: script.set, conversation, deps: claudeDeps })
      if (claude) { progress.done++; if (rec.aborted === 'usage_guard_stop') stopped.by = { reason: 'usage_guard_stop', guard: true, inside: `${script.set}/${conversation.id}` } }
      records.push(rec)
      const dir = path.join(options.out, 'records', script.set); makeDirs(dir)
      fs.writeFileSync(path.join(dir, `${conversation.id}.json`), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 })
    }
  }
  if (claude) guard.persist()
  const summary = { at: new Date().toISOString(), ...(claude ? { engine: 'claude', stoppedBy: stopped.by, notApplicable, usageGuard: { stopAtPercent: options.usageStopPercent, maxConversations: options.maxConversations, ran: progress.done, log: guard.log().slice(-40) } } : {}), ok: records.every(r => r.ok) && !stopped.by?.guard, conversations: records.map(r => ({ set: r.set, id: r.id, ok: r.ok, aborted: r.aborted, ...(r.cleanup ? { cleanup: { persisted: r.cleanup.persisted, deleted: r.cleanup.deleted, verifiedGone: r.cleanup.verifiedGone, failures: r.cleanup.failures.length } } : {}), turns: r.turns.length, failedChecks: r.turns.flatMap(t => t.expectations.filter(e => !e.ok).map(e => `${t.index}:${e.check}`)), totalMs: r.totalMs, ...(r.stallWatchdog ? { stallWatchdog: r.stallWatchdog } : {}) })), stalls: stallTotals(records) }
  fs.writeFileSync(path.join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  return { records, summary, ok: summary.ok }
}

