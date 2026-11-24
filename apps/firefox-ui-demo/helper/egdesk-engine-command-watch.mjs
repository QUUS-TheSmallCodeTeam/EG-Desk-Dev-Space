import { createHash } from 'node:crypto'
import { enumerateLogBlocks, judgeTerminalState, pickRelevantBlocks, stateResponse, terminalFactRow } from './egdesk-terminal-judge.mjs'

// Terminal state judge on the engine's OWN command executions (advisory; flag default off).
//
// What it watches: the commands a run's engine (Codex, Claude) executes itself, as the bridge already sees them:
//   item/started (commandExecution) → a command began; item/commandExecution/outputDelta → output arrived;
//   item/completed (commandExecution) → it ended, with an exit code (Codex) or only a failed/completed status (Claude).
// The output text is NOT kept here. It is read, when a check runs, from the run's in-memory output store
// (codex-run-outputs.mjs: bounded head + tail, redacted on read) that the screen's "command output" view already uses.
// A Terminal card (the person's own shell) is a different thing and is not watched here.
//
// Check points, no polling loop: (1) one one-shot timer armed by an output event, firing when the output has been quiet
// for quietMs (a waiting prompt is exactly "output, then silence"); (2) the command's completion; (3) a beat of the
// conversation's live-session heartbeat when there is one. A check never blocks the event that caused it.
//
// Advisory only: the judge is asked and what the system WOULD do is recorded (content-free). Nothing is typed, interrupted,
// injected or shown. EG-Desk has no input channel into an engine's command, so "hand yes/no / password / pager to the human"
// means "the person would be told", not "an answer would be typed".
//
// Egress: kind `command_output` through the run's shared gate (egdesk-decision-egress.mjs): the output of commands this
// run's engine executed, which the run's model already receives; closed by an Agent tool ceiling of terminal none.
// Cost bounds: an exit-0 command without a failure mark is settled by rule (no request); the same quiet tail is judged
// once; at most judgmentsPerCommand checks per running command and requestsPerRun Decision requests per run.
export const ENGINE_COMMAND_FLAGS = Object.freeze(['off', 'advisory'])
export const ENGINE_COMMAND_WATCH_LIMITS = Object.freeze({ quietMs: 1500, tailChars: 4000, outputChars: 24000, judgmentsPerCommand: 4, requestsPerRun: 12,
  commandsPerRun: 24, maxRuns: 32, trail: 80, deadlineMs: 1500 })
const FAILURE_MARK = /(?:not ok|✖|FAIL\b|AssertionError|Traceback|panicked at|error TS\d+|\bError:|\berror\b[:\[]|npm ERR!|command not found|Permission denied|fatal:)/i

const wouldOf = response => {
  switch (response.action) {
    case 'handoff_human': return response.input === 'yes_no' ? 'hand_yes_no' : response.input === 'secret' ? 'hand_secret' : 'hand_close_pager'
    case 'report': return 'report'
    case 'repair': return 'repair'
    case 'handoff_subjective': return 'hand_subjective'
    default: return 'wait'
  }
}
const hashOf = text => createHash('sha256').update(text).digest('hex').slice(0, 16)

/**
 * createEngineCommandWatch({ flag, decision, readOutput, egressFor, setTimer, clearTimer, monotonicNow, limits })
 *   flag(): 'off' | 'advisory' (anything else is off)
 *   decision: { mode(), configured(), client, calibrationLog } or null
 *   readOutput(runKey, itemId): { head, tail, omittedBytes } | null — the run's retained command output (already redacted)
 *   egressFor(runKey): the run's shared egress gate, or null (then no text is sent)
 */
export function createEngineCommandWatch({ flag = () => 'off', decision = null, readOutput = () => null, egressFor = () => null,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle), monotonicNow = () => performance.now(), limits = {} } = {}) {
  const max = { ...ENGINE_COMMAND_WATCH_LIMITS, ...limits }
  const runs = new Map() // runKey -> { engine, commands: Map(itemId -> command), done, failed, requests }
  const trail = []
  const jobs = new Set()

  const on = () => { try { return flag() === 'advisory' } catch { return false } }
  const idOf = value => (typeof value === 'string' && value && value.length <= 300 ? value : null)
  const judgeMode = () => {
    try {
      const mode = decision?.mode?.()
      return decision?.configured?.() === true && (mode === 'advisory' || mode === 'on') && decision.client ? 'advisory' : 'off'
    } catch { return 'off' }
  }
  const gateOf = runKey => { try { return egressFor(runKey) ?? null } catch { return null } }
  const runOf = (runKey, engine = null) => {
    let run = runs.get(runKey)
    if (!run) {
      run = { engine: engine === 'claude' ? 'claude' : 'codex', commands: new Map(), done: 0, failed: 0, requests: 0, last: null }
      runs.set(runKey, run)
      while (runs.size > max.maxRuns) drop(runs.keys().next().value)
    }
    return run
  }
  const commandOf = (run, itemId) => {
    let command = run.commands.get(itemId)
    if (!command) {
      command = { itemId, startedAt: monotonicNow(), lastOutputAt: null, done: null, judged: null, judgedKey: null, judgments: 0, timer: null, busy: false, rev: 0 }
      run.commands.set(itemId, command)
      while (run.commands.size > max.commandsPerRun) { const [oldest, old] = run.commands.entries().next().value; disarm(old); run.commands.delete(oldest) }
    }
    return command
  }
  const disarm = command => { if (command.timer != null) { try { clearTimer(command.timer) } catch { /* ignore */ } command.timer = null } }
  function drop(runKey) {
    const run = runs.get(runKey)
    if (!run) return
    for (const command of run.commands.values()) disarm(command)
    runs.delete(runKey)
  }
  const outputOf = (runKey, itemId) => {
    let kept = null
    try { kept = readOutput(runKey, itemId) } catch { kept = null }
    if (!kept) return ''
    const head = typeof kept.head === 'string' ? kept.head : '', tail = typeof kept.tail === 'string' ? kept.tail : ''
    return (kept.omittedBytes > 0 ? `${head}\n[…]\n${tail}` : head + tail).slice(-max.outputChars)
  }
  const arm = (runKey, command) => {
    disarm(command)
    if (command.done || command.judgments >= max.judgmentsPerCommand) return
    command.timer = setTimer(() => { command.timer = null; launch(runKey, command.itemId, 'quiet') }, max.quietMs)
    command.timer?.unref?.()
  }

  async function check(runKey, itemId, reason) {
    if (!on()) return null
    const run = runs.get(runKey), command = run?.commands.get(itemId)
    if (!command || command.busy) return null
    const alive = command.done === null
    const at = monotonicNow()
    const quietMs = Math.max(0, at - (command.lastOutputAt ?? command.startedAt))
    const output = outputOf(runKey, itemId)
    const tail = output.slice(-max.tailChars)
    const key = `${alive}|${command.done?.exitCode ?? ''}|${command.done?.failed ?? ''}|${hashOf(tail)}`
    if (command.judgedKey === key) return command.judged
    if (alive && command.judgments >= max.judgmentsPerCommand) return command.judged
    command.busy = true
    try {
      const exitCode = command.done?.exitCode ?? null, failed = command.done?.failed === true
      const errorExit = failed || (Number.isInteger(exitCode) && exitCode !== 0)
      const spent = run.requests >= max.requestsPerRun
      const mode = spent ? 'off' : judgeMode(), egress = gateOf(runKey)
      let captured = null, judged
      // Settled by the runtime's own facts, without a question: no output is retained (Claude never hands the bridge any),
      // or a clean exit whose output carries no failure mark.
      if (!alive && (!output || (!errorExit && !FAILURE_MARK.test(output)))) judged = { state: errorExit ? 'completed_error' : 'completed_ok', source: 'runtime', requests: 0 }
      else judged = await judgeTerminalState({ tail, alive, exitCode, failed, quietMs, mode, client: decision?.client ?? null, egress, egressKind: 'command_output',
        timeoutMs: max.deadlineMs, limits: { tailLines: 30, tailChars: 2400, lineChars: 200, quietMs: max.quietMs, maxQuietMs: 30_000 }, calibration: { record: raw => { captured = raw } } })
      run.requests += judged.requests
      const state = judged.shadow ?? judged.state
      const would = wouldOf(stateResponse(state, { agentOwned: false })) // nothing can be typed into an engine's command
      const settled = judged.requests > 0 || judged.source === 'rule' || !alive
      let blocks = null
      // The error hand-off, recorded only: which runtime-enumerated blocks of the output would be highlighted.
      if (settled && would === 'repair' && output) {
        const all = enumerateLogBlocks(output)
        const picked = await pickRelevantBlocks({ blocks: all, mode: run.requests >= max.requestsPerRun ? 'off' : mode, client: decision?.client ?? null, egress, egressKind: 'command_output', timeoutMs: max.deadlineMs })
        run.requests += picked.requests
        const ids = (Array.isArray(picked.shadow) && picked.shadow.length ? picked.shadow : picked.blocks.map(block => block.id))
        blocks = { enumerated: all.length, picked: ids, source: Array.isArray(picked.shadow) && picked.shadow.length ? 'decision' : 'runtime', requests: picked.requests }
      }
      const result = Object.freeze({ runKey, itemId, at, check: reason, engine: run.engine, state, source: judged.source, would, acted: false,
        requests: judged.requests + (blocks?.requests ?? 0), ...(judged.fallback ? { fallback: judged.fallback } : {}),
        ...(blocks ? { blocks: Object.freeze({ enumerated: blocks.enumerated, picked: Object.freeze([...blocks.picked]), source: blocks.source }) } : {}) })
      command.judged = result
      if (settled) {
        command.judgedKey = key
        if (alive) command.judgments++
        run.last = result
        trail.push(result)
        while (trail.length > max.trail) trail.shift()
        try {
          decision?.calibrationLog?.record?.({ feature: 'terminal_state', mode: 'advisory', judgments: captured?.judgments ?? [], attached: false,
            ...(captured?.fallback ?? judged.fallback ? { fallback: captured?.fallback ?? judged.fallback } : {}),
            ...(blocks ? { candidates: blocks.enumerated, judgedTotal: blocks.picked.length } : {}),
            terminal: { state, source: judged.source, would, acted: false, check: reason, stream: 'engine', engine: run.engine,
              ...(blocks ? { picked: blocks.picked.map(id => Number(String(id).slice(1))).filter(Number.isSafeInteger) } : {}) } })
        } catch { /* recording never changes behaviour */ }
      }
      return result
    } catch { return null } finally { command.busy = false }
  }
  function launch(runKey, itemId, reason) {
    const job = check(runKey, itemId, reason).catch(() => null)
    jobs.add(job)
    void job.finally(() => jobs.delete(job))
    return job
  }

  return Object.freeze({
    /** item/started for a commandExecution item. Nothing of the command text is kept. */
    started({ runKey, itemId, engine = null } = {}) {
      try { if (on() && idOf(runKey) && idOf(itemId)) commandOf(runOf(runKey, engine), itemId) } catch { /* never affects the run */ }
    },
    /** An output delta arrived for the command (the text itself stays in the run's output store). */
    output({ runKey, itemId } = {}) {
      try {
        if (!on() || !idOf(runKey) || !idOf(itemId)) return
        const command = commandOf(runOf(runKey), itemId)
        if (command.done) return
        command.lastOutputAt = monotonicNow(); command.rev++
        arm(runKey, command)
      } catch { /* ignore */ }
    },
    /** item/completed: exit code when the engine reports one, else only whether it failed. A declined command never ran. */
    completed({ runKey, itemId, exitCode = null, status = null, engine = null } = {}) {
      try {
        if (!on() || !idOf(runKey) || !idOf(itemId)) return
        const run = runOf(runKey, engine), command = commandOf(run, itemId)
        if (command.done) return
        disarm(command)
        if (status === 'declined') { run.commands.delete(itemId); return }
        const code = Number.isInteger(exitCode) ? exitCode : null
        command.done = { exitCode: code, failed: status === 'failed' || (code !== null && code !== 0), at: monotonicNow() }
        command.rev++
        run.done++
        if (command.done.failed) run.failed++
        launch(runKey, itemId, 'exit')
      } catch { /* ignore */ }
    },
    /** A heartbeat beat: check the commands of this run that are still running. */
    beat(runKey) {
      try {
        if (!on()) return
        const run = runs.get(runKey)
        if (run) for (const command of run.commands.values()) if (!command.done) launch(runKey, command.itemId, 'beat')
      } catch { /* ignore */ }
    },
    /**
     * Read-only command facts of a run in the one terminal fact-row shape (terminalFactRow), plus counts. Numbers, booleans
     * and closed labels only: no command, no output. null when the run has run no command (or the flag is off).
     */
    facts(runKey) {
      if (!on()) return null
      const run = runs.get(runKey)
      if (!run || (!run.commands.size && !run.done)) return null
      const now = monotonicNow()
      const running = [...run.commands.values()].filter(command => !command.done)
      const current = running.at(-1) ?? null
      const judged = current ? current.judged && current.judgedKey ? current.judged : null : run.last
      const lastDone = [...run.commands.values()].filter(command => command.done).at(-1) ?? null
      return Object.freeze({ ...terminalFactRow({ kind: 'engine', running: Boolean(current), state: judged?.state ?? null, source: judged?.source ?? null, would: judged?.would ?? null,
        runningMs: current ? now - current.startedAt : null, quietMs: current ? now - (current.lastOutputAt ?? current.startedAt) : null, exitCode: current ? null : lastDone?.done.exitCode ?? null }),
        commandsRunning: running.length, commandsDone: run.done, commandsFailed: run.failed })
    },
    forget(runKey) { drop(runKey) },
    close() { for (const key of [...runs.keys()]) drop(key); trail.length = 0 },
    /** Content-free trail of settled checks (most recent last). `blocks.picked` are runtime block ids (b1…), never text. */
    advisories: () => trail.slice(),
    idle: () => Promise.allSettled([...jobs]),
    snapshot: () => ({ runs: runs.size, commands: [...runs.values()].reduce((sum, run) => sum + run.commands.size, 0) }),
  })
}
