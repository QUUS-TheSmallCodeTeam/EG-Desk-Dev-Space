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
import fs from 'node:fs'
import path from 'node:path'
import { constants } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { CodexChatRuntime, TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS } from './codex-chat-runtime.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { readOwnToolsIsolation } from './egdesk-own-tools-isolation.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
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
import { createMemoryHook, memoryNeedsDecisions } from './egdesk-real-engine-memory.mjs' // memory hook (L7 c26)
import { createJourneyHook, messageCounts } from './egdesk-real-engine-journey.mjs' // journey hook (L2 c21)
import { CHECK_HOOKS, hookDecisionFlags, hookFlags } from './egdesk-real-engine-hooks.mjs'

export const DECISION_KEY_ENV = 'EGDESK_REAL_CHECK_DECISION_KEY'
export const CHILD_ENV_ALLOW = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'])
export const DEFAULT_TURN_TIMEOUT_MS = 180_000
export const KILL_GRACE_MS = 2000
// Flags a conversation gets when --decisions is on and its script names none of its own (a script's flags are added to these, never replaced):
// the product's advisory draft check (records only; the posted answer is the model's own) and the command gate. Every other flag is off.
// flags that do something only when the Decision model answers: without --decisions a script that sets one would pass or fail for the wrong reason
export const DECISION_DEPENDENT_FLAGS = Object.freeze(['EGDESK_DRAFT_CHECK', 'EGDESK_CONVERSATION_FLOW', 'EGDESK_COMMAND_JUDGE', 'EGDESK_WORKING_MEMORY', 'EGDESK_CONTEXT_RELEVANCE', 'EGDESK_TERMINAL_GATE', 'EGDESK_DECISION_WARMUP', ...hookDecisionFlags()])
// c24: nothing is on by default any more; the draft check is a conversation's own opt-in (conversation.draftCheck in the script, like memory) because it costs Decision calls
export const DEFAULT_DECISION_FLAGS = Object.freeze({})
// The bridge's decisionContext keys and the developer flags behind them that this composition reproduces. A test compares this list with
// codex-bridge-server.mjs, so a key or flag the bridge gains and this composition lacks fails loudly instead of being silently absent.
export const BRIDGE_COMPOSITION = Object.freeze({
  // decisionContext keys the bridge sets, and the developer flags behind them, that this composition reproduces
  keys: ['settingsGeneration', 'mode', 'configured', 'client', 'budgetMs', 'coldBudgetMs', 'warm', 'warmup', 'inRunMessages', 'calibrationLog', 'turnMemory', 'browserEntry', 'draftCheck', 'conversationFlow',
    'relevanceRules', 'commandJudge', 'terminalGate', 'workingMemory', 'topicRecipient', 'recipientForChatChoice', 'reviewRevision', 'memoryEvidence', 'collect'],
  // top-level options of the bridge's new CodexChatRuntime({ … }) that this composition passes (request / respond / toolProviders etc. are the check's own)
  runtimeKeys: ['contexts', 'toolProviders', 'ownToolsWiring', 'roomAccount', 'store', 'requireStore', 'getOwnerKey', 'emit', 'emitLegacy', 'agentReloadReuse'],
  flags: ['EGDESK_DRAFT_CHECK', 'EGDESK_DRAFT_CHECK_DESIGN', 'EGDESK_CONVERSATION_FLOW', 'EGDESK_COMMAND_JUDGE', 'EGDESK_TERMINAL_GATE', 'EGDESK_TERMINAL_GATE_METHOD',
    'EGDESK_WORKING_MEMORY', 'EGDESK_CONTEXT_RELEVANCE', 'EGDESK_OWN_TOOLS', 'EGDESK_INRUN_MESSAGES', 'EGDESK_ROOM_ACCOUNT', 'EGDESK_DECISION_WARMUP', 'EGDESK_AGENT_RELOAD_REUSE', ...hookFlags()],
  // present in the bridge, deliberately not reproduced: each needs a window, the Desk, a store this check does not open, or another lane's module
  notReproduced: {
    keys: ['browserEntry', 'reviewRevision', 'memoryEvidence', 'settingsGeneration'],
    runtimeKeys: ['localCapacity', 'engines', 'resolveProjectWorkspace', 'resolveRunProjectOrigin', 'expectedProcessConfiguration', 'qaReady', 'getNativeContractFingerprint', 'profiles', 'mcpServerKind', 'computerControlStore', 'onComputerControlChange', 'hostLease'],
    flags: ['EGDESK_PRESENCE', 'EGDESK_BROWSER_ENTRY', 'EGDESK_WORK_PLACEMENT', 'EGDESK_BRIEFING_ORDER', 'EGDESK_BRIEFING_FILL_CHECK', 'EGDESK_BRIEFING_COVERAGE', // the briefing flow and its output schema are reproduced by the hook (hookFlags)
           'EGDESK_HUD_ROUTING', 'EGDESK_TERMINAL_JUDGE', 'EGDESK_CONTEXT_ROOTS', 'EGDESK_FIREFOX_PROFILE', 'EGDESK_CLAUDE_READER', 'EGDESK_CLAUDE_DELETE_SESSION', 'EGDESK_CHAT_CHOICE'],
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
  --decisions      use the Decision model (key from ${DECISION_KEY_ENV}); without it no Decision call is made and "yes" approvals cannot be read
  --model <id>, --effort <low|medium|high|…>   per-turn model and effort (otherwise the home's configuration applies)
  --app-server-config k=v    an extra -c k=v for the app-server (repeatable)
  --turn-timeout-ms <n>      per scripted turn (default ${DEFAULT_TURN_TIMEOUT_MS}); on timeout the turn is interrupted once and the conversation ends
  --persisted-with-cleanup   persisted source threads (so product-like forks work); every thread the check creates is deleted with thread/delete and verified gone at the end of its
                   conversation; refuses to start when the binary has no thread/delete or an earlier run left threads (see --cleanup-leftovers); default: ephemeral threads only
  --cleanup-leftovers        delete and verify gone the threads an earlier killed run left in <out>/created-threads.jsonl (needs --codex-bin, a home, --out; no script)
  --json           print the plan or the summary as JSON`

/** parseArgs(argv, env) → options. Throws { code: 'usage' }. */
export function parseArgs(argv, env = process.env) {
  const o = { mode: 'dry', codexBin: null, home: null, scripts: [], out: null, decisions: false, model: null, effort: null, appServerConfig: [], persisted: false, cleanupLeftovers: false, turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS, json: false, help: false }
  const takes = new Set(['--codex-bin', '--codex-home', '--script', '--out', '--model', '--effort', '--app-server-config', '--turn-timeout-ms'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { o.help = true; continue }
    if (arg === '--dry') { o.mode = 'dry'; continue }
    if (arg === '--run') { o.mode = 'run'; continue }
    if (arg === '--decisions') { o.decisions = true; continue }
    if (arg === '--json') { o.json = true; continue }
    if (arg === '--persisted-with-cleanup') { o.persisted = true; continue }
    if (arg === '--cleanup-leftovers') { o.cleanupLeftovers = true; continue }
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
    else if (arg === '--turn-timeout-ms') { const n = Number(value); if (!Number.isInteger(n) || n < 1000 || n > 3_600_000) throw usage('--turn-timeout-ms is 1000-3600000'); o.turnTimeoutMs = n }
  }
  if (o.help) return o
  if (!o.codexBin) throw usage('--codex-bin is required (no binary is searched for)')
  if (!path.isAbsolute(o.codexBin)) throw usage('--codex-bin must be an absolute path')
  if (!o.home) throw usage('give --codex-home <dir> or --person-home')
  if (o.home.kind === 'dir' && !path.isAbsolute(o.home.dir)) throw usage('--codex-home must be an absolute path')
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
  if (!exists(options.codexBin)) problems.push(`the Codex binary is not an existing executable: ${options.codexBin}`)
  if (options.home.kind === 'dir' && !fs.existsSync(options.home.dir)) problems.push(`the Codex home does not exist: ${options.home.dir}`)
  if (options.decisions && !(typeof env[DECISION_KEY_ENV] === 'string' && env[DECISION_KEY_ENV].trim())) problems.push(`--decisions needs the key in ${DECISION_KEY_ENV}`)
  if (!options.decisions) {
    const needs = scripts.flatMap(({ script }) => script.conversations.filter(c => c.turns.some(t => (t.approve ?? []).includes('yes'))).map(c => `${script.set}/${c.id}`))
    if (needs.length) problems.push(`scripted "yes" approvals are read by the Decision model, so they need --decisions: ${needs.join(', ')}`)
    const seeded = scripts.flatMap(({ script }) => script.conversations.filter(memoryNeedsDecisions).map(c => `${script.set}/${c.id}`)) // memory hook
    if (seeded.length) problems.push(`seeded memory pages are picked and read by the Decision model, so they need --decisions: ${seeded.join(', ')}`)
    const flagged = scripts.flatMap(({ script }) => script.conversations.filter(c => c.draftCheck || Object.keys(c.flags ?? {}).some(k => DECISION_DEPENDENT_FLAGS.includes(k))).map(c => `${script.set}/${c.id} (${[...(c.draftCheck ? ['draftCheck'] : []), ...Object.keys(c.flags ?? {}).filter(k => DECISION_DEPENDENT_FLAGS.includes(k))].join(', ')})`))
    if (flagged.length) problems.push(`these flags act only through the Decision model, so they need --decisions: ${flagged.join('; ')}`)
  }
  return problems
}

/** What a --run would do, as data (nothing is started). */
export function planRun(options, scripts, { env = process.env, buildLaunch = buildCodexAppServerLaunch } = {}) {
  return {
    mode: options.mode, codexBin: options.codexBin,
    home: options.home.kind === 'person' ? { kind: 'person', note: 'CODEX_HOME unset: the person\'s own Codex home and login; the check never reads that folder' } : { kind: 'dir', dir: options.home.dir },
    threads: options.persisted ? { kind: 'persisted-with-cleanup', ledger: path.join(options.out, LEDGER_FILE), note: 'created in the Codex home, deleted with thread/delete and verified gone at the end of each conversation' } : { kind: 'ephemeral' },
    out: options.out, decisions: options.decisions, model: options.model, effort: options.effort, turnTimeoutMs: options.turnTimeoutMs,
    appServer: { argv: [options.codexBin, ...appServerArgs(options, buildLaunch)], env: Object.keys(childEnv(options, env)), perConversation: true, processGroupKill: `SIGTERM, ${KILL_GRACE_MS}ms grace, SIGKILL` },
    rules: [options.persisted ? 'persisted threads, each deleted and verified gone at the end of its conversation (the binary must have thread/delete; the ledger must be clean)' : 'ephemeral threads only (thread/start and thread/fork without ephemeral:true are refused)', 'own tools ON; the engine runs in EG-Desk\'s empty folder', 'scripted approver: yes/no answers sent as the person\'s next message',
      'no retries', `Decision calls only with --decisions (key from ${DECISION_KEY_ENV}), through the run's egress gate`],
    conversations: scripts.flatMap(({ file, script }) => script.conversations.map(c => ({ set: script.set, file, id: c.id, scratch: path.join(options.out, 'scratch', c.id), files: Object.keys(c.folder ?? {}).length,
      flags: { ...(options.decisions ? DEFAULT_DECISION_FLAGS : {}), ...(c.flags ?? {}), EGDESK_OWN_TOOLS: 'on' }, turns: c.turns.map(t => ({ say: clip(t.say, 80), approve: t.approve ?? [], expects: Object.keys(t.expect ?? {}) })) }))),
  }
}

export function formatPlan(plan, warnings = []) {
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
 * runConversation({ options, set, conversation, deps }) → the conversation record. One app-server, one runtime, one scratch folder.
 * deps: { spawn, runnerSpawn, fetchImpl, env, killGroup, now }
 */
export async function runConversation({ options, set, conversation, deps = {} }) {
  const env = deps.env ?? process.env
  const spawn = deps.spawn ?? nodeSpawn
  const killGroup = deps.killGroup ?? createGroupKiller()
  const conversationDir = path.join(options.out, 'data', conversation.id)
  const scratch = path.join(options.out, 'scratch', conversation.id), dataDir = conversationDir
  makeDirs(options.out); makeDirs(path.join(options.out, 'scratch')); makeDirs(path.join(options.out, 'data')); makeDirs(dataDir)
  writeScratch(scratch, conversation.folder)
  // the draft check is the conversation's own opt-in (conversation.draftCheck: { mode, design? }), like memory; explicit flags still win
  const dc = conversation.draftCheck
  const flags = { ...(options.decisions ? DEFAULT_DECISION_FLAGS : {}), ...(dc ? { EGDESK_DRAFT_CHECK: dc.mode, ...(dc.design === 'choice' ? { EGDESK_DRAFT_CHECK_DESIGN: 'choice' } : {}) } : {}), ...(conversation.flags ?? {}), EGDESK_OWN_TOOLS: 'on' }
  const persisted = options.persisted === true, ledger = persisted ? (deps.ledger ?? createLedger(options.out)) : null, createdThreads = []
  const FLAG = { ...flags }
  const hooks = CHECK_HOOKS.filter(h => h.active(FLAG)) // features registered in helper/egdesk-real-engine-hooks.mjs (the briefing flow, ...); attached once the runtime exists
  let attached = []
  const rec = { set, id: conversation.id, flags: FLAG, scratch, startedAt: new Date().toISOString(), phases: {}, requests: [], engine: null, isolation: null, mcpStartup: { starting: 0, ready: 0, failed: 0, other: 0 }, turns: [], aborted: null, ok: false }
  const t0 = performance.now()
  const runnerLog = []
  const runnerSpawn = deps.runnerSpawn ?? nodeSpawn
  const loggedRunnerSpawn = (file, args, opts) => { runnerLog.push(String(args?.at?.(-1) ?? '')); const child = runnerSpawn(file, args, opts); journeyHook.observeCommand(args?.at?.(-1), child); return child } // journey hook: how the command process ends

  // ---- the app-server child ----
  const argv = appServerArgs(options, deps.buildLaunch ?? buildCodexAppServerLaunch)
  const child = spawn(options.codexBin, argv, { cwd: dataDir, env: childEnv(options, env), shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  rec.phases.spawnMs = ms(t0)
  let closed = false, stderrTail = ''
  child.on('close', () => { closed = true; try { rpc.close(Object.assign(new Error('the Codex app-server exited'), { code: 'engine_exited' })) } catch {} })
  child.on('error', error => { rec.aborted ??= `spawn_failed:${error?.code ?? 'error'}` })
  child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-1500) })
  let chat = null, store = null, wiring = null, threadClient = null
  const memoryHook = createMemoryHook(conversation.memory) // memory hook: seeded pages, what the product sent, the memory expectations
  const journeyHook = createJourneyHook() // journey hook: what reached the engine for a message typed into a working run (turn/steer, turn/interrupt)
  const completions = [], tasks = []
  const turnNow = { notifications: [], toolCalls: new Map(), native: { commandExecution: 0, fileChange: 0, approvals: 0 }, items: {}, usage: null, compacted: false, errors: [], decisions: [], draftRows: [] }
  const resetTurnNow = () => { turnNow.notifications.length = 0; turnNow.toolCalls = new Map(); turnNow.native = { commandExecution: 0, fileChange: 0, approvals: 0 }; turnNow.items = {}; turnNow.usage = null; turnNow.compacted = false; turnNow.errors = []; turnNow.decisions = []; turnNow.draftRows = [] }
  let initializeResult = null, lastThreadStart = null
  const rpc = new AppServerRpc({
    send: payload => child.stdin.write(`${payload}\n`), experimentalApi: true, timeoutMs: 60_000,
    onNotification: message => {
      const p = message.params ?? {}
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const type = p.item?.type
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
      if (chat) tasks.push(Promise.resolve(chat.handleNotification(message, 'codex')).catch(() => {}))
    },
    onRequest: message => {
      if (message.method === 'item/tool/call') turnNow.toolCalls.set(message.id, { tool: message.params?.tool, arguments: clip(message.params?.arguments, 1500), result: null })
      else if (/requestApproval$|^applyPatchApproval$|^execCommandApproval$/.test(message.method)) turnNow.native.approvals++
      if (chat) tasks.push(Promise.resolve(chat.handleServerRequest(message, 'codex')).catch(error => turnNow.errors.push(`server_request_failed:${clip(error?.code ?? error?.message, 80)}`)))
    },
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
  const stop = async () => { try { chat?.setConnection?.(false) } catch {} try { rpc.close() } catch {} rec.phases.killed = (await killGroup(child))?.signal ?? null }

  try {
    // ---- initialize, home and version ----
    const t1 = performance.now()
    await rpc.initialize()
    rec.phases.initializeMs = ms(t1)
    const agent = rpc.serverInfo?.userAgent ?? null
    rec.engine = { version: parseCodexUserAgent(agent)?.version ?? null, userAgent: agent ? agent.slice(0, 120) : null, homeMode: options.home.kind, homeMatchesFlag: null }
    if (options.home.kind === 'dir') {
      rec.engine.homeMatchesFlag = initializeResult?.codexHome === options.home.dir || (() => { try { return fs.realpathSync(initializeResult?.codexHome) === fs.realpathSync(options.home.dir) } catch { return false } })()
      if (!rec.engine.homeMatchesFlag) throw Object.assign(new Error('the app-server reports another Codex home than --codex-home'), { code: 'home_mismatch' })
    } else rec.engine.homeMatchesFlag = null

    // ---- the runtime, composed the way codex-bridge-server.mjs composes it ----
    const request = async (method, params) => {
      if (!persisted && (method === 'thread/start' || method === 'thread/fork') && params?.ephemeral !== true) throw Object.assign(new Error('every thread of this check must be ephemeral'), { code: 'ephemeral_required' })
      const start = performance.now()
      memoryHook.observe(method, params) // memory hook
      journeyHook.observe(method, params) // journey hook
      try {
        const result = await rpc.request(method, params)
        rec.requests.push({ method, ms: ms(start) })
        if (method === 'thread/start') { lastThreadStart = result; if (!persisted && result?.thread?.ephemeral !== true) { rec.aborted ??= 'thread_not_ephemeral' } }
        // persisted mode: every thread the engine reports is in the ledger before anything else happens with it (a crash leaves the record of what to delete)
        if (persisted && (method === 'thread/start' || method === 'thread/fork') && typeof result?.thread?.id === 'string') {
          const row = { id: result.thread.id, ephemeral: result.thread.ephemeral === true }; createdThreads.push(row); ledger.append({ op: 'created', via: method, ...row })
        }
        return result
      } catch (error) { rec.requests.push({ method, ms: ms(start), error: String(error?.code ?? 'error').slice(0, 40), message: clip(error?.message ?? '', 300) }); throw error }
    }
    const respond = (id, result, error) => {
      const call = turnNow.toolCalls.get(id)
      if (call) { try { call.result = { success: result?.success ?? null, error: error ? clip(error.message ?? error, 300) : null, text: clip(result?.contentItems?.[0]?.text ?? '', 1500) } } catch {} }
      rpc.respond(id, result, error)
    }
    store = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: `real-engine-check:${conversation.id}` })
    const settingsDir = path.join(dataDir, 'settings')
    const settings = openBridgeSettings({ dataDir: settingsDir, log() {} })
    const calibrationBase = openCalibrationLog({ dataDir: settingsDir, log() {} })
    // the draft check records one calibration row per check (closed words): the check keeps a copy per turn so a script can say whether it ran
    // (the log object is frozen: an inheriting wrapper, not a Proxy, so that only record is replaced)
    const calibrationLog = Object.create(calibrationBase, { record: { value: row => { try { if (row?.feature === 'draft_check') turnNow.draftRows.push({ mode: row.mode ?? null, attached: row.attached === true, fallback: typeof row.fallback === 'string' ? row.fallback : null }) } catch { /* recording only */ } return calibrationBase.record(row) }, enumerable: true } })
    const KEY = options.decisions ? String(env[DECISION_KEY_ENV] ?? '').trim() : null
    const decisionCall = []
    const transport = options.decisions && !deps.fetchImpl ? createDecisionTransport() : null
    const fetchImpl = async (url, init) => {
      const started = performance.now(); let questions = []
      try { questions = JSON.parse(String(init?.body ?? '{}')).questions ?? [] } catch {}
      const response = await (deps.fetchImpl ?? transport.fetch)(url, init)
      const row = { names: questions.map(q => q.name), ms: ms(started), status: response?.status ?? null, inputTokens: null, p: {} }
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
    const ontologyStore = { readGraph: async () => memoryHook.graph() } // memory hook: empty unless the script seeds pages
    const turnMemoryConfig = createTurnMemoryConfig({ settings, ontologyStore, ...turnMemoryFlagsFromEnv(FLAG), getAdapter: () => wikiAdapter ??= createWikiAdapter({ writes: openWikiWrites({ dataDir: settingsDir, log() {} }) }) })
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
      ...(FLAG.EGDESK_CONTEXT_RELEVANCE === 'action' ? { relevanceRules: 'action' } : {}),
      ...(warmup ? { warmup } : {}),
      ...(FLAG.EGDESK_INRUN_MESSAGES === 'on' ? { inRunMessages: { mode: () => 'on' } } : {}),
      calibrationLog, turnMemory: turnMemoryConfig,
      ...(['advisory', 'on'].includes(FLAG.EGDESK_DRAFT_CHECK) ? { draftCheck: { mode: () => FLAG.EGDESK_DRAFT_CHECK, design: () => (FLAG.EGDESK_DRAFT_CHECK_DESIGN === 'choice' ? 'choice' : 'predicates') } } : {}),
      ...(FLAG.EGDESK_CONVERSATION_FLOW === 'on' ? { conversationFlow: { mode: () => 'on' } } : {}),
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
    const needsNative = FLAG.EGDESK_INRUN_MESSAGES === 'on' || conversation.turns.some(t => t.action === 'steer' || t.action === 'delete')
    if (needsNative) {
      try { nativeContract = (deps.inspectNative ?? inspectNativeCapabilities)({ executable: options.codexBin, env: childEnv(options, env), cwd: dataDir }) } catch { nativeContract = null }
      rec.engine.nativeContract = { version: nativeContract?.version ?? null, schemaMatch: nativeContract?.schemaMatch === true, boardPeerContract: typeof nativeContract?.boardPeerContract === 'string', steerContract: typeof nativeContract?.steerContract === 'string', threadDelete: nativeContract?.threadDelete === true }
    }
    chat = new CodexChatRuntime({ request, respond,
      ...(needsNative ? { getBoardPeerContract: () => nativeContract?.boardPeerContract ?? null, getSteerContract: () => nativeContract?.steerContract ?? null, getThreadDelete: () => nativeContract?.threadDelete === true } : {}), emit: () => {}, emitLegacy: () => {}, store, requireStore: true, contexts, getOwnerKey: () => OWNER, verifyFile: async () => null, resolveProjectWorkspace: async () => null,
      ...(FLAG.EGDESK_AGENT_RELOAD_REUSE === 'on' ? { agentReloadReuse: true } : {}), // inert without an Agent-profile conversation (L7 c27)
      toolProviders: wiring.toolProviders, ownTools: wiring.ownTools, decisionContext,
      roomAccount: { mode: () => (FLAG.EGDESK_ROOM_ACCOUNT === 'on' ? 'on' : 'off') } })
    chat.setConnection(true)
    try { chat.setEngineVersion({ engineId: 'codex', userAgent: agent }) } catch {}
    attached = hooks.map(h => h.attach({ chat, contexts, FLAG, conversation, fetchImpl, key: KEY, calibrationLog, requestLog: rec.requests }))
    rec.phases.composedMs = ms(t0)
    // The one registration point for another lane's module (the briefing hook, memory seeding): deps.extensions = [{ name, setup(ctx) → { afterTurn?(record, info), finish?() } }].
    // setup runs once the runtime is composed; afterTurn after every scripted turn record; finish at the end of the conversation (its value is kept in
    // rec.extensions[name]). An extension that throws is recorded as { error } and never stops the check or changes a turn's verdict.
    const extensions = []
    for (const ext of deps.extensions ?? []) {
      try { extensions.push({ name: String(ext.name).slice(0, 40), api: await ext.setup?.({ conversation, options, chat, store, wiring, client, calibrationLog, dataDir, scratch, flags: FLAG, rec, request }) ?? {} }) }
      catch (error) { (rec.extensions ??= {})[String(ext?.name).slice(0, 40)] = { error: clip(error?.code ?? error?.message ?? 'error', 100) } }
    }
    const pushTurn = async record => {
      rec.turns.push(record)
      for (const { name, api } of extensions) { try { await api.afterTurn?.(record, { conversation, index: rec.turns.length - 1 }) } catch (error) { (rec.extensions ??= {})[name] = { error: clip(error?.code ?? error?.message ?? 'error', 100) } } }
    }

    // ---- the scripted turns ----
    let clientThreadId = `check-${conversation.id}`, requestSeq = 0, nativeThread = null, first = true, seen = 0
    const engineFolder = path.join(dataDir, 'engine-folders', 'empty')
    const assistantTexts = () => store.listMessages(clientThreadId, { limit: 200 }).messages.filter(m => m.role === 'assistant').map(m => String(m.text ?? ''))
    // beginTurn sends the person's message and returns at once with the running turn; finishTurn waits for it, then lets the runtime settle.
    const beginTurn = async text => {
      resetTurnNow(); runnerLog.length = 0
      const started = performance.now()
      const run = await chat.send({ message: text, clientThreadId, requestId: `req-${++requestSeq}`, cwd: scratch, ...Object.assign({}, ...attached.map(a => a.sendExtra?.() ?? {})), ...(first ? (persisted ? {} : { stateless: true }) : { conversationId: nativeThread }), ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) })
      first = false; nativeThread = run.conversationId
      return { run, started }
    }
    const finishTurn = async ({ run, started }) => {
      const deadline = started + options.turnTimeoutMs
      let done = null
      while (!done && performance.now() < deadline && !closed && !rec.aborted) { done = completions.find(c => c.threadId === run.conversationId && c.turnId === run.runId); if (!done) await sleep(10) }
      let status = done?.status ?? null
      if (!done) {
        status = closed ? 'engine_exited' : rec.aborted ? 'aborted' : 'timeout'
        if (status === 'timeout') { try { await rpc.request('turn/interrupt', { threadId: run.conversationId, turnId: run.runId }) } catch {} rec.aborted ??= 'turn_timeout' }
      }
      await Promise.allSettled(tasks.splice(0)); try { await chat.queue } catch {} try { await chat.draftCheckIdle() } catch {} await sleep(30); await Promise.allSettled(tasks.splice(0))
      return { run, status, error: done?.error ?? null, latencyMs: ms(started), toolCalls: [...turnNow.toolCalls.values()], items: { ...turnNow.items }, native: { ...turnNow.native }, usage: turnNow.usage, compacted: turnNow.compacted, errors: [...turnNow.errors], decisions: [...turnNow.decisions], draftRows: [...turnNow.draftRows], commandsRan: [...runnerLog] }
    }
    const sendAndWait = async text => finishTurn(await beginTurn(text))
    // a message typed into the working run, afterMs after that turn started; not a turn of its own (the run's turn keeps going)
    const sendInRun = async (ctx, text, afterMs) => {
      const wait = afterMs - (performance.now() - ctx.started)
      if (wait > 0) await sleep(wait)
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
      if (wait > 0) await sleep(wait)
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
    let generation = 0
    const deleteTurn = async (index, turn) => {
      const key = clientThreadId
      let out = null, error = null
      try { out = await chat.forgetConversation({ clientThreadId: key }) } catch (e) { error = String(e?.code ?? e?.message ?? 'error').slice(0, 60) }
      let stored = null, messages = null
      try { stored = Boolean(store.getConversation?.(key)) } catch { stored = null }
      // a conversation the store no longer knows has no message list: listing it throws, which is the answer (0 messages)
      try { messages = store.listMessages(key, { limit: 5 }).messages.length } catch { messages = stored === false ? 0 : null }
      const gone = stored === false && messages === 0
      const summary = out ? { stored, messages, interrupted: out.interrupted ?? 0, history: out.history ?? null, engineHistory: (out.engineHistory ?? []).map(h => ({ state: h.state, reason: h.reason ?? null })) } : null
      const expectations = [{ check: 'action_taken', ok: out?.accepted === true, detail: { error } }, ...checkTurnExpectations(turn.expect ?? {}, { conversationGone: gone, posted: [], toolCalls: [], native: { commandExecution: 0, fileChange: 0, approvals: 0 } })]
      await pushTurn({ index: index + 1, action: 'delete', approve: [], subTurns: [{ action: 'delete', accepted: out?.accepted === true, error, conversationGone: gone, summary }], posted: [], asked: 0, undoRecords: undoCount(), expectations, ok: expectations.every(e => e.ok) })
      clientThreadId = `check-${conversation.id}-${++generation}`; nativeThread = null; first = true; seen = 0
    }

    for (let index = 0; index < conversation.turns.length; index++) {
      if (rec.aborted || closed) break
      const turn = conversation.turns[index], next = conversation.turns[index + 1]
      if (turn.action === 'delete') { await deleteTurn(index, turn); continue }
      // a message turn takes at most one follow-up: a person's message typed into the run (whileRunning), or an engine-level interrupt / steer
      const follow = next?.whileRunning !== undefined ? 'message' : (next?.action === 'interrupt' || next?.action === 'steer') ? next.action : null, withMessage = follow !== null
      const sub = [], ledger = wiring.ledger
      let asked = 0, mark = null
      memoryHook.beginTurn() // memory hook
      const counts = () => messageCounts(store, clientThreadId) // journey hook: the system's own and the Agent's own messages the store holds
      journeyHook.beginTurn({ counts }) // journey hook
      const ctx = await beginTurn(turn.say)
      if (follow === 'message') { mark = await sendInRun(ctx, next.say, next.whileRunning.afterMs); journeyHook.markInRun({ text: next.say, counts }) } // journey hook
      else if (follow) mark = await engineAction(follow, ctx, next)
      sub.push(await finishTurn(ctx))
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
      const flat = {
        hooks: hookRecords, toolCalls: sub.flatMap(s => s.toolCalls), native: sumNative(sub), posted, asked, commandsRan: sub.flatMap(s => s.commandsRan), files: readFiles(turn), undoRecords: undoCount(),
        turnStatus: sub.at(-1).status, compacted: sub.some(s => s.compacted), draftCheckRows: sub.reduce((n, s) => n + (s.draftRows?.length ?? 0), 0),
      }
      const memory = memoryHook.finishTurn(turn.expect?.memory) // memory hook
      const journey = journeyHook.finishTurn({ expect: turn.expect, nextExpect: withMessage ? next.expect : null, latencyMs: sub[0].latencyMs, counts, steerContract: FLAG.EGDESK_INRUN_MESSAGES === 'on' ? typeof nativeContract?.boardPeerContract === 'string' : null }) // journey hook
      const expectations = [...checkTurnExpectations(turn.expect ?? {}, flat), ...memory.expectations, ...journey.expectations]
      const failedRun = s => s.status === 'timeout' || s.status === 'engine_exited'
      await pushTurn({ index: index + 1, say: clip(turn.say, 200), approve: turn.approve ?? [], subTurns: sub.map(s => ({ approver: s.approver ?? null, status: s.status, error: s.error, latencyMs: s.latencyMs, items: s.items, native: s.native, usage: s.usage, compacted: s.compacted, errors: s.errors,
        toolCalls: s.toolCalls, decisions: s.decisions, commandsRan: s.commandsRan, approverUnused: s.approverUnused === true })),
        ...(Object.keys(hookRecords).length ? { hooks: hookRecords } : {}), posted, postedCount: posted.length, finalAnswer: posted.at(-1) ?? null, ...(sub.some(s => s.draftRows?.length) || FLAG.EGDESK_DRAFT_CHECK ? { draftCheck: { rows: sub.flatMap(s => s.draftRows ?? []) } } : {}), asked, undoRecords: flat.undoRecords, ...(memory.record ? { memory: memory.record } : {}), ...(journey.record ? { journey: journey.record } : {}), expectations, ok: expectations.every(e => e.ok) && !sub.some(failedRun) })
      if (withMessage) {
        // the message typed into the run: what happened after it was sent
        const prev = sub[0], after = texts.slice(mark.posted)
        const flat2 = { toolCalls: prev.toolCalls.slice(mark.tools), native: prev.native, posted: after, asked, commandsRan: prev.commandsRan.slice(mark.ran), files: readFiles(next), undoRecords: undoCount(), turnStatus: sub.at(-1).status, compacted: sub.some(s => s.compacted) }
        const implicit = follow === 'message' ? 'sent_while_running' : 'action_taken'
        const expect2 = [{ check: implicit, ok: mark.accepted, detail: { afterMs: mark.afterMs, sentAtMs: mark.sentAtMs, error: mark.error } }, ...checkTurnExpectations(next.expect ?? {}, flat2), ...(follow === 'message' ? journey.nextExpectations : [])] // journey hook
        await pushTurn({ index: index + 2, say: clip(next.say ?? '', 200), approve: [], ...(follow === 'message' ? { whileRunning: { afterMs: mark.afterMs } } : { action: follow, afterMs: mark.afterMs }), subTurns: [{ ...(follow === 'message' ? { whileRunning: true } : { action: follow }), accepted: mark.accepted, error: mark.error, sentAtMs: mark.sentAtMs }],
          posted: after, asked, undoRecords: flat2.undoRecords, expectations: expect2, ok: expect2.every(e => e.ok) && !sub.some(failedRun) })
        index++
      }
    }
    for (const { name, api } of extensions) { try { const value = await api.finish?.(); if (value !== undefined) (rec.extensions ??= {})[name] = value } catch (error) { (rec.extensions ??= {})[name] = { error: clip(error?.code ?? error?.message ?? 'error', 100) } } }
    rec.ok = !rec.aborted && !closed && rec.turns.length === conversation.turns.length && rec.turns.every(t => t.ok)
    rec.decisionCalls = decisionCall.length
  } catch (error) {
    rec.aborted ??= String(error?.code ?? error?.name ?? 'error').slice(0, 60)
    rec.abortDetail = clip(error?.message ?? '', 300)
    if (stderrTail) rec.engineStderrTail = clip(stderrTail.replace(/\s+/g, ' '), 600)
  } finally {
    // persisted mode: the threads this conversation created are deleted and verified gone BEFORE the engine goes, also after an abort
    if (persisted) {
      const ids = createdThreads.filter(t => !t.ephemeral).map(t => t.id)
      try { rec.cleanup = await deleteAndVerify((method, params) => rpc.request(method, params), ids, ledger) }
      catch (error) { rec.cleanup = { persisted: ids.length, deleted: 0, verifiedGone: 0, failures: [{ id: '*', step: 'cleanup', error: clip(error?.message ?? 'error', 200) }] } }
      rec.cleanup.ephemeral = createdThreads.length - ids.length
      if (rec.cleanup.failures.length) { rec.ok = false; rec.cleanupFailed = true }
    }
    await stop()
    try { store?.close() } catch {}
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
  try { native = (deps.inspectNative ?? inspectNativeCapabilities)({ executable: options.codexBin, env: childEnv(options, env), cwd: options.out }) } catch { native = null }
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
  assertCleanupGuaranteed(options, deps, deps.env ?? process.env)
  for (const { script } of scripts) {
    for (const conversation of script.conversations) {
      const rec = await runConversation({ options, set: script.set, conversation, deps })
      records.push(rec)
      const dir = path.join(options.out, 'records', script.set); makeDirs(dir)
      fs.writeFileSync(path.join(dir, `${conversation.id}.json`), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 })
    }
  }
  const summary = { at: new Date().toISOString(), ok: records.every(r => r.ok), conversations: records.map(r => ({ set: r.set, id: r.id, ok: r.ok, aborted: r.aborted, ...(r.cleanup ? { cleanup: { persisted: r.cleanup.persisted, deleted: r.cleanup.deleted, verifiedGone: r.cleanup.verifiedGone, failures: r.cleanup.failures.length } } : {}), turns: r.turns.length, failedChecks: r.turns.flatMap(t => t.expectations.filter(e => !e.ok).map(e => `${t.index}:${e.check}`)), totalMs: r.totalMs })) }
  fs.writeFileSync(path.join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
  return { records, summary, ok: summary.ok }
}

