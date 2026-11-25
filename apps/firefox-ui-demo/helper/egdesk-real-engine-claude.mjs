// c37: the real-engine check with Claude as the engine (--engine claude, helper/egdesk-real-engine-check.mjs). The Codex app-server is not started: EG-Desk's OWN adapter
// (helper/claude-engine-adapter.mjs) drives the installed `claude` exactly as the product does (the CLI keeps its login; EG-Desk never reads a credential; no new auth path).
// This module holds what is specific to that engine and is pure or injectable (the tests use a fake transport, never the CLI):
//   - CLAUDE_FEATURES / claudeApplicability(conversation): per feature of the existing scripts, whether it works on Claude. A conversation that uses a feature Claude does not have is
//     recorded as `not applicable` (named, with the reason) and is never run and never failed.
//   - createUsageGuard: reads the CLI's own rate-limit signals and stops the run at >= 70 % of any window (or on any warning / rejection), recording it.
//   - wrapClaudeAdapter: the adapter seen by the runtime, with the check's own bookkeeping (requests, hooks, tool results, event tap) in between.
//
// What Claude Code 2.1.x exposes about usage, without reading a credential (checked against the Agent SDK reference and the CLI's stream-json, not by running it):
//   - `rate_limit_event` in the stream-json output: { status: allowed | allowed_warning | rejected, rateLimitType: five_hour | seven_day | seven_day_opus | seven_day_sonnet | ..., utilization: 0..1,
//     resetsAt }. The CLI sends it WHEN THE STATE CHANGES (not on every turn), so no event means "nothing known", never "low". EG-Desk's adapter already turns it into usage().windows.
//   - `claude auth status --json` (the static probe the product uses) says who is signed in and how, not how much was used. The /usage screen and the status line are interactive and read the
//     account's usage endpoint with the CLI's own credential: not used here.
// So the guard works from the events the adapter saw (this run) and from a small state file of the last observed windows (--usage-state), and it says `unknown` honestly when there is no signal.

export const CLAUDE_ENGINE = 'claude'
export const CLAUDE_USAGE_STOP_PERCENT = 70
export const CLAUDE_DEFAULT_MAX_CONVERSATIONS = 3
export const CLAUDE_MAX_CONVERSATIONS_LIMIT = 50

/**
 * The inventory. status: 'supported' (the adapter has the capability), 'untested' (it should work through the same runtime, not proven on Claude: the first real run decides),
 * 'notApplicable' (Claude has no such thing: the conversation is skipped, never failed). `uses(conversation)` says whether a conversation depends on the feature.
 */
const turnsOf = c => (Array.isArray(c?.turns) ? c.turns : [])
const hasAction = (c, action) => turnsOf(c).some(t => t?.action === action)
const hasExpect = (c, key) => turnsOf(c).some(t => t?.expect && Object.hasOwn(t.expect, key))
export const CLAUDE_FEATURES = Object.freeze([
  { feature: 'EG-Desk tools offered through the adapter (egdesk_run_command, file tools, browser, ...)', status: 'untested', why: 'capability dynamicTools: the providers that support Claude are an in-process MCP server of the adapter; the command tool reached the adapter in the fake test, a real CLI has not been seen to call it', uses: () => false },
  { feature: 'own-tools mode: EG-Desk\'s runner as the engine\'s only shell, the engine in an empty folder, action first (EGDESK_DECISION_FIRST), undo records', status: 'notApplicable', why: 'the runtime turns own tools on only for the Codex engine (ownTools = engine.id codex): on Claude there is no neutral folder, no pre-run command and no action-first path', uses: c => Object.hasOwn(c?.flags ?? {}, 'EGDESK_DECISION_FIRST') || hasExpect(c, 'decisionFirst') || hasExpect(c, 'undo') || hasExpect(c, 'edited') },
  { feature: 'command and file-change approvals', status: 'supported', why: 'capabilities approvals.command and approvals.fileChange (the permission broker); other tools that would ask are refused', uses: () => false },
  { feature: 'interrupt', status: 'supported', why: 'capability interrupt (a control request, with a backstop)', uses: () => false },
  { feature: 'timing (first event, first progress, rounds, tool time)', status: 'supported', why: 'the adapter translates the stream into the same events; the check taps them', uses: () => false },
  { feature: 'usage windows', status: 'supported', why: 'capability usage.rateLimits (rate_limit_event); the usage guard reads it', uses: () => false },
  { feature: 'engine stall watchdog', status: 'untested', why: 'it reads the translated events; the real CLI\'s silence shape is not known', uses: c => Object.hasOwn(c?.flags ?? {}, 'EGDESK_ENGINE_STALL_FIRST_EVENT_MS') || hasExpect(c, 'engineStall') },
  { feature: 'draft check, revise and heartbeat writer (private turns on a fork or a fresh thread)', status: 'untested', why: 'threadFork is not offered; the runtime falls back to a fresh thread, which costs a real Claude turn each', uses: c => Boolean(c?.draftCheck) || Object.hasOwn(c?.flags ?? {}, 'EGDESK_DRAFT_CHECK') || hasExpect(c, 'draftCheck') },
  { feature: 'Agent-profile direct room', status: 'untested', why: 'the room is EG-Desk\'s own; the engine side is the same adapter', uses: c => Boolean(c?.agentProfile) },
  { feature: 'steer (a plain message into a working turn)', status: 'notApplicable', why: 'the adapter has no steerTurn: a message sent into a working turn is not steered on Claude', uses: c => hasAction(c, 'steer') || Object.hasOwn(c ?? {}, 'alongside') || turnsOf(c).some(t => Object.hasOwn(t ?? {}, 'alongside')) || c?.flags?.EGDESK_INRUN_MESSAGES === 'on' },
  { feature: 'thread delete and engine-history proof (thread/delete, thread/resume fails)', status: 'notApplicable', why: 'no capability nativeHistory or thread/delete: the CLI keeps its own session files; EG-Desk can only remove them behind a developer flag', uses: c => hasAction(c, 'delete') || hasExpect(c, 'deleted') },
  { feature: 'restart of the engine and the bridge, then resume', status: 'notApplicable', why: 'the restart turn tears down the Codex app-server and its saved thread; a Claude process per conversation has no such step in the check', uses: c => hasAction(c, 'restart') },
  { feature: 'ephemeral threads and verified cleanup of persisted threads', status: 'notApplicable', why: 'capability ephemeralThreads is not offered: the CLI writes its own session files; the record lists the session ids so they can be removed', uses: () => false },
  { feature: 'fork of a thread (product-like fork, rewrite on a fork)', status: 'notApplicable', why: 'capability threadFork is not offered', uses: c => Object.hasOwn(c ?? {}, 'fork') || turnsOf(c).some(t => Object.hasOwn(t ?? {}, 'fork')) },
  { feature: 'Codex app-server configuration probes (pure engine, mcp status, native contract)', status: 'notApplicable', why: 'these read the Codex app-server\'s own configuration and generated schema', uses: c => Object.hasOwn(c?.flags ?? {}, 'EGDESK_OWN_TOOLS_PURE') || Object.hasOwn(c ?? {}, 'pureEngine') },
])

/** → { applicable: boolean, notApplicable: [{ feature, why }], untested: [{ feature, why }] } for one conversation of a script. */
export function claudeApplicability(conversation) {
  const used = status => CLAUDE_FEATURES.filter(f => f.status === status && f.uses(conversation)).map(({ feature, why }) => ({ feature, why }))
  const notApplicable = used('notApplicable'), untested = used('untested')
  return { applicable: notApplicable.length === 0, notApplicable, untested }
}

/** The whole inventory as plain data (the plan and the report print it). */
export const claudeInventory = () => CLAUDE_FEATURES.map(({ feature, status, why }) => ({ feature, status, why }))

// ---- the usage guard ----
const WINDOW_NAMES = Object.freeze(['fiveHour', 'weekly', 'weeklyOpus', 'weeklySonnet', 'weeklyIncluded'])
const pct = value => (Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value)) * 10) / 10 : null)

/** The adapter's usage() row → [{ window, usedPercent (0-100 or null), resetsAt (epoch ms or null), status }]. Closed names only. */
export function windowsFromUsage(row) {
  const list = Array.isArray(row?.windows) ? row.windows : []
  return list.filter(w => w && typeof w.window === 'string' && WINDOW_NAMES.includes(w.window)).map(w => ({
    window: w.window, usedPercent: pct(w.usedPercent), resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null, status: ['allowed', 'allowed_warning', 'rejected'].includes(w.status) ? w.status : null,
  }))
}

/**
 * createUsageGuard({ readUsage, stopAtPercent, state, requireSignal, now })
 *   readUsage()  → the adapter's usage() row or null (what the CLI's rate_limit_events told this run)
 *   state        { read() → rows | null, write(rows) } the last observed windows of an earlier run (optional file, see fileUsageState)
 * assess(phase) → { ok, stop, reason, phase, windows: [...], unknown, at }:
 *   a window at or above stopAtPercent, an allowed_warning or rejected status, or a remembered window of an earlier run that has not reset yet and is at or above the stop → stop.
 *   No signal at all → ok with unknown: true (nothing is known, which is not "low"); with requireSignal the run stops after the first conversation when there still is none.
 */
export function createUsageGuard({ readUsage = () => null, stopAtPercent = CLAUDE_USAGE_STOP_PERCENT, state = null, requireSignal = false, now = Date.now } = {}) {
  const log = []
  const remembered = () => { try { return Array.isArray(state?.read?.()) ? state.read() : [] } catch { return [] } }
  const live = () => { try { return windowsFromUsage(readUsage()) } catch { return [] } }
  const check = (windows, at) => {
    const bad = windows.find(w => w.status === 'rejected') ?? windows.find(w => w.usedPercent !== null && w.usedPercent >= stopAtPercent) ?? windows.find(w => w.status === 'allowed_warning')
    if (!bad) return null
    return bad.status === 'rejected' ? 'limit_rejected' : bad.usedPercent !== null && bad.usedPercent >= stopAtPercent ? 'window_at_or_above_stop' : 'limit_warning'
  }
  return {
    stopAtPercent,
    /** conversationsDone: how many conversations this run has finished (the first one is allowed to be blind unless an earlier run's state says otherwise). */
    assess(phase, { conversationsDone = 0 } = {}) {
      const at = now()
      const fresh = live(), old = remembered().filter(w => !(Number.isFinite(w?.resetsAt) && w.resetsAt <= at))
      const freshNames = new Set(fresh.map(w => w.window))
      const windows = [...fresh, ...old.filter(w => !freshNames.has(w.window))]
      const reason = check(windows, at) ?? (requireSignal && conversationsDone > 0 && windows.every(w => w.usedPercent === null) ? 'no_usage_signal' : null)
      const out = { ok: reason === null, stop: reason !== null, reason, phase, windows, unknown: windows.length === 0, stopAtPercent, at: new Date(at).toISOString() }
      log.push({ phase, ok: out.ok, reason, unknown: out.unknown, windows: windows.map(w => ({ window: w.window, usedPercent: w.usedPercent, status: w.status })) })
      if (log.length > 200) log.shift()
      return out
    },
    /** Remember what this run saw for the next run (only windows with a number or a status). */
    persist() { try { const rows = live().filter(w => w.usedPercent !== null || w.status); if (rows.length) state?.write?.(rows) } catch { /* the state file is advisory */ } },
    log: () => log.map(row => ({ ...row })),
  }
}

/** A small JSON file for the last observed windows. The file holds numbers and window names only (mode 0600). */
export function fileUsageState(file, fsApi) {
  return {
    read() { try { const v = JSON.parse(fsApi.readFileSync(file, 'utf8')); return Array.isArray(v?.windows) ? windowsFromUsage({ windows: v.windows }) : null } catch { return null } },
    write(rows) { fsApi.writeFileSync(file, `${JSON.stringify({ observedAt: new Date().toISOString(), windows: windowsFromUsage({ windows: rows }) }, null, 2)}\n`, { mode: 0o600 }) },
  }
}

// ---- the adapter as the runtime sees it, with the check's bookkeeping in between ----
const notApplicable = method => Object.assign(new Error(`${method} is not applicable on Claude (no such engine request)`), { code: 'not_applicable_on_claude' })

/**
 * wrapClaudeAdapter({ adapter, request, respond, tapNotification, tapRequest })
 *   request(method, params)  the check's own request function (bookkeeping, hooks, timing) which in Claude mode ends in claudeRequest(adapter)
 *   respond(id, result, error) the check's own respond (tool results are kept for the record) which ends in adapter.respond
 *   tapNotification / tapRequest  the check's event bookkeeping, called before the runtime sees the event
 */
export function wrapClaudeAdapter({ adapter, request, respond, tapNotification, tapRequest }) {
  const wrapped = Object.create(adapter)
  Object.assign(wrapped, {
    startThread: params => request('thread/start', params),
    startTurn: params => request('turn/start', params),
    interruptTurn: (threadId, turnId) => request('turn/interrupt', { threadId, turnId }),
    respond: (rpcId, result, error) => respond(rpcId, result, error),
    subscribe: sink => adapter.subscribe({
      notification: (id, message) => { try { tapNotification(message) } catch { /* recording only */ } return sink.notification?.(id, message) },
      serverRequest: (id, message) => { try { tapRequest(message) } catch { /* recording only */ } return sink.serverRequest?.(id, message) },
      connection: (id, state) => sink.connection?.(id, state),
    }),
  })
  return wrapped
}

/** The check's `rpc.request` in Claude mode: the same method names the check and its hooks already use, answered by the adapter. */
export function claudeRequest(adapter) {
  return async (method, params) => {
    if (method === 'thread/start') return adapter.startThread(params)
    if (method === 'turn/start') return adapter.startTurn(params)
    if (method === 'turn/interrupt') return adapter.interruptTurn(params?.threadId, params?.turnId)
    throw notApplicable(method)
  }
}

/** Options for --engine claude, validated (pure). */
export function validateClaudeOptions(options) {
  const errors = []
  if (options.engine !== 'claude') return errors
  if (options.persisted) errors.push('--persisted-with-cleanup is a Codex thread cleanup: not with --engine claude')
  if (options.maxConversations !== null && !(Number.isInteger(options.maxConversations) && options.maxConversations >= 1 && options.maxConversations <= CLAUDE_MAX_CONVERSATIONS_LIMIT)) errors.push(`--max-conversations is 1-${CLAUDE_MAX_CONVERSATIONS_LIMIT}`)
  if (!(options.usageStopPercent >= 1 && options.usageStopPercent <= 100)) errors.push('--usage-stop is 1-100 (percent)')
  return errors
}
