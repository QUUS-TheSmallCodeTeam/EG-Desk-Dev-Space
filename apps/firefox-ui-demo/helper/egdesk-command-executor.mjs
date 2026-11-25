import path from 'node:path'
import { classifyCommand } from './egdesk-terminal-command-gate.mjs'
import { terminalFactRow } from './egdesk-terminal-judge.mjs'
import { judgeHealth, judgeWorktree } from './egdesk-run-conditions.mjs'

// EG-Desk's own command tool (c17 prototype, flag default off). Owner decision (2026-11-25): Codex is used as a pure model engine;
// running commands, and the approval in front of them, is EG-Desk's own function (as in OpenCode, whose shell tool asks the
// permission service before it spawns: packages/core/src/tool/plugin/shell.ts), and nothing depends on Codex's configuration
// layers (user/project .codex, CODEX_HOME), so that profile, subscription account, folder and screen combine freely.
//
// The engine asks for a command as a dynamic tool call (app-server item/tool/call, DynamicToolCallParams { threadId, turnId,
// callId, tool, arguments }); EG-Desk answers with a DynamicToolCallResponse { success, contentItems }. Before anything runs:
//   1. the approval ledger (egdesk-gate-hook-broker.mjs, reused: it never depended on the hook) applies the rule floor (R5), then the
//      content predicates (R2, through the run's own gate and egress), then the one-time approvals the person gave in the
//      conversation (read as yes/no predicates from their next message), one question at a time;
//   2. a risky command is NOT run: the tool result tells the model to ask the person in the chat (U4: run / cancel / give context,
//      worded by the model), and to call the tool again with exactly the same command after a yes;
//   3. a harmless or approved command runs through the injected runner, in the folder EG-Desk resolved for this run (never the Codex
//      thread's cwd), and its result goes back to the model; terminal facts in the c10 row shape are published while it waits,
//      runs and ends.
// Identity: the ledger keys by conversation and turn and by the exact command in its folder. Nothing here reads an engine profile,
// a subscription account, CODEX_HOME or a screen, so an approval belongs to the conversation/run and the person who gave it.
//
// No sandbox: EG-Desk's runner is not Codex's sandbox. So a command that changes or sends something and could not be judged (no
// Decision key, Decision off, a model error) is NOT run without the person either (stricter than the approval-card path, where
// Codex's sandbox still bounded such a command).
export const COMMAND_EXECUTOR_PROVIDER_ID = 'egdesk-command' // provisional internal id (not shown to the person)
export const COMMAND_TOOL_NAME = 'egdesk_run_command' // provisional; model-facing, needs owner approval before it ships
export const COMMAND_EXECUTOR_LIMITS = Object.freeze({ commandChars: 8000, outputChars: 12000, timeoutMs: 120_000, maxTimeoutMs: 600_000 })
export const COMMAND_TOOL_SPECS = Object.freeze([Object.freeze({
  type: 'function', name: COMMAND_TOOL_NAME,
  description: 'Run one shell command in the folder of this conversation. EG-Desk checks the command first: a command that cannot be undone or that sends something out is not run until the person agrees in the conversation; you then call this tool again with exactly the same command. Prefer this tool for every command.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['command'], properties: {
    command: { type: 'string', description: 'The exact command line.' },
    cwd: { type: 'string', description: 'Optional folder inside the conversation folder, relative to it.' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: COMMAND_EXECUTOR_LIMITS.maxTimeoutMs, description: 'Optional time limit in ms.' },
  } },
})])

const respond = (success, value) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] })
const tail = (text, max) => (typeof text === 'string' ? (text.length > max ? { text: text.slice(-max), truncated: true } : { text, truncated: false }) : { text: '', truncated: false })

/** The judgement the ledger uses here: the runtime's gate, and a destructive command that could not be judged needs the person. */
export function executorAssess(runtimeAssess, { home } = {}) {
  return async args => {
    let assessed = null
    try { assessed = typeof runtimeAssess === 'function' ? await runtimeAssess(args) : null } catch { assessed = null }
    if (assessed?.approval === true) return assessed
    if (assessed?.source === 'decision') return assessed // decided harmless by the predicates
    const { destructive } = classifyCommand(args.command, { cwd: args.cwd, home })
    return destructive ? { approval: true, reasons: ['risk_unsure'], source: 'unjudged' } : assessed
  }
}

/**
 * createCommandExecutorProvider({ mode, ledger, workspaceOf, runner, onFacts?, limits? })
 *   mode() → 'off' | 'on'      off: no tool is offered and a call is refused (nothing runs)
 *   ledger                     createGateHookBroker(...) shared with the runtime (terminalGate.hookBroker: turn lifecycle, reply reading)
 *   workspaceOf(run) → '/abs'  the folder EG-Desk resolved for this run (Board/project binding), or null
 *   runner({ command, cwd, timeoutMs, signal }) → { exitCode, stdout, stderr, timedOut }   injected; absent → nothing can run
 *   onFacts(run, row)          terminal facts (terminalFactRow shape). c18: kind 'engine' (the engine asked for this command), so the row
 *                              carries runningMs and exitCode; at the gate asking: true (EG-Desk asks the person itself)
 *   outputFor(run) → { append(itemId, text), complete(itemId) }   the run output store adapter for long output (optional)
 *   c21 conditions (egdesk-run-conditions.mjs): after a command ends, its build/test health (exit status + the runner's summary line)
 *   and, with gitStatus(cwd) → porcelain text, the worktree state. ask(run, request) is the auxiliary yes/no predicate on the output tail
 *   (only when the structured fact is missing; it can only lower health). onConditions(run, record) feeds the runtime's terminal facts.
 */
export function createCommandExecutorProvider({ mode = () => 'off', ledger = null, workspaceOf = () => null, runner = null, onFacts = () => {}, outputFor = () => null,
  ask = null, gitStatus = null, onConditions = () => {}, limits = {} } = {}) {
  const L = { ...COMMAND_EXECUTOR_LIMITS, ...limits }
  const on = () => { try { return mode() === 'on' } catch { return false } }
  const facts = (run, row) => { try { onFacts(run, row) } catch { /* facts are advisory */ } }
  const calls = new Map()
  const running = new Map() // run key -> Set of AbortController: commands that are running now (c25: the person stopping the run stops them)
  const runKey = run => String(run?.answerId ?? run?.runId ?? '')
  const stopPending = new Map() // clientThreadId (or conversation id) -> Set of promises: commands that were told to stop and have not been recorded yet (c27)
  const roomKey = run => String(run?.clientThreadId ?? run?.conversationId ?? '')
  return {
    providerId: COMMAND_EXECUTOR_PROVIDER_ID,
    runtime: null,
    specs() { return on() ? COMMAND_TOOL_SPECS : [] },
    dispatch(run, event) {
      const key = `${run?.answerId ?? run?.runId ?? ''}/${event?.callId ?? ''}`
      if (event?.callId && calls.has(key)) return calls.get(key) // the same native call delivered twice runs once
      const work = this.execute(run, event)
      if (event?.callId) { calls.set(key, work); while (calls.size > 256) calls.delete(calls.keys().next().value) }
      return work
    },
    /**
     * c25 (owner decision: the person's "stop" stops the command): the runtime calls this when a run is interrupted, ends or is deleted. Every command this run has
     * running gets an abort signal: the runner sends SIGTERM to the process group, then SIGKILL after its grace period, exactly as for the time limit.
     */
    cancelRun(run) {
      const set = running.get(runKey(run))
      if (!set) return
      const room = roomKey(run)
      for (const controller of [...set]) {
        if (controller.settled && room) {
          const pending = stopPending.get(room) ?? new Set(); stopPending.set(room, pending)
          const tracked = controller.settled.then(() => { pending.delete(tracked); if (pending.size === 0 && stopPending.get(room) === pending) stopPending.delete(room) })
          pending.add(tracked)
        }
        try { controller.abort() } catch { /* already aborted */ }
      }
    },
    /**
     * c27: resolves when every command of this room that was told to stop has been recorded (its fact is in place for the next turn), at once when there is none. The runtime
     * waits for it, bounded, before it builds the next turn: a message sent right after "stop" must still be told what happened to the command.
     */
    stopSettled(room) { const pending = stopPending.get(String(room ?? '')); return pending && pending.size ? Promise.all([...pending]).then(() => undefined) : null },
    async execute(run, event) {
      if (event?.namespace || event?.tool !== COMMAND_TOOL_NAME) return respond(false, { error: { code: 'COMMAND_TOOL_UNKNOWN' } })
      if (!on()) return respond(false, { error: { code: 'COMMAND_EXECUTOR_OFF' } })
      if (run?.executionPolicy) return respond(false, { error: { code: 'COMMAND_FORBIDDEN' } }) // bounded/QA runs never execute
      const args = event.arguments && typeof event.arguments === 'object' ? event.arguments : {}
      const command = typeof args.command === 'string' ? args.command : ''
      if (!command.trim() || command.length > L.commandChars) return respond(true, { status: 'invalid', code: 'COMMAND_INVALID' })
      let root = null
      try { root = workspaceOf(run) } catch { root = null }
      if (typeof root !== 'string' || !path.isAbsolute(root)) return respond(true, { status: 'no_folder', code: 'COMMAND_NO_FOLDER' })
      const cwd = path.resolve(root, typeof args.cwd === 'string' && args.cwd ? args.cwd : '.')
      if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) return respond(true, { status: 'invalid', code: 'COMMAND_CWD_OUTSIDE' })
      if (!ledger?.check) return respond(false, { error: { code: 'COMMAND_GATE_UNAVAILABLE' } })
      let decision
      try { decision = await ledger.check({ sessionId: run.conversationId, turnId: run.runId, cwd, command }) } catch { decision = null }
      if (decision?.decision === 'deny') {
        let gate = null
        try { gate = JSON.parse(decision.note).egdesk_command_gate } catch { gate = { status: 'needs_person' } }
        facts(run, terminalFactRow({ kind: 'engine', running: false, started: false, asking: gate.status === 'needs_person' }))
        return respond(true, { ...gate, executed: false })
      }
      if (!decision || (decision.decision !== 'allow' && decision.decision !== 'none')) return respond(false, { error: { code: 'COMMAND_GATE_UNAVAILABLE' } })
      if (typeof runner !== 'function') return respond(false, { error: { code: 'COMMAND_RUNNER_UNAVAILABLE' } })
      // the person stopped the run while the command waited for the gate: nothing is started
      if (run?.stopRequested === true) { facts(run, terminalFactRow({ kind: 'engine', running: false, started: false })); return respond(true, { status: 'stopped', stopped: true, executed: false }) }
      const timeoutMs = Number.isSafeInteger(args.timeoutMs) && args.timeoutMs > 0 ? Math.min(args.timeoutMs, L.maxTimeoutMs) : L.timeoutMs
      facts(run, terminalFactRow({ kind: 'engine', running: true, runningMs: 0 }))
      let result, output = null
      try { output = outputFor(run) } catch { output = null }
      // the runner enforces the hard limit itself (SIGTERM, then SIGKILL); a soft notice only updates the facts
      const controller = new AbortController(), key = runKey(run)
      controller.settled = new Promise(resolve => { controller.markSettled = resolve }) // resolved when this command's record has been handed to onConditions
      if (!running.has(key)) running.set(key, new Set())
      running.get(key).add(controller)
      try { result = await runner({ command, cwd, timeoutMs, signal: controller.signal, itemId: `egdesk-cmd:${event.callId ?? ''}`, output, approved: decision.decision === 'allow',
        onFacts: row => { if (row?.softNotice) facts(run, terminalFactRow({ kind: 'engine', running: true, runningMs: row.runningMs })) } }) }
      catch { facts(run, terminalFactRow({ kind: 'engine', running: false })); controller.markSettled(); return respond(false, { error: { code: 'COMMAND_RUN_FAILED' } }) }
      finally { const set = running.get(key); set?.delete(controller); if (set && set.size === 0) running.delete(key) }
      const stopped = result?.aborted === true || (controller.signal.aborted && result?.exitCode === null && result?.timedOut !== true)
      const exitCode = Number.isSafeInteger(result?.exitCode) ? result.exitCode : null
      const tailText = [result?.stdout, result?.stderr].filter(t => typeof t === 'string' && t).join('\n')
      const askRun = typeof ask === 'function' ? request => ask(run, request) : null
      let health = null, worktree = null
      // a stopped command is never judged by its output: whatever it printed before it was stopped says nothing about whether it worked
      if (stopped) health = { health: 'unknown', reasons: ['stopped'], summary: null }
      else try { health = await judgeHealth({ exitCode: result?.timedOut ? null : exitCode, output: tailText, command, ask: askRun }) } catch { health = null }
      if (typeof gitStatus === 'function') {
        let porcelain = null
        try { porcelain = await gitStatus(cwd) } catch { porcelain = null }
        try { worktree = await judgeWorktree({ porcelain: typeof porcelain === 'string' ? porcelain : null, output: tailText, command, ask: askRun }) } catch { worktree = null }
      }
      try { onConditions(run, { exitCode, durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null, health, worktree, command: command.slice(0, 300), ...(stopped ? { stopped: true, signal: typeof result?.signal === 'string' ? result.signal : null, outputTail: tailText.slice(-1000) } : {}) }) } catch { /* facts are advisory */ }
      controller.markSettled()
      // the c10 row keeps runningMs only while running; the ended row adds how long it ran (an extra field, the row shape is unchanged)
      facts(run, { ...terminalFactRow({ kind: 'engine', running: false, exitCode }), ...(Number.isFinite(result?.durationMs) ? { durationMs: result.durationMs } : {}), ...(stopped ? { stopped: true } : {}) })
      const out = tail(result?.stdout, L.outputChars), err = tail(result?.stderr, Math.floor(L.outputChars / 3))
      const conditions = {
        ...(health ? { health: health.health, healthReasons: health.reasons } : {}),
        ...(health?.summary ? { tests: { runner: health.summary.runner, passed: health.summary.passed, failed: health.summary.failed, total: health.summary.total, line: health.summary.line } } : {}),
        ...(worktree ? { worktree: { state: worktree.state, ...(Number.isSafeInteger(worktree.conflicts) ? { conflicts: worktree.conflicts, uncommitted: worktree.uncommitted, untracked: worktree.untracked } : {}) } } : {}),
      }
      if (stopped) return respond(true, { status: 'stopped', stopped: true, executed: true, approvedOnce: decision.decision === 'allow', exitCode, signal: typeof result?.signal === 'string' ? result.signal : null, ...conditions,
        ...(Number.isFinite(result?.durationMs) ? { durationMs: result.durationMs } : {}), stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated })
      return respond(true, { status: 'ran', approvedOnce: decision.decision === 'allow', exitCode, timedOut: result?.timedOut === true, ...conditions,
        ...(Number.isFinite(result?.durationMs) ? { durationMs: result.durationMs } : {}),
        stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated })
    },
  }
}

/**
 * thread/start overrides that leave Codex a model only (not wired; owner decision): its own command tools off, no web search, no
 * image reads, no AGENTS.md reads, a read-only sandbox and no approval prompts (so apply_patch, which no config switch removes at
 * a0d5b0a6, cannot write and never asks). Sources: codex-rs features/src/lib.rs (shell_tool, unified_exec, view_image),
 * core/src/tools/spec_plan.rs:1194-1230 and :1390-1393, core/config.schema.json (web_search, project_doc_max_bytes).
 */
export function pureEngineThreadOverrides() {
  return { sandbox: 'read-only', approvalPolicy: 'never',
    config: { features: { shell_tool: false, unified_exec: false, view_image: false }, web_search: 'disabled', project_doc_max_bytes: 0 } }
}
