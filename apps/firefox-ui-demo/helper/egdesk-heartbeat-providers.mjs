import { MAX_TASK_STEPS } from './egdesk-browser-task.mjs'
import { TERMINAL_STATE_NAMES, runObjectiveLoop } from './egdesk-terminal-judge.mjs'

// Read-only fact providers that let the objective loops feed a heartbeat (egdesk-heartbeat.mjs). They observe; they never
// change what a loop does, decides or returns: every wrapped call passes its arguments and its result through untouched, and an
// observer that throws is ignored. Facts are numbers, booleans and closed labels (the heartbeat drops anything else).

// ---- Browser task loop (egdesk-browser-task.mjs) ----

/** A store that behaves exactly like `store` and tells `onTask` which task object is live for a conversation (create / paused lookups). */
export function observeBrowserTaskStore(store, onTask) {
  const tell = task => { try { if (task) onTask(task) } catch { /* observing never changes the task */ } return task }
  return {
    create: args => tell(store.create(args)),
    paused: conversationKey => tell(store.paused(conversationKey)),
    touch: task => store.touch(task),
    get: taskId => store.get(taskId),
    get size() { return store.size },
  }
}

/** Facts of one browser task object (the loop mutates it; this only reads). */
export function browserTaskFacts(task) {
  if (!task || (task.status !== 'running' && task.status !== 'paused')) return null
  const steps = Number.isSafeInteger(task.steps) ? task.steps : 0
  const paused = task.status === 'paused'
  return { active: true, phase: paused ? 'waiting_user' : 'objective_step', waitingOnUser: paused, stepsDone: steps, stepBudgetLeft: Math.max(0, MAX_TASK_STEPS - steps),
    task: paused ? (task.pause?.kind === 'need_context' ? 'need_context' : 'cannot_proceed') : 'running' }
}

/** Registers the browser task of a conversation with a heartbeat. Returns { store, unregister }: pass `store` to createDirectBrowserEntry. */
export function feedBrowserTask(heartbeat, store) {
  let current = null
  const observed = observeBrowserTaskStore(store, task => { current = task })
  const unregister = heartbeat ? heartbeat.register('browser_task', () => browserTaskFacts(current)) : () => {}
  return { store: observed, unregister, facts: () => browserTaskFacts(current) }
}

// ---- Terminal objective loop (egdesk-terminal-judge.mjs) ----

const WAITING_STATES = new Set(['waiting_yn_input', 'waiting_password', 'need_user_context'])

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
    const waiting = seen.waiting || WAITING_STATES.has(seen.state)
    return { active: true, phase: waiting ? 'waiting_user' : 'objective_step', waitingOnUser: waiting, stepsDone: seen.polls, repairs: seen.repairs,
      terminal: !seen.started ? 'gate' : waiting ? 'waiting' : 'running', ...(seen.state ? { terminalState: seen.state } : {}) }
  }
  return { deps: observed, facts, finish() { seen.done = true } }
}

/** runObjectiveLoop with its progress fed to a heartbeat. Same arguments, same result. */
export async function runTerminalLoopWithHeartbeat(heartbeat, args) {
  const watch = observeTerminalLoop(args.deps)
  const unregister = heartbeat ? heartbeat.register('terminal_loop', watch.facts) : () => {}
  try { return await runObjectiveLoop({ ...args, deps: watch.deps }) } finally { watch.finish(); unregister() }
}
