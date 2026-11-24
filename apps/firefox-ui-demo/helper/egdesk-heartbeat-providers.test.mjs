import test from 'node:test'
import assert from 'node:assert/strict'
import { createHeartbeat } from './egdesk-heartbeat.mjs'
import { browserTaskRow, feedBrowserTask, observeTerminalLoop, runTerminalLoopWithHeartbeat } from './egdesk-heartbeat-providers.mjs'
import { createBrowserTaskStore, createDirectBrowserEntry } from './egdesk-browser-task.mjs'
import { runObjectiveLoop } from './egdesk-terminal-judge.mjs'

// The objective loops feed a heartbeat read-only: the real loops run unchanged (same calls, same results) with and without the observer.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function terminalDeps({ states, humanAnswer = deferred() }) {
  const log = []
  let poll = 0
  const deps = {
    assess: async command => { log.push(['assess', command]); return { approval: false, source: 'floor', reasons: [] } },
    judge: async snap => { const state = states[Math.min(poll++, states.length - 1)]; log.push(['judge', snap.alive, state]); return { state, source: 'decision' } },
    pick: async blocks => ({ blocks: blocks.slice(0, 1), source: 'fallback' }),
    runtime: { start: async command => { log.push(['start', command]); return { poll: async () => ({ alive: true, exitCode: null, tail: 'synthetic tail', quietMs: 2000 }), write: async data => { log.push(['write', data]) } } } },
    human: { approve: async () => true, answer: async kind => { log.push(['ask', kind]); return humanAnswer.promise } },
    subjective: async task => { log.push(['subjective', task.task]); return null },
    applyFix: async () => {},
  }
  return { deps, log, humanAnswer }
}

test('terminal loop: observed and unobserved runs give the same result, trace and calls; the heartbeat sees running then waiting on the person', async () => {
  const states = ['running_output', 'running_output', 'waiting_yn_input', 'completed_ok']
  const plain = terminalDeps({ states }); plain.humanAnswer.resolve('y')
  const expected = await runObjectiveLoop({ command: 'npm test', deps: plain.deps })
  const watched = terminalDeps({ states })
  const hb = createHeartbeat({ monotonicNow: () => 0, setTimer: () => ({}), clearTimer() {} }); hb.start()
  const running = runTerminalLoopWithHeartbeat(hb, { command: 'npm test', deps: watched.deps })
  for (let i = 0; i < 20 && !watched.log.some(row => row[0] === 'ask'); i++) await new Promise(r => setTimeout(r, 1))
  const waiting = hb.facts()
  assert.equal(waiting.phase, 'waiting_user')
  assert.deepEqual(waiting.sources.terminal_loop, { active: true, phase: 'waiting_user', waitingOnUser: true, stepsDone: 3, repairs: 0, terminal: 'waiting', terminalState: 'waiting_yn_input' })
  watched.humanAnswer.resolve('y')
  const got = await running
  assert.deepEqual(got, expected); assert.deepEqual(watched.log, plain.log)
  assert.deepEqual(hb.facts().sources, {}, 'unregistered when the loop returns')
  assert.equal(hb.facts().phase, 'thinking')
  assert.ok(!JSON.stringify(waiting).includes('npm test') && !JSON.stringify(waiting).includes('synthetic tail'), 'no command or output in the facts')
})

test('terminal loop observer: gate, running and finished facts; without a heartbeat the loop runs exactly as it does alone', async () => {
  const w = terminalDeps({ states: ['running_output', 'completed_ok'] })
  const watch = observeTerminalLoop(w.deps)
  assert.deepEqual(watch.facts(), { active: true, phase: 'objective_step', waitingOnUser: false, stepsDone: 0, repairs: 0, terminal: 'gate' })
  const handle = await watch.deps.runtime.start('ls'); await watch.deps.judge(await handle.poll())
  assert.deepEqual(watch.facts(), { active: true, phase: 'objective_step', waitingOnUser: false, stepsDone: 1, repairs: 0, terminal: 'running', terminalState: 'running_output' })
  watch.finish(); assert.equal(watch.facts(), null)
  assert.deepEqual(await runTerminalLoopWithHeartbeat(null, { command: 'ls', deps: terminalDeps({ states: ['completed_ok'] }).deps }),
    await runObjectiveLoop({ command: 'ls', deps: terminalDeps({ states: ['completed_ok'] }).deps }))
})

function browserWorld(store) {
  const calls = []
  const gate = deferred()
  const segments = [
    { outcome: 'max_steps', steps: [{ actions: [{ ok: true, tool: 'egdesk_browser_scroll' }] }, { actions: [] }, { actions: [] }], state: { at: 1 } },
    { outcome: 'needs_user_context', steps: [{ actions: [] }], candidates: [] },
  ]
  const client = { async decide(request) {
    const q = request.questions[0], value = q.choices[0].value
    return { answers: { [q.name]: { type: 'choice', choice: value, confidence: 0.95, probabilities: [{ value, probability: 0.96 }, { value: q.choices[1].value, probability: 0.02 }] } }, usage: null }
  } }
  const provider = { directEntryEnabled: () => true,
    reflexScope: () => ({ client, authorizeDispatch: () => true, isDecisionCurrent: () => true }),
    async runDirectTask(run, args) { calls.push([args.cardId, args.maxSteps, args.callId.replace(/^bt_[0-9a-f]+/, 'bt')]); if (calls.length === 2) await gate.promise; return segments[calls.length - 1] } }
  const entry = createDirectBrowserEntry({ provider, store })
  const run = { runId: 'pre-1', browserBinding: { cards: [{ cardId: 'card', permission: 'interact' }] } }
  return { entry, run, calls, gate }
}

test('browser task loop: feeding a heartbeat changes nothing; it sees the step count while the loop runs and the hand-off when it pauses (one provider: the store facts)', async () => {
  const plain = browserWorld(createBrowserTaskStore()); plain.gate.resolve()
  const expected = await plain.entry.handle({ run: plain.run, conversationKey: 'dm', message: '세금계산서 내려받아줘', hosts: { card: 'portal.example.test' } })
  const hb = createHeartbeat({ monotonicNow: () => 0, setTimer: () => ({}), clearTimer() {} }); hb.start()
  const real = createBrowserTaskStore()
  const feed = feedBrowserTask(hb, real, 'dm')
  assert.equal(feed.store, real, 'the store is used as is; nothing wraps it')
  const w = browserWorld(feed.store)
  const pending = w.entry.handle({ run: w.run, conversationKey: 'dm', message: '세금계산서 내려받아줘', hosts: { card: 'portal.example.test' } })
  for (let i = 0; i < 20 && w.calls.length < 2; i++) await new Promise(r => setTimeout(r, 1))
  const during = hb.facts()
  assert.deepEqual([during.phase, during.stepsDone], ['objective_step', 3])
  assert.deepEqual(during.sources.browser_task, { active: true, phase: 'objective_step', waitingOnUser: false, stepsDone: 3, stepsRemaining: 21, task: 'running', awaiting: null, awaitingCode: null, lastActionAgeMs: null, idleMs: during.sources.browser_task.idleMs })
  assert.equal(during.stepsRemaining, 21, 'the heartbeat understands the remaining step budget')
  w.gate.resolve()
  const got = await pending
  const strip = out => ({ ...out, taskId: 'bt', note: String(out.note).replace(/bt_[0-9a-f]+/g, 'bt') })
  assert.deepEqual(strip(got), strip(expected)); assert.deepEqual(w.calls, plain.calls)
  assert.equal(got.status, 'paused'); assert.equal(feed.store.size, real.size)
  const after = hb.facts()
  // Paused inside a live heartbeat = handed off to the subjective model, which is still wording the question: the person is not awaited yet.
  assert.equal(after.phase, 'thinking')
  assert.deepEqual(after.sources.browser_task, { active: true, phase: 'handing_off', waitingOnUser: false, stepsDone: 4, stepsRemaining: 20, task: 'handing_off', awaiting: 'need_context', awaitingCode: 'choice_needed', lastActionAgeMs: null, idleMs: after.sources.browser_task.idleMs })
  assert.deepEqual([real.facts('dm').waitingOnUser, real.facts('dm').phase], [true, 'waiting_user'], 'the task itself does wait for the person; only the heartbeat row is about the live turn')
  assert.ok(!JSON.stringify([during, after]).includes('세금') && !JSON.stringify([during, after]).includes('portal'), 'no goal, host or page text in the facts')
  assert.equal(browserTaskRow({ status: 'done', active: false, stepsDone: 2 }), null); assert.equal(browserTaskRow(null), null)
  assert.equal(feedBrowserTask(hb, real, 'other-dm').facts(), null, 'another conversation has no task')
  feed.unregister(); assert.deepEqual(hb.facts().sources, {})
})
