import { TERMINAL_STATE_NAMES, runObjectiveLoop, terminalFactRow } from './egdesk-terminal-judge.mjs'

// Read-only fact providers that let the objective loops feed a heartbeat (egdesk-heartbeat.mjs). They observe; they never
// change what a loop does, decides or returns: every wrapped call passes its arguments and its result through untouched, and an
// observer that throws is ignored. Facts are numbers, booleans and closed labels (the heartbeat drops anything else).

// ---- Browser task loop (egdesk-browser-task.mjs) ----

/**
 * The ONE browser-task fact provider: the task store's own read-only facts() (egdesk-browser-task.mjs), reduced to what a heartbeat
 * takes (numbers, booleans, closed labels; no task id, no nested counts). Null unless a task of the conversation is running or paused.
 *
 * A heartbeat lives from the moment the person's message is accepted until that turn ends. Inside that window a PAUSED task means
 * the loop has handed off and the subjective model is still wording the question: the person has not been asked yet. So the row says
 * phase 'handing_off' and waitingOnUser false (the heartbeat stays able to speak if that turn is slow), and names what is being
 * handed off in `awaiting`. By the time the person really is awaited the turn, and with it the heartbeat, has ended.
 */
export function browserTaskRow(facts) {
  if (!facts || facts.active !== true) return null
  const paused = facts.status === 'paused'
  return { active: true, phase: paused ? 'handing_off' : 'objective_step', waitingOnUser: false, stepsDone: facts.stepsDone, stepsRemaining: facts.stepsRemaining,
    task: paused ? 'handing_off' : 'running', awaiting: paused ? facts.waitingKind : null, awaitingCode: paused ? facts.waitingCode : null,
    lastActionAgeMs: facts.lastActionAgeMs, idleMs: facts.idleMs }
}

/**
 * Registers the browser task of a conversation with a heartbeat (read-only; the store is used as is, nothing wraps it).
 * conversationKey defaults to the heartbeat's own key (the runtime keys both by the local chat id).
 * Returns { store, unregister, facts }: `store` is the same object that was passed in.
 */
export function feedBrowserTask(heartbeat, store, conversationKey = null) {
  const key = conversationKey ?? heartbeat?.snapshot?.().key ?? null
  const facts = () => { try { return browserTaskRow(typeof key === 'string' && key ? store.facts(key) : null) } catch { return null } }
  const unregister = heartbeat ? heartbeat.register('browser_task', facts) : () => {}
  return { store, unregister, facts }
}

// ---- Terminal objective loop (egdesk-terminal-judge.mjs) ----

/** deps that behave exactly like `deps` while recording where the loop is. Returns { deps, facts() }. */
export function observeTerminalLoop(deps) {
  const seen = { started: false, polls: 0, state: null, waiting: false, repairs: 0, done: false }
  const safe = fn => { try { fn() } catch { /* observing never changes the loop */ } }
  const human = deps.human ? {
    ...deps.human,
    approve: async args => { safe(() => { seen.waiting = true }); try { return await deps.human.approve(args) } finally { seen.waiting = false } },
    answer: async kind => { safe(() => { seen.waiting = true }); try { return await deps.human.answer(kind) } finally { seen.waiting = false } },
  } : deps.human
  const observed = {
    ...deps, human,
    judge: async snap => { const judged = await deps.judge(snap); safe(() => { seen.polls++; seen.state = TERMINAL_STATE_NAMES.includes(judged?.state) ? judged.state : null }); return judged },
    runtime: { ...deps.runtime, start: async command => { const handle = await deps.runtime.start(command); safe(() => { seen.started = true }); return handle } },
    applyFix: async fix => { const out = await deps.applyFix(fix); safe(() => { seen.repairs++ }); return out },
  }
  const facts = () => {
    if (seen.done) return null
    // The one terminal fact-row shape (terminalFactRow), shared with the engine-command and Terminal-card facts; this loop adds its own counts.
    const { active, phase, waitingOnUser, terminal, terminalState } = terminalFactRow({ kind: 'objective', running: true, started: seen.started, asking: seen.waiting, state: seen.state })
    return { active, phase, waitingOnUser, stepsDone: seen.polls, repairs: seen.repairs, terminal, ...(terminalState ? { terminalState } : {}) }
  }
  return { deps: observed, facts, finish() { seen.done = true } }
}

/** runObjectiveLoop with its progress fed to a heartbeat. Same arguments, same result. */
export async function runTerminalLoopWithHeartbeat(heartbeat, args) {
  const watch = observeTerminalLoop(args.deps)
  const unregister = heartbeat ? heartbeat.register('terminal_loop', watch.facts) : () => {}
  try { return await runObjectiveLoop({ ...args, deps: watch.deps }) } finally { watch.finish(); unregister() }
}
