// The real runner of EG-Desk's command tool against a FAKE spawn and fake timers: no process is ever started here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { COMMAND_ENV_FIXED, COMMAND_ENV_INHERITED, commandEnvironment, createCommandRunner } from './egdesk-command-runner.mjs'
import { createCommandExecutorProvider, COMMAND_TOOL_NAME } from './egdesk-command-executor.mjs'
import { createGateHookBroker } from './egdesk-gate-hook-broker.mjs'
import { RunOutputStore } from './codex-run-outputs.mjs'

const BRIDGE_ENV = { PATH: '/usr/bin:/bin', HOME: '/home/synthetic', USER: 'synthetic', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/synthetic',
  OPENAI_API_KEY: 'sk-synthetic', GITHUB_TOKEN: 'ghp_synthetic', CODEX_HOME: '/home/synthetic/.codex', EGDESK_GATE_HOOK_TOKEN: 'synthetic-hook-token-0123456789',
  SSH_AUTH_SOCK: '/tmp/agent.sock', AWS_SECRET_ACCESS_KEY: 'synthetic', HTTPS_PROXY: 'http://proxy.example.test', NODE_OPTIONS: '--require=/tmp/x.js', BASH_ENV: '/tmp/x.sh' }
function fakes() {
  const spawned = [], timers = []
  let clock = 0
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    Object.assign(child, { pid: 4242, file, args, options, stdout: new PassThrough(), stderr: new PassThrough(), killed: [] })
    child.kill = sig => { child.killed.push(sig); return true }
    spawned.push(child)
    return child
  }
  const setTimer = (fn, ms) => { const t = { at: clock + ms, fn, done: false }; timers.push(t); return t }
  const clearTimer = t => { if (t) t.done = true }
  const advance = ms => { clock += ms; for (const t of timers.filter(t => !t.done && t.at <= clock).sort((a, b) => a.at - b.at)) { t.done = true; t.fn() } }
  return { spawn, spawned, setTimer, clearTimer, advance, now: () => clock }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('environment allowlist: only named variables, from scratch; no keys, tokens, proxies, engine or hook settings, preload hooks', () => {
  const env = commandEnvironment(BRIDGE_ENV)
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'NO_COLOR', 'PAGER', 'PATH', 'TERM', 'TMPDIR', 'USER'].sort())
  for (const name of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'CODEX_HOME', 'EGDESK_GATE_HOOK_TOKEN', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'BASH_ENV']) assert.equal(env[name], undefined, name)
  assert.deepEqual(COMMAND_ENV_INHERITED, ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'])
  assert.equal(COMMAND_ENV_FIXED.GIT_TERMINAL_PROMPT, '0')
})

test('spawn: /bin/sh -c (not a login shell), the run folder, its own process group; output kept head+tail and streamed to the output store', async () => {
  const f = fakes()
  const store = new RunOutputStore()
  const runner = createCommandRunner({ spawn: f.spawn, env: BRIDGE_ENV, setTimer: f.setTimer, clearTimer: f.clearTimer, now: f.now, limits: { headBytes: 8, tailBytes: 8 } })
  const facts = []
  const done = runner({ command: 'npm test', cwd: '/work/demo-app', itemId: 'egdesk-cmd:1', onFacts: row => facts.push(row),
    output: { append: (id, text) => store.appendCommandOutput('conv/T', id, text), complete: id => store.completeCommand('conv/T', id) } })
  const [child] = f.spawned
  assert.deepEqual([child.file, child.args, child.options.cwd, child.options.detached, child.options.stdio], ['/bin/sh', ['-c', 'npm test'], '/work/demo-app', true, ['ignore', 'pipe', 'pipe']])
  assert.deepEqual(child.options.env, commandEnvironment(BRIDGE_ENV))
  child.stdout.write('0123456789abcdefghijklmnopqrstuvwxyz'); child.stderr.write('warn\n')
  await tick()
  f.advance(1500)
  child.emit('close', 0, null)
  const result = await done
  assert.deepEqual([result.exitCode, result.timedOut, result.durationMs, result.truncated], [0, false, 1500, true])
  assert.equal(result.stdout, '01234567\n…\nstuvwxyz'); assert.equal(result.stderr, 'warn\n')
  const kept = store.commandOutput('conv/T', 'egdesk-cmd:1')
  assert.deepEqual([kept.totalBytes, kept.complete], [36 + 5, true], 'stdout and stderr both went to the run output store (it keeps its own head/tail)')
  assert.deepEqual(facts, [{ running: true, runningMs: 0 }, { running: false, runningMs: 1500, exitCode: 0 }])
})

test('timeouts: a soft notice, then the hard limit sends SIGTERM to the group and SIGKILL after the grace period', async () => {
  const f = fakes()
  const groups = []
  const runner = createCommandRunner({ spawn: f.spawn, env: BRIDGE_ENV, setTimer: f.setTimer, clearTimer: f.clearTimer, now: f.now,
    killGroup: (child, sig) => groups.push([child.pid, sig]), limits: { softNoticeMs: 1000, killGraceMs: 500 } })
  const facts = []
  const done = runner({ command: 'sleep 999', cwd: '/work/demo-app', timeoutMs: 3000, onFacts: row => facts.push(row) })
  f.advance(1000)
  assert.deepEqual(facts.at(-1), { running: true, runningMs: 1000, softNotice: true })
  f.advance(2000)
  assert.deepEqual(groups, [[4242, 'SIGTERM']])
  f.advance(500)
  assert.deepEqual(groups, [[4242, 'SIGTERM'], [4242, 'SIGKILL']])
  f.spawned[0].emit('close', null, 'SIGKILL')
  const result = await done
  assert.deepEqual([result.timedOut, result.softNotice, result.exitCode, result.signal, result.durationMs], [true, true, null, 'SIGKILL', 3500])
  // a command that ends before the soft notice gets none, and its timers are cleared
  const g = fakes()
  const quick = createCommandRunner({ spawn: g.spawn, env: BRIDGE_ENV, setTimer: g.setTimer, clearTimer: g.clearTimer, now: g.now })
  const r = quick({ command: 'true', cwd: '/w' })
  g.spawned[0].emit('close', 0, null)
  assert.equal((await r).softNotice, false)
  g.advance(10 * 60_000)
  assert.deepEqual(g.spawned[0].killed, [], 'no kill after it ended')
})

test('the executor with the real runner: facts carry exit code and duration; a risky command never reaches spawn', async () => {
  const f = fakes()
  const runner = createCommandRunner({ spawn: f.spawn, env: BRIDGE_ENV, setTimer: f.setTimer, clearTimer: f.clearTimer, now: f.now })
  const rows = []
  const ledger = createGateHookBroker({ mode: () => 'on', home: '/home/synthetic', assess: async () => ({ approval: false, reasons: [], source: 'decision' }) })
  const provider = createCommandExecutorProvider({ mode: () => 'on', ledger, workspaceOf: () => '/work/demo-app', runner, onFacts: (run, row) => rows.push(row) })
  ledger.turnStarted({ conversationId: 'c', turnId: 'T' })
  const run = { conversationId: 'c', runId: 'T', answerId: 'c/T' }
  const pending = provider.dispatch(run, { callId: 'k1', tool: COMMAND_TOOL_NAME, arguments: { command: 'npm test' } })
  for (let i = 0; i < 20 && !f.spawned.length; i++) await tick()
  f.advance(2200); f.spawned[0].stdout.write('ok\n'); await tick(); f.spawned[0].emit('close', 1, null)
  const out = JSON.parse((await pending).contentItems[0].text)
  assert.deepEqual([out.status, out.exitCode, out.durationMs, out.stdout], ['ran', 1, 2200, 'ok\n'])
  assert.deepEqual(rows.at(-1), { active: false, waitingOnUser: false, terminal: 'idle', runningMs: null, quietMs: null, exitCode: 1, durationMs: 2200 })
  const before = f.spawned.length
  const risky = JSON.parse((await provider.dispatch(run, { callId: 'k2', tool: COMMAND_TOOL_NAME, arguments: { command: 'git reset --hard HEAD~5' } })).contentItems[0].text)
  assert.equal(risky.status, 'needs_person'); assert.equal(f.spawned.length, before)
})

test('c19: the ssh agent reaches only a command the person approved one-time', async () => {
  assert.equal(commandEnvironment(BRIDGE_ENV).SSH_AUTH_SOCK, undefined)
  assert.equal(commandEnvironment(BRIDGE_ENV, { approved: true }).SSH_AUTH_SOCK, '/tmp/agent.sock')
  assert.equal(commandEnvironment(BRIDGE_ENV, { approved: true }).GITHUB_TOKEN, undefined, 'nothing else is added by an approval')
  const f = fakes()
  const runner = createCommandRunner({ spawn: f.spawn, env: BRIDGE_ENV, setTimer: f.setTimer, clearTimer: f.clearTimer, now: f.now })
  const replyClient = (runs, declines) => ({ decide: async () => ({ answers: { reply_runs_command: { type: 'predicate', probability: runs }, reply_declines_command: { type: 'predicate', probability: declines } } }) })
  const ledger = createGateHookBroker({ mode: () => 'on', home: '/home/synthetic', assess: async () => ({ approval: false, reasons: [], source: 'decision' }) })
  const provider = createCommandExecutorProvider({ mode: () => 'on', ledger, workspaceOf: () => '/work/demo-app', runner })
  const call = async (run, id, command) => {
    const pending = provider.dispatch(run, { callId: id, tool: COMMAND_TOOL_NAME, arguments: { command } })
    for (let i = 0; i < 20; i++) await tick()
    const child = f.spawned.find(c => c.args[1] === command && !c.closed)
    if (child) { child.closed = true; child.emit('close', 0, null) }
    return JSON.parse((await pending).contentItems[0].text)
  }
  ledger.turnStarted({ conversationId: 'c', turnId: 'T1' })
  await call({ conversationId: 'c', runId: 'T1', answerId: 'c/T1' }, 'k1', 'git status')
  assert.equal((await call({ conversationId: 'c', runId: 'T1', answerId: 'c/T1' }, 'k2', 'git push --force origin main')).status, 'needs_person')
  ledger.turnEnded({ turnId: 'T1' })
  await ledger.readReply({ conversationId: 'c', reply: 'yes', client: replyClient(0.97, 0.01), egress: { allows: () => true } })
  ledger.turnStarted({ conversationId: 'c', turnId: 'T2' })
  assert.equal((await call({ conversationId: 'c', runId: 'T2', answerId: 'c/T2' }, 'k3', 'git push --force origin main')).status, 'ran')
  assert.deepEqual(f.spawned.map(c => [c.args[1], c.options.env.SSH_AUTH_SOCK ?? null]), [['git status', null], ['git push --force origin main', '/tmp/agent.sock']])
})
